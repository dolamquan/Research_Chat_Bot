"""Unified notes store.

One `notes` table replaces the split between PDF `annotations` (SQLite) and
workspace notes (browser localStorage). A note can reference a PDF page, a
chat session, a cluster, or nothing at all, and carries the Notion sync state
needed for idempotent exports. Legacy `annotations` rows are copied in once at
init, keyed by their original ids so the migration is re-runnable.
"""

import base64
import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from app.auth.context import UNSET, resolve_owner
from app.storage import ownership
from app.storage.ownership import ensure_owner_column, owner_clause
from app.storage import db

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "researchmind.sqlite3"

DEFAULT_FOLDER_ID = "default"

NOTE_TYPES = {"freeform", "highlight", "chat_capture", "visualization"}
SOURCE_TYPES = {"", "pdf", "chat_session", "cluster", "scope", "url", "visualization"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect():
    return db.connect(DB_PATH, init_db)


def init_db(connection: db.Connection | None = None) -> None:
    if connection is None:
        with db.connect(DB_PATH) as conn:
            init_db(conn)
        return
    conn = connection

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS notes (
            note_id TEXT PRIMARY KEY,
            note_type TEXT NOT NULL DEFAULT 'freeform',
            source_type TEXT NOT NULL DEFAULT '',
            source_ref TEXT NOT NULL DEFAULT '',
            source_title TEXT NOT NULL DEFAULT '',
            article_id TEXT NOT NULL DEFAULT '',
            page INTEGER,
            selected_text TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            body_md TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            folder_id TEXT NOT NULL DEFAULT 'default',
            sketch_json TEXT NOT NULL DEFAULT '',
            notion_page_id TEXT NOT NULL DEFAULT '',
            notion_page_url TEXT NOT NULL DEFAULT '',
            notion_database_id TEXT NOT NULL DEFAULT '',
            notion_synced_at TEXT NOT NULL DEFAULT '',
            synced_content_hash TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_notes_source_updated
        ON notes(source_ref, updated_at)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_notes_type_updated
        ON notes(note_type, updated_at)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS note_folders (
            folder_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS note_attachments (
            attachment_id TEXT PRIMARY KEY,
            note_id TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'image',
            name TEXT NOT NULL DEFAULT '',
            mime_type TEXT NOT NULL DEFAULT 'image/png',
            data BLOB NOT NULL,
            scene_json TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_note_attachments_note
        ON note_attachments(note_id, created_at)
        """
    )
    columns = db.table_columns(conn, "note_attachments")
    for column in ("client_id", "content_hash"):
        if column not in columns:
            conn.execute(f"ALTER TABLE note_attachments ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_client
                    ON note_attachments(note_id, client_id) WHERE client_id != ''""")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS notion_targets (
            target_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            database_id TEXT NOT NULL,
            title_property TEXT NOT NULL DEFAULT '',
            schema_json TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    # Notes, folders and Notion targets are personal. NULL owner rows predate
    # accounts and are adopted by the administrator on sign-in.
    for table in ("notes", "note_folders", "notion_targets"):
        ensure_owner_column(conn, table)
    # Folders nest: '' is the top level. Kept as text so the legacy flat list
    # needs no rewrite.
    folder_columns = db.table_columns(conn, "note_folders")
    if "parent_id" not in folder_columns:
        conn.execute("ALTER TABLE note_folders ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''")
    conn.commit()

    _migrate_legacy_annotations(conn)



def _migrate_legacy_annotations(conn: db.Connection) -> None:
    """Copy old `annotations` rows into `notes`, keyed by annotation_id."""
    if "annotations" not in db.table_names(conn):
        return

    conn.execute(
        """
        INSERT INTO notes (
            note_id, note_type, source_type, source_ref, source_title,
            article_id, page, selected_text, title, body_md,
            created_at, updated_at
        )
        SELECT
            annotation_id, 'highlight', 'pdf', source, COALESCE(title, ''),
            COALESCE(article_id, ''), page, selected_text, COALESCE(title, ''),
            note, created_at, updated_at
        FROM annotations
        WHERE true
        ON CONFLICT DO NOTHING
        """
    )
    conn.commit()


def _parse_json(raw: str, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


def _row_to_note(row: db.Row) -> Dict[str, Any]:
    note = dict(row)
    note["tags"] = _parse_json(note.get("tags", "[]"), [])
    note["sketch"] = _parse_json(note.pop("sketch_json", ""), None)
    return note


def note_content_hash(note: Dict[str, Any], attachment_ids: List[str]) -> str:
    """Stable hash of the exportable content, used to detect edits since sync."""
    sketch = note.get("sketch") or {}
    elements = (
        [item for item in sketch.get("elements", []) if not item.get("isDeleted")]
        if isinstance(sketch, dict) else []
    )
    content = {
        "title": note.get("title", ""),
        "body_md": note.get("body_md", ""),
        "selected_text": note.get("selected_text", ""),
        "tags": note.get("tags", []),
        "source_ref": note.get("source_ref", ""),
        "attachments": sorted(attachment_ids),
    }
    if elements:
        content["sketch"] = [
            elements,
            (sketch.get("appState") or {}).get("viewBackgroundColor") or "#ffffff",
            sketch.get("files") or {},
        ]
    payload = json.dumps(
        content,
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _attach_meta(conn: db.Connection, note_ids: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    if not note_ids:
        return {}
    placeholders = ",".join("?" for _ in note_ids)
    rows = conn.execute(
        f"""
        SELECT attachment_id, note_id, kind, name, mime_type,
               scene_json != '' AS has_scene, created_at, client_id, content_hash
        FROM note_attachments
        WHERE note_id IN ({placeholders})
        ORDER BY created_at DESC
        """,
        note_ids,
    ).fetchall()

    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        item = dict(row)
        item["has_scene"] = bool(item["has_scene"])
        grouped.setdefault(item.pop("note_id"), []).append(item)
    return grouped


def _decorate(conn: db.Connection, rows: List[db.Row]) -> List[Dict[str, Any]]:
    notes = [_row_to_note(row) for row in rows]
    attachments = _attach_meta(conn, [note["note_id"] for note in notes])
    for note in notes:
        note["attachments"] = attachments.get(note["note_id"], [])
        current_hash = note_content_hash(
            note, [item["attachment_id"] + item["content_hash"] for item in note["attachments"]]
        )
        note["content_hash"] = current_hash
        note["notion_dirty"] = bool(
            note["notion_page_id"] and note["synced_content_hash"] != current_hash
        )
    return notes


def create_note(
    *,
    note_id: str = "",
    note_type: str = "freeform",
    source_type: str = "",
    source_ref: str = "",
    source_title: str = "",
    article_id: str = "",
    page: int | None = None,
    selected_text: str = "",
    title: str = "",
    body_md: str = "",
    tags: List[str] | None = None,
    folder_id: str = DEFAULT_FOLDER_ID,
    sketch: Any = None,
    created_at: str = "",
    updated_at: str = "",
    owner_id: Any = UNSET,
) -> Dict[str, Any]:
    if note_type not in NOTE_TYPES:
        raise ValueError(f"Invalid note_type: {note_type}")

    resolved_id = note_id or uuid.uuid4().hex
    timestamp = _now()
    owner = resolve_owner(owner_id)

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO notes (
                note_id, note_type, source_type, source_ref, source_title,
                article_id, page, selected_text, title, body_md, tags,
                folder_id, sketch_json, created_at, updated_at, owner_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                resolved_id,
                note_type,
                source_type,
                source_ref,
                source_title,
                article_id,
                page,
                selected_text,
                title,
                body_md,
                json.dumps(tags or []),
                folder_id or DEFAULT_FOLDER_ID,
                json.dumps(sketch) if sketch is not None else "",
                created_at or timestamp,
                updated_at or timestamp,
                owner,
            ),
        )
        conn.commit()

    return get_note(resolved_id, owner_id=owner)


def _scope(owner: str | None, column: str = "owner_id") -> tuple[str, List[Any]]:
    """` AND owner = ?` for scoped calls, nothing for unscoped ones."""
    sql, params = owner_clause(owner, column=column)
    return (f" AND {sql}" if sql else ""), params


def get_note(note_id: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    scope_sql, scope_params = _scope(resolve_owner(owner_id))
    with _connect() as conn:
        row = conn.execute(
            f"SELECT * FROM notes WHERE note_id = ?{scope_sql}", (note_id, *scope_params)
        ).fetchone()
        if row is None:
            raise ValueError(f"Note not found: {note_id}")
        return _decorate(conn, [row])[0]


def find_note_by_source(note_type: str, source_ref: str, owner_id: Any = UNSET) -> Dict[str, Any] | None:
    """Latest note of a given type for a scope, used for scoped upserts."""
    scope_sql, scope_params = _scope(resolve_owner(owner_id))
    with _connect() as conn:
        row = conn.execute(
            f"""
            SELECT * FROM notes
            WHERE note_type = ? AND source_ref = ?{scope_sql}
            ORDER BY updated_at DESC LIMIT 1
            """,
            (note_type, source_ref, *scope_params),
        ).fetchone()
        if row is None:
            return None
        return _decorate(conn, [row])[0]


def list_notes(
    *,
    note_type: str | None = None,
    source_ref: str | None = None,
    folder_id: str | None = None,
    query: str | None = None,
    limit: int = 200,
    owner_id: Any = UNSET,
) -> List[Dict[str, Any]]:
    clauses = []
    params: List[Any] = []

    scope_sql, scope_params = owner_clause(resolve_owner(owner_id))
    if scope_sql:
        clauses.append(scope_sql)
        params.extend(scope_params)

    if note_type:
        clauses.append("note_type = ?")
        params.append(note_type)
    if source_ref:
        clauses.append("source_ref = ?")
        params.append(source_ref)
    if folder_id and folder_id != DEFAULT_FOLDER_ID:
        clauses.append("folder_id = ?")
        params.append(folder_id)
    if query:
        clauses.append(
            "(title LIKE ? OR body_md LIKE ? OR selected_text LIKE ? OR source_title LIKE ?)"
        )
        needle = f"%{query}%"
        params.extend([needle, needle, needle, needle])

    where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(limit)

    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM notes
            {where_clause}
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
        return _decorate(conn, rows)


_UPDATABLE_FIELDS = {
    "title",
    "body_md",
    "selected_text",
    "source_title",
    "page",
    "folder_id",
    "note_type",
    "source_type",
    "source_ref",
    "article_id",
}


def update_note(note_id: str, owner_id: Any = UNSET, **fields: Any) -> Dict[str, Any]:
    owner = resolve_owner(owner_id)
    scope_sql, scope_params = _scope(owner)
    assignments = []
    params: List[Any] = []

    for key, value in fields.items():
        if value is None:
            continue
        if key == "tags":
            assignments.append("tags = ?")
            params.append(json.dumps(value))
        elif key == "sketch":
            assignments.append("sketch_json = ?")
            params.append(json.dumps(value) if value else "")
        elif key in _UPDATABLE_FIELDS:
            assignments.append(f"{key} = ?")
            params.append(value)
        else:
            raise ValueError(f"Cannot update field: {key}")

    if not assignments:
        return get_note(note_id, owner_id=owner)

    assignments.append("updated_at = ?")
    params.append(_now())
    params.append(note_id)
    params.extend(scope_params)

    with _connect() as conn:
        cursor = conn.execute(
            f"UPDATE notes SET {', '.join(assignments)} WHERE note_id = ?{scope_sql}",
            params,
        )
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Note not found: {note_id}")
    return get_note(note_id, owner_id=owner)


def delete_note(note_id: str, owner_id: Any = UNSET) -> None:
    scope_sql, scope_params = _scope(resolve_owner(owner_id))
    with _connect() as conn:
        cursor = conn.execute(
            f"DELETE FROM notes WHERE note_id = ?{scope_sql}", (note_id, *scope_params)
        )
        if cursor.rowcount:
            conn.execute("DELETE FROM note_attachments WHERE note_id = ?", (note_id,))
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Note not found: {note_id}")


def mark_note_synced(
    note_id: str,
    *,
    notion_page_id: str,
    notion_page_url: str,
    notion_database_id: str,
    content_hash: str,
) -> Dict[str, Any]:
    with _connect() as conn:
        cursor = conn.execute(
            """
            UPDATE notes
            SET notion_page_id = ?, notion_page_url = ?, notion_database_id = ?,
                notion_synced_at = ?, synced_content_hash = ?
            WHERE note_id = ?
            """,
            (
                notion_page_id,
                notion_page_url,
                notion_database_id,
                _now(),
                content_hash,
                note_id,
            ),
        )
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Note not found: {note_id}")
    return get_note(note_id)


# --- attachments --------------------------------------------------------------


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
    if not data_url.startswith("data:"):
        raise ValueError("Attachment data must be a data: URL")
    header, _, encoded = data_url.partition(",")
    mime = header[5:].split(";")[0] or "image/png"
    return base64.b64decode(encoded), mime


def add_attachment(
    *,
    note_id: str,
    kind: str = "image",
    name: str = "",
    data_url: str,
    scene: Any = None,
    client_id: str = "",
) -> Dict[str, Any]:
    get_note(note_id)  # Raises when the note does not exist.
    data, mime = _decode_data_url(data_url)
    attachment_id = uuid.uuid4().hex
    timestamp = _now()
    scene_json = json.dumps(scene, sort_keys=True) if scene is not None else ""
    content_hash = hashlib.sha256(data + json.dumps(
        [kind, name, mime, scene_json], ensure_ascii=False,
    ).encode("utf-8")).hexdigest()

    with _connect() as conn:
        # A retry or reopened browser must not create a second copy. Adopt an
        # identical legacy upload on its first save with a client identifier.
        conn.execute("BEGIN IMMEDIATE")
        existing = None
        if client_id:
            existing = conn.execute(
                "SELECT * FROM note_attachments WHERE note_id = ? AND client_id = ?",
                (note_id, client_id),
            ).fetchone()
            if existing is None:
                existing = conn.execute(
                    """SELECT * FROM note_attachments WHERE note_id = ? AND client_id = ''
                       AND kind = ? AND name = ? AND mime_type = ? AND data = ? LIMIT 1""",
                    (note_id, kind, name, mime, data),
                ).fetchone()
        if existing is not None:
            attachment_id = existing["attachment_id"]
            timestamp = existing["created_at"]
        conn.execute(
            """
            INSERT INTO note_attachments (
                attachment_id, note_id, kind, name, mime_type, data,
                scene_json, created_at, client_id, content_hash
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(attachment_id) DO UPDATE SET
                kind = excluded.kind, name = excluded.name, mime_type = excluded.mime_type,
                data = excluded.data, scene_json = excluded.scene_json,
                client_id = excluded.client_id, content_hash = excluded.content_hash
            """,
            (
                attachment_id,
                note_id,
                kind,
                name,
                mime,
                data,
                scene_json,
                timestamp,
                client_id,
                content_hash,
            ),
        )
        conn.execute(
            "UPDATE notes SET updated_at = ? WHERE note_id = ?",
            (_now(), note_id),
        )
        conn.commit()

    return {
        "attachment_id": attachment_id,
        "kind": kind,
        "name": name,
        "mime_type": mime,
        "has_scene": scene is not None,
        "created_at": timestamp,
        "client_id": client_id,
        "content_hash": content_hash,
    }


def get_attachment(attachment_id: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    owner = resolve_owner(owner_id)
    with _connect() as conn:
        if owner is None:
            # Unscoped reads must still find attachments whose note row is
            # missing (legacy databases mid-migration).
            row = conn.execute(
                "SELECT * FROM note_attachments WHERE attachment_id = ?",
                (attachment_id,),
            ).fetchone()
        else:
            # Attachments inherit their note's owner.
            row = conn.execute(
                """
                SELECT a.* FROM note_attachments a
                JOIN notes n ON n.note_id = a.note_id
                WHERE a.attachment_id = ? AND n.owner_id = ?
                """,
                (attachment_id, owner),
            ).fetchone()

    if row is None:
        raise ValueError(f"Attachment not found: {attachment_id}")

    attachment = dict(row)
    attachment["scene"] = _parse_json(attachment.pop("scene_json", ""), None)
    return attachment


def list_attachment_blobs(note_id: str) -> List[Dict[str, Any]]:
    """Full attachment rows (bytes included) for a note, oldest first."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM note_attachments
            WHERE note_id = ?
            ORDER BY created_at ASC
            """,
            (note_id,),
        ).fetchall()

    attachments = []
    for row in rows:
        attachment = dict(row)
        attachment["scene"] = _parse_json(attachment.pop("scene_json", ""), None)
        attachments.append(attachment)
    return attachments


def delete_attachment(attachment_id: str, owner_id: Any = UNSET) -> None:
    owner = resolve_owner(owner_id)
    with _connect() as conn:
        if owner is None:
            cursor = conn.execute(
                "DELETE FROM note_attachments WHERE attachment_id = ?",
                (attachment_id,),
            )
        else:
            cursor = conn.execute(
                """
                DELETE FROM note_attachments
                WHERE attachment_id = ?
                  AND note_id IN (SELECT note_id FROM notes WHERE owner_id = ?)
                """,
                (attachment_id, owner),
            )
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Attachment not found: {attachment_id}")


# --- folders ------------------------------------------------------------------


def _folder_row(row: db.Row) -> Dict[str, Any]:
    folder = dict(row)
    folder["parent_id"] = folder.get("parent_id") or ""
    return folder


def _root_folder() -> Dict[str, Any]:
    return {
        "folder_id": DEFAULT_FOLDER_ID,
        "name": "All notes",
        "parent_id": "",
        "created_at": "",
        "updated_at": "",
    }


def _normalize_parent(parent_id: Any) -> str:
    """The root is spelled '' in storage; the UI's default folder id means the same."""
    if parent_id in (None, "", DEFAULT_FOLDER_ID):
        return ""
    return str(parent_id)


def _folder_exists(conn: db.Connection, folder_id: str, owner: str | None) -> bool:
    scope_sql, scope_params = _scope(owner)
    return conn.execute(
        f"SELECT 1 FROM note_folders WHERE folder_id = ?{scope_sql}", (folder_id, *scope_params)
    ).fetchone() is not None


def _descendant_ids(conn: db.Connection, folder_id: str, owner: str | None) -> set[str]:
    scope_sql, scope_params = _scope(owner)
    found: set[str] = set()
    frontier = [folder_id]
    while frontier:
        rows = conn.execute(
            f"SELECT folder_id FROM note_folders WHERE parent_id IN ({','.join('?' * len(frontier))}){scope_sql}",
            (*frontier, *scope_params),
        ).fetchall()
        frontier = [row["folder_id"] for row in rows if row["folder_id"] not in found]
        found.update(frontier)
    return found


def list_folders(owner_id: Any = UNSET) -> List[Dict[str, Any]]:
    scope_sql, scope_params = owner_clause(resolve_owner(owner_id))
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM note_folders {f'WHERE {scope_sql}' if scope_sql else ''} ORDER BY name COLLATE NOCASE",
            scope_params,
        ).fetchall()

    return [
        _root_folder(),
        *[_folder_row(row) for row in rows if row["folder_id"] != DEFAULT_FOLDER_ID],
    ]


def create_folder(
    name: str,
    *,
    folder_id: str = "",
    parent_id: Any = "",
    owner_id: Any = UNSET,
) -> Dict[str, Any]:
    trimmed = name.strip()
    if not trimmed:
        raise ValueError("Folder name is required")

    resolved_id = folder_id or uuid.uuid4().hex
    parent = _normalize_parent(parent_id)
    timestamp = _now()
    owner = resolve_owner(owner_id)

    with _connect() as conn:
        if parent and not _folder_exists(conn, parent, owner):
            raise ValueError(f"Parent folder not found: {parent}")
        conn.execute(
            """
            INSERT INTO note_folders (folder_id, name, created_at, updated_at, owner_id, parent_id)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
            """,
            (resolved_id, trimmed, timestamp, timestamp, owner, parent),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM note_folders WHERE folder_id = ?", (resolved_id,)
        ).fetchone()

    return _folder_row(row)


def update_folder(
    folder_id: str,
    *,
    name: str | None = None,
    parent_id: Any = None,
    owner_id: Any = UNSET,
) -> Dict[str, Any]:
    """Rename and/or move a folder. Moving into itself or a descendant is refused."""
    if folder_id == DEFAULT_FOLDER_ID:
        raise ValueError("The default folder cannot be changed")
    owner = resolve_owner(owner_id)
    scope_sql, scope_params = _scope(owner)
    assignments: List[str] = []
    params: List[Any] = []

    with _connect() as conn:
        row = conn.execute(
            f"SELECT * FROM note_folders WHERE folder_id = ?{scope_sql}", (folder_id, *scope_params)
        ).fetchone()
        if row is None:
            raise ValueError(f"Folder not found: {folder_id}")

        if name is not None:
            trimmed = name.strip()
            if not trimmed:
                raise ValueError("Folder name is required")
            assignments.append("name = ?")
            params.append(trimmed)

        if parent_id is not None:
            parent = _normalize_parent(parent_id)
            if parent == folder_id or parent in _descendant_ids(conn, folder_id, owner):
                raise ValueError("A folder cannot be moved into itself or one of its subfolders")
            if parent and not _folder_exists(conn, parent, owner):
                raise ValueError(f"Parent folder not found: {parent}")
            assignments.append("parent_id = ?")
            params.append(parent)

        if not assignments:
            return _folder_row(row)

        assignments.append("updated_at = ?")
        params.append(_now())
        conn.execute(
            f"UPDATE note_folders SET {', '.join(assignments)} WHERE folder_id = ?",
            (*params, folder_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM note_folders WHERE folder_id = ?", (folder_id,)
        ).fetchone()

    return _folder_row(row)


def rename_folder(folder_id: str, name: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    return update_folder(folder_id, name=name, owner_id=owner_id)


def delete_folder(folder_id: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    """Remove a folder; its notes and subfolders move up to its parent."""
    if folder_id == DEFAULT_FOLDER_ID:
        raise ValueError("The default folder cannot be deleted")
    owner = resolve_owner(owner_id)
    scope_sql, scope_params = _scope(owner)

    with _connect() as conn:
        row = conn.execute(
            f"SELECT * FROM note_folders WHERE folder_id = ?{scope_sql}", (folder_id, *scope_params)
        ).fetchone()
        if row is None:
            raise ValueError(f"Folder not found: {folder_id}")
        parent = _folder_row(row)["parent_id"]

        folders_moved = conn.execute(
            f"UPDATE note_folders SET parent_id = ?, updated_at = ? WHERE parent_id = ?{scope_sql}",
            (parent, _now(), folder_id, *scope_params),
        ).rowcount
        notes_moved = conn.execute(
            f"UPDATE notes SET folder_id = ? WHERE folder_id = ?{scope_sql}",
            (parent or DEFAULT_FOLDER_ID, folder_id, *scope_params),
        ).rowcount
        conn.execute("DELETE FROM note_folders WHERE folder_id = ?", (folder_id,))
        conn.commit()

    return {
        "folder_id": folder_id,
        "parent_id": parent,
        "notes_moved": notes_moved,
        "folders_moved": folders_moved,
    }


def claim_unowned(owner: str) -> Dict[str, int]:
    """Adopt every ownerless note, folder and Notion target. Idempotent."""
    with _connect() as conn:
        counts = {table: ownership.claim_unowned(conn, table, owner) for table in ("notes", "note_folders", "notion_targets")}
        conn.commit()
    return counts


# --- Notion targets -------------------------------------------------------------


def list_notion_targets(owner_id: Any = UNSET) -> List[Dict[str, Any]]:
    scope_sql, scope_params = owner_clause(resolve_owner(owner_id))
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM notion_targets {f'WHERE {scope_sql}' if scope_sql else ''} ORDER BY name COLLATE NOCASE",
            scope_params,
        ).fetchall()

    targets = []
    for row in rows:
        target = dict(row)
        target["schema"] = _parse_json(target.pop("schema_json", ""), {})
        targets.append(target)
    return targets


def get_notion_target(target_id: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    scope_sql, scope_params = _scope(resolve_owner(owner_id))
    with _connect() as conn:
        row = conn.execute(
            f"SELECT * FROM notion_targets WHERE target_id = ?{scope_sql}", (target_id, *scope_params)
        ).fetchone()

    if row is None:
        raise ValueError(f"Notion target not found: {target_id}")

    target = dict(row)
    target["schema"] = _parse_json(target.pop("schema_json", ""), {})
    return target


def save_notion_target(
    *,
    name: str,
    database_id: str,
    title_property: str = "",
    schema: Dict[str, Any] | None = None,
    target_id: str = "",
    owner_id: Any = UNSET,
) -> Dict[str, Any]:
    trimmed_name = name.strip()
    trimmed_db = database_id.strip()
    if not trimmed_name:
        raise ValueError("Target name is required")
    if not trimmed_db:
        raise ValueError("database_id is required")

    timestamp = _now()
    owner = resolve_owner(owner_id)
    scope_sql, scope_params = _scope(owner)

    with _connect() as conn:
        # Two users may point at the same Notion database; each keeps their own target.
        existing = conn.execute(
            f"SELECT target_id FROM notion_targets WHERE database_id = ?{scope_sql}",
            (trimmed_db, *scope_params),
        ).fetchone()
        resolved_id = target_id or (existing["target_id"] if existing else uuid.uuid4().hex)

        conn.execute(
            """
            INSERT INTO notion_targets (
                target_id, name, database_id, title_property, schema_json,
                created_at, updated_at, owner_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(target_id) DO UPDATE SET
                name = excluded.name,
                database_id = excluded.database_id,
                title_property = excluded.title_property,
                schema_json = excluded.schema_json,
                updated_at = excluded.updated_at
            """,
            (
                resolved_id,
                trimmed_name,
                trimmed_db,
                title_property,
                json.dumps(schema or {}),
                timestamp,
                timestamp,
                owner,
            ),
        )
        conn.commit()

    return get_notion_target(resolved_id, owner_id=owner)


def delete_notion_target(target_id: str, owner_id: Any = UNSET) -> None:
    scope_sql, scope_params = _scope(resolve_owner(owner_id))
    with _connect() as conn:
        cursor = conn.execute(
            f"DELETE FROM notion_targets WHERE target_id = ?{scope_sql}", (target_id, *scope_params)
        )
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Notion target not found: {target_id}")

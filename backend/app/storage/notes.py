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
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "researchmind.sqlite3"

DEFAULT_FOLDER_ID = "default"

NOTE_TYPES = {"freeform", "highlight", "chat_capture", "visualization"}
SOURCE_TYPES = {"", "pdf", "chat_session", "cluster", "scope", "url", "visualization"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    init_db(connection)
    return connection


def init_db(connection: sqlite3.Connection | None = None) -> None:
    owns_connection = connection is None
    conn = connection or sqlite3.connect(DB_PATH)

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
    conn.commit()

    _migrate_legacy_annotations(conn)

    if owns_connection:
        conn.close()


def _migrate_legacy_annotations(conn: sqlite3.Connection) -> None:
    """Copy old `annotations` rows into `notes`, keyed by annotation_id."""
    tables = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    if "annotations" not in tables:
        return

    conn.execute(
        """
        INSERT OR IGNORE INTO notes (
            note_id, note_type, source_type, source_ref, source_title,
            article_id, page, selected_text, title, body_md,
            created_at, updated_at
        )
        SELECT
            annotation_id, 'highlight', 'pdf', source, COALESCE(title, ''),
            COALESCE(article_id, ''), page, selected_text, COALESCE(title, ''),
            note, created_at, updated_at
        FROM annotations
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


def _row_to_note(row: sqlite3.Row) -> Dict[str, Any]:
    note = dict(row)
    note["tags"] = _parse_json(note.get("tags", "[]"), [])
    note["sketch"] = _parse_json(note.pop("sketch_json", ""), None)
    return note


def note_content_hash(note: Dict[str, Any], attachment_ids: List[str]) -> str:
    """Stable hash of the exportable content, used to detect edits since sync."""
    payload = json.dumps(
        {
            "title": note.get("title", ""),
            "body_md": note.get("body_md", ""),
            "selected_text": note.get("selected_text", ""),
            "tags": note.get("tags", []),
            "source_ref": note.get("source_ref", ""),
            "attachments": sorted(attachment_ids),
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _attach_meta(conn: sqlite3.Connection, note_ids: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    if not note_ids:
        return {}
    placeholders = ",".join("?" for _ in note_ids)
    rows = conn.execute(
        f"""
        SELECT attachment_id, note_id, kind, name, mime_type,
               scene_json != '' AS has_scene, created_at
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


def _decorate(conn: sqlite3.Connection, rows: List[sqlite3.Row]) -> List[Dict[str, Any]]:
    notes = [_row_to_note(row) for row in rows]
    attachments = _attach_meta(conn, [note["note_id"] for note in notes])
    for note in notes:
        note["attachments"] = attachments.get(note["note_id"], [])
        current_hash = note_content_hash(
            note, [item["attachment_id"] for item in note["attachments"]]
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
) -> Dict[str, Any]:
    if note_type not in NOTE_TYPES:
        raise ValueError(f"Invalid note_type: {note_type}")

    resolved_id = note_id or uuid.uuid4().hex
    timestamp = _now()

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO notes (
                note_id, note_type, source_type, source_ref, source_title,
                article_id, page, selected_text, title, body_md, tags,
                folder_id, sketch_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            ),
        )
        conn.commit()

    return get_note(resolved_id)


def get_note(note_id: str) -> Dict[str, Any]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM notes WHERE note_id = ?", (note_id,)
        ).fetchone()
        if row is None:
            raise ValueError(f"Note not found: {note_id}")
        return _decorate(conn, [row])[0]


def find_note_by_source(note_type: str, source_ref: str) -> Dict[str, Any] | None:
    """Latest note of a given type for a scope, used for scoped upserts."""
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT * FROM notes
            WHERE note_type = ? AND source_ref = ?
            ORDER BY updated_at DESC LIMIT 1
            """,
            (note_type, source_ref),
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
) -> List[Dict[str, Any]]:
    clauses = []
    params: List[Any] = []

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


def update_note(note_id: str, **fields: Any) -> Dict[str, Any]:
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
        return get_note(note_id)

    assignments.append("updated_at = ?")
    params.append(_now())
    params.append(note_id)

    with _connect() as conn:
        cursor = conn.execute(
            f"UPDATE notes SET {', '.join(assignments)} WHERE note_id = ?",
            params,
        )
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Note not found: {note_id}")
    return get_note(note_id)


def delete_note(note_id: str) -> None:
    with _connect() as conn:
        cursor = conn.execute("DELETE FROM notes WHERE note_id = ?", (note_id,))
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
) -> Dict[str, Any]:
    get_note(note_id)  # Raises when the note does not exist.
    data, mime = _decode_data_url(data_url)
    attachment_id = uuid.uuid4().hex
    timestamp = _now()

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO note_attachments (
                attachment_id, note_id, kind, name, mime_type, data,
                scene_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                attachment_id,
                note_id,
                kind,
                name,
                mime,
                data,
                json.dumps(scene) if scene is not None else "",
                timestamp,
            ),
        )
        conn.execute(
            "UPDATE notes SET updated_at = ? WHERE note_id = ?",
            (timestamp, note_id),
        )
        conn.commit()

    return {
        "attachment_id": attachment_id,
        "kind": kind,
        "name": name,
        "mime_type": mime,
        "has_scene": scene is not None,
        "created_at": timestamp,
    }


def get_attachment(attachment_id: str) -> Dict[str, Any]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM note_attachments WHERE attachment_id = ?",
            (attachment_id,),
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


def delete_attachment(attachment_id: str) -> None:
    with _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM note_attachments WHERE attachment_id = ?",
            (attachment_id,),
        )
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Attachment not found: {attachment_id}")


# --- folders ------------------------------------------------------------------


def list_folders() -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM note_folders ORDER BY name COLLATE NOCASE"
        ).fetchall()

    return [
        {
            "folder_id": DEFAULT_FOLDER_ID,
            "name": "All notes",
            "created_at": "",
            "updated_at": "",
        },
        *[dict(row) for row in rows if row["folder_id"] != DEFAULT_FOLDER_ID],
    ]


def create_folder(name: str, *, folder_id: str = "") -> Dict[str, Any]:
    trimmed = name.strip()
    if not trimmed:
        raise ValueError("Folder name is required")

    resolved_id = folder_id or uuid.uuid4().hex
    timestamp = _now()

    with _connect() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO note_folders (folder_id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (resolved_id, trimmed, timestamp, timestamp),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM note_folders WHERE folder_id = ?", (resolved_id,)
        ).fetchone()

    return dict(row)


def rename_folder(folder_id: str, name: str) -> Dict[str, Any]:
    trimmed = name.strip()
    if not trimmed:
        raise ValueError("Folder name is required")

    with _connect() as conn:
        cursor = conn.execute(
            "UPDATE note_folders SET name = ?, updated_at = ? WHERE folder_id = ?",
            (trimmed, _now(), folder_id),
        )
        conn.commit()
        if cursor.rowcount == 0:
            raise ValueError(f"Folder not found: {folder_id}")
        row = conn.execute(
            "SELECT * FROM note_folders WHERE folder_id = ?", (folder_id,)
        ).fetchone()

    return dict(row)


def delete_folder(folder_id: str) -> None:
    if folder_id == DEFAULT_FOLDER_ID:
        raise ValueError("The default folder cannot be deleted")

    with _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM note_folders WHERE folder_id = ?", (folder_id,)
        )
        conn.execute(
            "UPDATE notes SET folder_id = ? WHERE folder_id = ?",
            (DEFAULT_FOLDER_ID, folder_id),
        )
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Folder not found: {folder_id}")


# --- Notion targets -------------------------------------------------------------


def list_notion_targets() -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM notion_targets ORDER BY name COLLATE NOCASE"
        ).fetchall()

    targets = []
    for row in rows:
        target = dict(row)
        target["schema"] = _parse_json(target.pop("schema_json", ""), {})
        targets.append(target)
    return targets


def get_notion_target(target_id: str) -> Dict[str, Any]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM notion_targets WHERE target_id = ?", (target_id,)
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
) -> Dict[str, Any]:
    trimmed_name = name.strip()
    trimmed_db = database_id.strip()
    if not trimmed_name:
        raise ValueError("Target name is required")
    if not trimmed_db:
        raise ValueError("database_id is required")

    timestamp = _now()

    with _connect() as conn:
        existing = conn.execute(
            "SELECT target_id FROM notion_targets WHERE database_id = ?",
            (trimmed_db,),
        ).fetchone()
        resolved_id = target_id or (existing["target_id"] if existing else uuid.uuid4().hex)

        conn.execute(
            """
            INSERT INTO notion_targets (
                target_id, name, database_id, title_property, schema_json,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
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
            ),
        )
        conn.commit()

    return get_notion_target(resolved_id)


def delete_notion_target(target_id: str) -> None:
    with _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM notion_targets WHERE target_id = ?", (target_id,)
        )
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Notion target not found: {target_id}")

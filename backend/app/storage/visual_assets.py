import hashlib
import mimetypes
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "researchmind.sqlite3"
VISUAL_ASSET_BLOB_PREFIX = "db://visual-assets/"


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
        CREATE TABLE IF NOT EXISTS visual_assets (
            asset_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            article_id TEXT,
            title TEXT,
            page INTEGER,
            image_path TEXT NOT NULL,
            image_url TEXT NOT NULL,
            caption TEXT NOT NULL,
            asset_type TEXT NOT NULL DEFAULT 'pdf_image',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_visual_assets_source
        ON visual_assets(source, page)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS visual_asset_blobs (
            filename TEXT PRIMARY KEY,
            mime_type TEXT NOT NULL,
            content BLOB NOT NULL,
            byte_size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.commit()

    if owns_connection:
        conn.close()


def create_visual_asset(
    *,
    source: str,
    image_path: str,
    image_url: str,
    caption: str,
    image_bytes: bytes | None = None,
    mime_type: str | None = None,
    page: int | None = None,
    article_id: str = "",
    title: str = "",
    asset_type: str = "pdf_image",
) -> Dict[str, Any]:
    asset_id = uuid.uuid4().hex
    timestamp = _now()
    filename = _filename_from_url_or_path(image_url=image_url, image_path=image_path)
    stored_image_path = f"{VISUAL_ASSET_BLOB_PREFIX}{filename}" if image_bytes is not None else image_path

    with _connect() as conn:
        if image_bytes is not None:
            upsert_visual_asset_blob(
                filename=filename,
                content=image_bytes,
                mime_type=mime_type or mimetypes.guess_type(filename)[0] or "image/png",
                conn=conn,
            )
        conn.execute(
            """
            INSERT INTO visual_assets (
                asset_id, source, article_id, title, page, image_path, image_url,
                caption, asset_type, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                asset_id,
                source,
                article_id,
                title,
                page,
                stored_image_path,
                image_url,
                caption,
                asset_type,
                timestamp,
                timestamp,
            ),
        )
        conn.commit()

    return get_visual_asset(asset_id)


def get_visual_asset(asset_id: str) -> Dict[str, Any]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM visual_assets WHERE asset_id = ?",
            (asset_id,),
        ).fetchone()

    if row is None:
        raise ValueError(f"Visual asset not found: {asset_id}")

    return dict(row)


def list_visual_assets(
    *,
    source: str | None = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    clauses = []
    params: List[Any] = []

    if source:
        clauses.append("source = ?")
        params.append(source)

    where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(limit)

    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM visual_assets
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            params,
        ).fetchall()

    return [dict(row) for row in rows]


def _filename_from_url_or_path(*, image_url: str = "", image_path: str = "") -> str:
    value = image_url.rsplit("/", 2)[-2] if image_url.endswith("/image") else image_url
    filename = Path(value or image_path).name
    if not filename:
        raise ValueError("Visual asset filename is required.")
    return filename


def _filename_from_ref(value: str) -> str:
    if value.startswith(VISUAL_ASSET_BLOB_PREFIX):
        return value.removeprefix(VISUAL_ASSET_BLOB_PREFIX)
    return Path(value).name


def upsert_visual_asset_blob(
    *,
    filename: str,
    content: bytes,
    mime_type: str,
    conn: sqlite3.Connection | None = None,
) -> None:
    if not content:
        raise ValueError("Visual asset image content is empty.")

    timestamp = _now()
    sha256 = hashlib.sha256(content).hexdigest()
    owns_connection = conn is None
    connection = conn or _connect()

    connection.execute(
        """
        INSERT INTO visual_asset_blobs (
            filename, mime_type, content, byte_size, sha256, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(filename) DO UPDATE SET
            mime_type = excluded.mime_type,
            content = excluded.content,
            byte_size = excluded.byte_size,
            sha256 = excluded.sha256,
            updated_at = excluded.updated_at
        """,
        (
            filename,
            mime_type,
            sqlite3.Binary(content),
            len(content),
            sha256,
            timestamp,
            timestamp,
        ),
    )

    if owns_connection:
        connection.commit()
        connection.close()


def get_visual_asset_blob(filename: str) -> Dict[str, Any] | None:
    safe_name = Path(filename).name
    if safe_name != filename:
        return None

    with _connect() as conn:
        row = conn.execute(
            """
            SELECT filename, mime_type, content, byte_size, sha256, created_at, updated_at
            FROM visual_asset_blobs
            WHERE filename = ?
            """,
            (safe_name,),
        ).fetchone()

    return dict(row) if row else None


def get_visual_asset_blob_by_ref(image_ref: str) -> Dict[str, Any] | None:
    filename = _filename_from_ref(image_ref)
    if not filename:
        return None
    return get_visual_asset_blob(filename)


def migrate_visual_asset_files_to_db(
    *,
    visual_asset_dir: Path,
    delete_files: bool = False,
) -> Dict[str, int]:
    """
    Move legacy visual asset files into SQLite blob storage.

    Metadata rows keep their image_url, while image_path is rewritten to a db://
    reference so older retrieval payloads can still resolve by filename.
    """
    visual_asset_dir.mkdir(parents=True, exist_ok=True)
    migrated = 0
    missing = 0
    deleted = 0

    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT asset_id, image_path, image_url
            FROM visual_assets
            WHERE asset_type IN ('pdf_image', 'pdf_region')
            """
        ).fetchall()

        for row in rows:
            filename = _filename_from_url_or_path(
                image_url=str(row["image_url"] or ""),
                image_path=str(row["image_path"] or ""),
            )
            image_path = Path(str(row["image_path"] or ""))
            if not image_path.exists():
                image_path = visual_asset_dir / filename

            if not image_path.exists():
                existing_blob = conn.execute(
                    "SELECT filename FROM visual_asset_blobs WHERE filename = ?",
                    (filename,),
                ).fetchone()
                if existing_blob is None:
                    missing += 1
                else:
                    conn.execute(
                        """
                        UPDATE visual_assets
                        SET image_path = ?, updated_at = ?
                        WHERE asset_id = ?
                        """,
                        (
                            f"{VISUAL_ASSET_BLOB_PREFIX}{filename}",
                            _now(),
                            row["asset_id"],
                        ),
                    )
                continue

            content = image_path.read_bytes()
            upsert_visual_asset_blob(
                filename=filename,
                content=content,
                mime_type=mimetypes.guess_type(filename)[0] or "image/png",
                conn=conn,
            )
            conn.execute(
                """
                UPDATE visual_assets
                SET image_path = ?, updated_at = ?
                WHERE asset_id = ?
                """,
                (
                    f"{VISUAL_ASSET_BLOB_PREFIX}{filename}",
                    _now(),
                    row["asset_id"],
                ),
            )
            migrated += 1

            if delete_files and image_path.resolve().parent == visual_asset_dir.resolve():
                image_path.unlink()
                deleted += 1

        conn.commit()

    return {
        "migrated": migrated,
        "missing": missing,
        "deleted": deleted,
    }

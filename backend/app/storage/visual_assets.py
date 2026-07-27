import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "researchmind.sqlite3"


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
    conn.commit()

    if owns_connection:
        conn.close()


def create_visual_asset(
    *,
    source: str,
    image_path: str,
    image_url: str,
    caption: str,
    page: int | None = None,
    article_id: str = "",
    title: str = "",
    asset_type: str = "pdf_image",
) -> Dict[str, Any]:
    asset_id = uuid.uuid4().hex
    timestamp = _now()

    with _connect() as conn:
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
                image_path,
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

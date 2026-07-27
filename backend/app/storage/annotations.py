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
        CREATE TABLE IF NOT EXISTS annotations (
            annotation_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            article_id TEXT,
            title TEXT,
            page INTEGER NOT NULL,
            selected_text TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_annotations_source_updated_at
        ON annotations(source, updated_at)
        """
    )
    conn.commit()

    if owns_connection:
        conn.close()


def _row_to_annotation(row: sqlite3.Row) -> Dict[str, Any]:
    return dict(row)


def create_annotation(
    *,
    source: str,
    page: int,
    selected_text: str,
    note: str = "",
    article_id: str = "",
    title: str = "",
) -> Dict[str, Any]:
    annotation_id = uuid.uuid4().hex
    timestamp = _now()

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO annotations (
                annotation_id, source, article_id, title, page, selected_text,
                note, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                annotation_id,
                source,
                article_id,
                title,
                page,
                selected_text,
                note,
                timestamp,
                timestamp,
            ),
        )
        conn.commit()

    return get_annotation(annotation_id)


def get_annotation(annotation_id: str) -> Dict[str, Any]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM annotations WHERE annotation_id = ?",
            (annotation_id,),
        ).fetchone()

    if row is None:
        raise ValueError(f"Annotation not found: {annotation_id}")

    return _row_to_annotation(row)


def list_annotations(
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
            SELECT * FROM annotations
            {where_clause}
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            params,
        ).fetchall()

    return [_row_to_annotation(row) for row in rows]


def delete_annotation(annotation_id: str) -> None:
    with _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM annotations WHERE annotation_id = ?",
            (annotation_id,),
        )
        conn.commit()

    if cursor.rowcount == 0:
        raise ValueError(f"Annotation not found: {annotation_id}")

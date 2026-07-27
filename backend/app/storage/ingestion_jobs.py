import json
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
        CREATE TABLE IF NOT EXISTS ingestion_jobs (
            job_id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            title TEXT,
            domain TEXT NOT NULL DEFAULT 'research',
            category TEXT NOT NULL DEFAULT 'uncategorized',
            tags_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL,
            stage TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            article_id TEXT,
            article_title TEXT,
            source TEXT,
            pdf_url TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_updated_at
        ON ingestion_jobs(updated_at)
        """
    )
    conn.commit()

    if owns_connection:
        conn.close()


def _row_to_job(row: sqlite3.Row) -> Dict[str, Any]:
    job = dict(row)
    try:
        job["tags"] = json.loads(job.pop("tags_json") or "[]")
    except json.JSONDecodeError:
        job["tags"] = []
    return job


def create_ingestion_job(
    url: str,
    title: str | None = None,
    domain: str = "research",
    category: str = "uncategorized",
    tags: List[str] | None = None,
) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex
    timestamp = _now()

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO ingestion_jobs (
                job_id, url, title, domain, category, tags_json, status, stage,
                message, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                url,
                title or "",
                domain,
                category,
                json.dumps(tags or []),
                "queued",
                "queued",
                "Waiting to start ingestion.",
                timestamp,
                timestamp,
            ),
        )
        conn.commit()

    return get_ingestion_job(job_id)


def update_ingestion_job(
    job_id: str,
    *,
    status: str | None = None,
    stage: str | None = None,
    message: str | None = None,
    article_id: str | None = None,
    article_title: str | None = None,
    source: str | None = None,
    pdf_url: str | None = None,
    error: str | None = None,
    completed: bool = False,
) -> Dict[str, Any]:
    updates: List[str] = ["updated_at = ?"]
    params: List[Any] = [_now()]

    values = {
        "status": status,
        "stage": stage,
        "message": message,
        "article_id": article_id,
        "article_title": article_title,
        "source": source,
        "pdf_url": pdf_url,
        "error": error,
    }

    for column, value in values.items():
        if value is not None:
            updates.append(f"{column} = ?")
            params.append(value)

    if completed:
        updates.append("completed_at = ?")
        params.append(_now())

    params.append(job_id)

    with _connect() as conn:
        conn.execute(
            f"UPDATE ingestion_jobs SET {', '.join(updates)} WHERE job_id = ?",
            params,
        )
        conn.commit()

    return get_ingestion_job(job_id)


def get_ingestion_job(job_id: str) -> Dict[str, Any]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM ingestion_jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()

    if row is None:
        raise ValueError(f"Ingestion job not found: {job_id}")

    return _row_to_job(row)


def list_ingestion_jobs(limit: int = 20) -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM ingestion_jobs
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [_row_to_job(row) for row in rows]

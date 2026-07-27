import json
import sqlite3
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
        CREATE TABLE IF NOT EXISTS articles (
            article_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source TEXT NOT NULL,
            url TEXT,
            pdf_url TEXT,
            domain TEXT NOT NULL DEFAULT 'research',
            category TEXT NOT NULL DEFAULT 'uncategorized',
            tags_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'indexed',
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_articles_domain_category
        ON articles(domain, category)
        """
    )
    _ensure_column(conn, "abstract", "TEXT")
    _ensure_column(conn, "authors_json", "TEXT NOT NULL DEFAULT '[]'")
    _ensure_column(conn, "published_at", "TEXT")
    _ensure_column(conn, "updated_at_source", "TEXT")
    conn.commit()

    if owns_connection:
        conn.close()


def _ensure_column(conn: sqlite3.Connection, column_name: str, column_sql: str) -> None:
    columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(articles)").fetchall()
    }
    if column_name not in columns:
        conn.execute(f"ALTER TABLE articles ADD COLUMN {column_name} {column_sql}")


def _row_to_article(row: sqlite3.Row) -> Dict[str, Any]:
    article = dict(row)

    try:
        article["tags"] = json.loads(article.pop("tags_json") or "[]")
    except json.JSONDecodeError:
        article["tags"] = []

    try:
        article["authors"] = json.loads(article.pop("authors_json") or "[]")
    except json.JSONDecodeError:
        article["authors"] = []

    return article


def upsert_article(
    article_id: str,
    title: str,
    source: str,
    url: str = "",
    pdf_url: str = "",
    domain: str = "research",
    category: str = "uncategorized",
    tags: List[str] | None = None,
    abstract: str = "",
    authors: List[str] | None = None,
    published_at: str = "",
    updated_at_source: str = "",
    status: str = "indexed",
    error: str | None = None,
) -> Dict[str, Any]:
    timestamp = _now()
    tags_json = json.dumps(tags or [])
    authors_json = json.dumps(authors or [])

    with _connect() as conn:
        existing = conn.execute(
            "SELECT created_at FROM articles WHERE article_id = ?",
            (article_id,),
        ).fetchone()
        created_at = existing["created_at"] if existing else timestamp

        conn.execute(
            """
            INSERT INTO articles (
                article_id, title, source, url, pdf_url, domain, category,
                tags_json, abstract, authors_json, published_at, updated_at_source,
                status, error, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(article_id) DO UPDATE SET
                title = excluded.title,
                source = excluded.source,
                url = excluded.url,
                pdf_url = excluded.pdf_url,
                domain = excluded.domain,
                category = excluded.category,
                tags_json = excluded.tags_json,
                abstract = excluded.abstract,
                authors_json = excluded.authors_json,
                published_at = excluded.published_at,
                updated_at_source = excluded.updated_at_source,
                status = excluded.status,
                error = excluded.error,
                updated_at = excluded.updated_at
            """,
            (
                article_id,
                title,
                source,
                url,
                pdf_url,
                domain,
                category,
                tags_json,
                abstract,
                authors_json,
                published_at,
                updated_at_source,
                status,
                error,
                created_at,
                timestamp,
            ),
        )
        conn.commit()

    return get_article(article_id)


def get_article(article_id: str) -> Dict[str, Any]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM articles WHERE article_id = ?",
            (article_id,),
        ).fetchone()

    if row is None:
        raise ValueError(f"Article not found: {article_id}")

    return _row_to_article(row)


def list_articles(
    domain: str | None = None,
    category: str | None = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    clauses = []
    params: List[Any] = []

    if domain:
        clauses.append("domain = ?")
        params.append(domain)

    if category:
        clauses.append("category = ?")
        params.append(category)

    where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(limit)

    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM articles
            {where_clause}
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            params,
        ).fetchall()

    return [_row_to_article(row) for row in rows]


def list_domains() -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT domain, category, COUNT(*) AS article_count
            FROM articles
            GROUP BY domain, category
            ORDER BY domain ASC, category ASC
            """
        ).fetchall()

    return [dict(row) for row in rows]

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from app.auth.context import UNSET, resolve_owner
from app.storage.ownership import ensure_owner_column, owner_clause
from app.storage import db


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "researchmind.sqlite3"
ARXIV_MANIFEST_PATH = DATA_DIR / "uploaded_docs" / "arxiv_manifest.json"


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
    # NULL owner means public: every paper indexed before accounts existed is
    # part of the shared library, and an administrator can publish more.
    ensure_owner_column(conn, "articles")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source)")
    conn.commit()



def _ensure_column(conn: db.Connection, column_name: str, column_sql: str) -> None:
    columns = db.table_columns(conn, "articles")
    if column_name not in columns:
        conn.execute(f"ALTER TABLE articles ADD COLUMN {column_name} {column_sql}")


def _row_to_article(row: db.Row) -> Dict[str, Any]:
    article = dict(row)

    try:
        article["tags"] = json.loads(article.pop("tags_json") or "[]")
    except json.JSONDecodeError:
        article["tags"] = []

    try:
        article["authors"] = json.loads(article.pop("authors_json") or "[]")
    except json.JSONDecodeError:
        article["authors"] = []

    article["visibility"] = "public" if article.get("owner_id") is None else "private"
    return article


def _manifest_articles() -> List[Dict[str, Any]]:
    if not ARXIV_MANIFEST_PATH.exists():
        return []

    try:
        manifest = json.loads(ARXIV_MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []

    articles: List[Dict[str, Any]] = []
    for arxiv_id, item in manifest.items():
        if not isinstance(item, dict):
            continue

        filename = str(item.get("filename") or "").strip()
        if not filename:
            continue

        title = str(item.get("title") or "").strip() or filename.replace("_", " ")
        pdf_url = str(item.get("pdf_url") or "").strip()
        articles.append(
            {
                "article_id": f"manifest:{arxiv_id}",
                "title": title,
                "source": filename,
                "url": f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else pdf_url,
                "pdf_url": pdf_url,
                "domain": "research",
                "category": "uncategorized",
                "tags": ["manifest", "arxiv"],
                "status": "indexed",
                "error": None,
                "abstract": "",
                "authors": [],
                "published_at": "",
                "updated_at_source": "",
                "created_at": "",
                "updated_at": "",
                "owner_id": None,
                "visibility": "public",
            }
        )

    return articles


def _article_matches_filters(
    article: Dict[str, Any],
    *,
    domain: str | None = None,
    category: str | None = None,
) -> bool:
    if domain and article.get("domain") != domain:
        return False
    if category and article.get("category") != category:
        return False
    return True


def _visible(article: Dict[str, Any], owner: str | None) -> bool:
    return owner is None or article.get("owner_id") in (None, owner)


def _db_article_sources() -> set[str]:
    with _connect() as conn:
        rows = conn.execute("SELECT source FROM articles").fetchall()
    return {str(row["source"] or "") for row in rows}


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
    owner_id: Any = UNSET,
) -> Dict[str, Any]:
    timestamp = _now()
    tags_json = json.dumps(tags or [])
    authors_json = json.dumps(authors or [])
    owner = resolve_owner(owner_id)

    with _connect() as conn:
        existing = conn.execute(
            "SELECT created_at FROM articles WHERE article_id = ?",
            (article_id,),
        ).fetchone()
        created_at = existing["created_at"] if existing else timestamp

        # Re-indexing never changes who owns a paper; publishing is explicit
        # through set_article_visibility.
        conn.execute(
            """
            INSERT INTO articles (
                article_id, title, source, url, pdf_url, domain, category,
                tags_json, abstract, authors_json, published_at, updated_at_source,
                status, error, created_at, updated_at, owner_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                owner,
            ),
        )
        conn.commit()

    return get_article(article_id, owner_id=None)


def find_articles_by_source(source: str) -> List[Dict[str, Any]]:
    """Every indexed copy of a PDF filename, whoever owns it. Unscoped by design."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM articles WHERE source = ? ORDER BY created_at ASC",
            (source,),
        ).fetchall()
    return [_row_to_article(row) for row in rows]


def get_article(article_id: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    owner = resolve_owner(owner_id)
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM articles WHERE article_id = ?",
            (article_id,),
        ).fetchone()

    if row is not None:
        article = _row_to_article(row)
        if _visible(article, owner):
            return article
        raise ValueError(f"Article not found: {article_id}")

    # Papers from the arXiv manifest have no row in `articles`, but
    # list_articles() surfaces them alongside the indexed ones. Anything that
    # resolves a paper the user can see in a list has to find them here too,
    # otherwise most of the library looks broken.
    for article in _manifest_articles():
        if article.get("article_id") == article_id:
            return article

    raise ValueError(f"Article not found: {article_id}")


def list_articles(
    domain: str | None = None,
    category: str | None = None,
    limit: int = 100,
    owner_id: Any = UNSET,
) -> List[Dict[str, Any]]:
    owner = resolve_owner(owner_id)
    clauses = []
    params: List[Any] = []

    if domain:
        clauses.append("domain = ?")
        params.append(domain)

    if category:
        clauses.append("category = ?")
        params.append(category)

    scope_sql, scope_params = owner_clause(owner, include_public=True)
    if scope_sql:
        clauses.append(scope_sql)
        params.extend(scope_params)

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

    db_articles = [_row_to_article(row) for row in rows]
    seen_sources = {str(article.get("source") or "") for article in db_articles}
    manifest_articles = [
        article
        for article in _manifest_articles()
        if str(article.get("source") or "") not in seen_sources
        and _article_matches_filters(article, domain=domain, category=category)
    ]

    combined = [*db_articles, *manifest_articles]
    return combined if limit < 0 else combined[:limit]


def list_domains(owner_id: Any = UNSET) -> List[Dict[str, Any]]:
    owner = resolve_owner(owner_id)
    scope_sql, scope_params = owner_clause(owner, include_public=True)
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT domain, category, COUNT(*) AS article_count
            FROM articles
            {f'WHERE {scope_sql}' if scope_sql else ''}
            GROUP BY domain, category
            ORDER BY domain ASC, category ASC
            """,
            scope_params,
        ).fetchall()

    counts: Dict[tuple[str, str], int] = {}
    for row in rows:
        key = (str(row["domain"]), str(row["category"]))
        counts[key] = int(row["article_count"])

    db_sources = _db_article_sources()
    for article in _manifest_articles():
        if str(article.get("source") or "") in db_sources:
            continue
        key = (str(article.get("domain") or "research"), str(article.get("category") or "uncategorized"))
        counts[key] = counts.get(key, 0) + 1

    return [
        {
            "domain": domain,
            "category": category,
            "article_count": count,
        }
        for (domain, category), count in sorted(counts.items())
    ]


def can_access_source(source: str, owner_id: Any = UNSET) -> bool:
    """May the current user open this PDF filename? Manifest PDFs are always public."""
    owner = resolve_owner(owner_id)
    if owner is None:
        return True
    if any(str(article.get("source") or "") == source for article in _manifest_articles()):
        return True
    copies = find_articles_by_source(source)
    if not copies:
        # A file with no article row predates ownership tracking: shared library.
        return True
    return any(_visible(article, owner) for article in copies)


def set_article_visibility(article_id: str, *, public: bool, owner_id: str | None = None) -> Dict[str, Any]:
    """Publish a paper to everyone (public=True) or hand it to one owner."""
    new_owner = None if public else owner_id
    if not public and not new_owner:
        raise ValueError("A private paper needs an owner_id")
    with _connect() as conn:
        updated = conn.execute(
            "UPDATE articles SET owner_id = ?, updated_at = ? WHERE article_id = ?",
            (new_owner, _now(), article_id),
        ).rowcount
        conn.commit()
    if updated == 0:
        raise ValueError(f"Article not found: {article_id}")
    return get_article(article_id, owner_id=None)

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from uuid import uuid4

from app.auth.context import UNSET, resolve_owner
from app.storage import ownership
from app.storage.ownership import ensure_owner_column, owner_clause


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "chat_history.sqlite3"


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
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            cluster_id INTEGER,
            document_source TEXT,
            context_mode TEXT NOT NULL DEFAULT 'retrieval',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            sources_json TEXT NOT NULL DEFAULT '[]',
            pinned_sources_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        )
        """
    )
    columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(chat_messages)").fetchall()
    }
    if "pinned_sources_json" not in columns:
        conn.execute(
            """
            ALTER TABLE chat_messages
            ADD COLUMN pinned_sources_json TEXT NOT NULL DEFAULT '[]'
            """
        )
    ensure_owner_column(conn, "chat_sessions")
    conn.commit()

    if owns_connection:
        conn.close()


def _session_title(question: str) -> str:
    title = " ".join(question.strip().split())
    if not title:
        return "New chat"
    if len(title) > 72:
        return f"{title[:69].rstrip()}..."
    return title


def _scope(owner: str | None) -> tuple[str, List[Any]]:
    sql, params = owner_clause(owner)
    return (f" AND {sql}" if sql else ""), params


def create_session(
    title: str | None = None,
    first_question: str = "",
    cluster_id: int | None = None,
    document_source: str | None = None,
    context_mode: str = "retrieval",
    owner_id: Any = UNSET,
) -> Dict[str, Any]:
    session_id = str(uuid4())
    timestamp = _now()
    session_title = title or _session_title(first_question)
    owner = resolve_owner(owner_id)

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO chat_sessions (
                id, title, cluster_id, document_source, context_mode, created_at, updated_at, owner_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                session_title,
                cluster_id,
                document_source,
                context_mode,
                timestamp,
                timestamp,
                owner,
            ),
        )
        conn.commit()

    return get_session_summary(session_id, owner_id=owner)


def get_session_summary(session_id: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    scope_sql, scope_params = _scope(resolve_owner(owner_id))
    with _connect() as conn:
        row = conn.execute(
            f"""
            SELECT id, title, cluster_id, document_source, context_mode, created_at, updated_at
            FROM chat_sessions
            WHERE id = ?{scope_sql}
            """,
            (session_id, *scope_params),
        ).fetchone()

    if row is None:
        raise ValueError(f"Chat session not found: {session_id}")

    return dict(row)


def list_sessions(limit: int = 50, owner_id: Any = UNSET) -> List[Dict[str, Any]]:
    scope_sql, scope_params = owner_clause(resolve_owner(owner_id))
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT id, title, cluster_id, document_source, context_mode, created_at, updated_at
            FROM chat_sessions
            {f'WHERE {scope_sql}' if scope_sql else ''}
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (*scope_params, limit),
        ).fetchall()

    return [dict(row) for row in rows]


def append_message(
    session_id: str,
    role: str,
    content: str,
    sources: List[Dict[str, Any]] | None = None,
    pinned_sources: List[Dict[str, Any]] | None = None,
    owner_id: Any = UNSET,
) -> Dict[str, Any]:
    timestamp = _now()
    sources_json = json.dumps(sources or [])
    pinned_sources_json = json.dumps(pinned_sources or [])
    scope_sql, scope_params = _scope(resolve_owner(owner_id))

    with _connect() as conn:
        # Touching the session first doubles as the ownership check: a session
        # id belonging to someone else updates nothing and gets no message.
        touched = conn.execute(
            f"""
            UPDATE chat_sessions
            SET updated_at = ?
            WHERE id = ?{scope_sql}
            """,
            (timestamp, session_id, *scope_params),
        ).rowcount
        if touched == 0:
            raise ValueError(f"Chat session not found: {session_id}")
        conn.execute(
            """
            INSERT INTO chat_messages (
                session_id, role, content, sources_json, pinned_sources_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                role,
                content,
                sources_json,
                pinned_sources_json,
                timestamp,
            ),
        )
        conn.commit()

    return {
        "role": role,
        "content": content,
        "sources": sources or [],
        "pinned_sources": pinned_sources or [],
        "created_at": timestamp,
    }


def get_session(session_id: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    session = get_session_summary(session_id, owner_id=owner_id)

    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT role, content, sources_json, pinned_sources_json, created_at
            FROM chat_messages
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()

    messages = []
    for row in rows:
        try:
            sources = json.loads(row["sources_json"] or "[]")
        except json.JSONDecodeError:
            sources = []
        try:
            pinned_sources = json.loads(row["pinned_sources_json"] or "[]")
        except (KeyError, json.JSONDecodeError):
            pinned_sources = []

        messages.append(
            {
                "role": row["role"],
                "content": row["content"],
                "sources": sources,
                "pinned_sources": pinned_sources,
                "created_at": row["created_at"],
            }
        )

    return {
        "session": session,
        "messages": messages,
    }


def delete_session(session_id: str, owner_id: Any = UNSET) -> None:
    scope_sql, scope_params = _scope(resolve_owner(owner_id))
    with _connect() as conn:
        deleted = conn.execute(
            f"DELETE FROM chat_sessions WHERE id = ?{scope_sql}",
            (session_id, *scope_params),
        ).rowcount
        conn.commit()

    if deleted == 0:
        raise ValueError(f"Chat session not found: {session_id}")


def claim_unowned(owner: str) -> Dict[str, int]:
    with _connect() as conn:
        count = ownership.claim_unowned(conn, "chat_sessions", owner)
        conn.commit()
    return {"chat_sessions": count}

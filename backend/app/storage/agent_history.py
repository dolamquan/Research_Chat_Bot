import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from uuid import uuid4

from app.auth.context import UNSET, resolve_owner
from app.storage import ownership
from app.storage.ownership import ensure_column, ensure_owner_column, owner_clause

# `kind` separates the Agent tab's sessions ("agent") from the always-present
# assistant's single long-lived session per user ("assistant").
SESSION_COLUMNS = "id, title, kind, cluster_id, document_source, context_mode, created_at, updated_at"


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "agent_history.sqlite3"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    init_db(connection)
    return connection


def init_db(connection: sqlite3.Connection | None = None) -> None:
    owns_connection = connection is None
    conn = connection or sqlite3.connect(DB_PATH)

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_sessions (
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
        CREATE TABLE IF NOT EXISTS agent_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            sources_json TEXT NOT NULL DEFAULT '[]',
            pinned_sources_json TEXT NOT NULL DEFAULT '[]',
            tool_trace_json TEXT NOT NULL DEFAULT '[]',
            intent TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
        )
        """
    )
    ensure_owner_column(conn, "agent_sessions")
    ensure_column(conn, "agent_sessions", "kind", "TEXT NOT NULL DEFAULT 'agent'")
    ensure_column(conn, "agent_messages", "meta_json", "TEXT NOT NULL DEFAULT '{}'")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner_kind ON agent_sessions(owner_id, kind, updated_at)")
    conn.commit()

    if owns_connection:
        conn.close()


def _session_title(question: str) -> str:
    title = " ".join(question.strip().split())
    if not title:
        return "New agent session"
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
    kind: str = "agent",
) -> Dict[str, Any]:
    session_id = str(uuid4())
    timestamp = _now()
    session_title = title or _session_title(first_question)
    owner = resolve_owner(owner_id)

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO agent_sessions (
                id, title, kind, cluster_id, document_source, context_mode, created_at, updated_at, owner_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                session_title,
                kind,
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
            SELECT {SESSION_COLUMNS}
            FROM agent_sessions
            WHERE id = ?{scope_sql}
            """,
            (session_id, *scope_params),
        ).fetchone()

    if row is None:
        raise ValueError(f"Agent session not found: {session_id}")

    return dict(row)


def list_sessions(limit: int = 50, owner_id: Any = UNSET, kind: str | None = "agent") -> List[Dict[str, Any]]:
    """Sessions newest first. `kind=None` lists every kind."""
    clauses, params = [], []
    scope_sql, scope_params = owner_clause(resolve_owner(owner_id))
    if scope_sql:
        clauses.append(scope_sql)
        params.extend(scope_params)
    if kind is not None:
        clauses.append("kind = ?")
        params.append(kind)
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT {SESSION_COLUMNS}
            FROM agent_sessions
            {f'WHERE {" AND ".join(clauses)}' if clauses else ''}
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()

    return [dict(row) for row in rows]


def latest_session(kind: str, owner_id: Any = UNSET) -> Dict[str, Any] | None:
    """The most recently used session of one kind, or None."""
    sessions = list_sessions(limit=1, owner_id=owner_id, kind=kind)
    return sessions[0] if sessions else None


def append_message(
    session_id: str,
    role: str,
    content: str,
    sources: List[Dict[str, Any]] | None = None,
    pinned_sources: List[Dict[str, Any]] | None = None,
    tool_trace: List[Dict[str, Any]] | None = None,
    intent: str | None = None,
    owner_id: Any = UNSET,
    meta: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    timestamp = _now()
    scope_sql, scope_params = _scope(resolve_owner(owner_id))

    with _connect() as conn:
        # Touching the session first doubles as the ownership check: a session
        # id belonging to someone else updates nothing and gets no message.
        touched = conn.execute(
            f"UPDATE agent_sessions SET updated_at = ? WHERE id = ?{scope_sql}",
            (timestamp, session_id, *scope_params),
        ).rowcount
        if touched == 0:
            raise ValueError(f"Agent session not found: {session_id}")
        conn.execute(
            """
            INSERT INTO agent_messages (
                session_id, role, content, sources_json, pinned_sources_json,
                tool_trace_json, intent, created_at, meta_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                role,
                content,
                json.dumps(sources or []),
                json.dumps(pinned_sources or []),
                json.dumps(tool_trace or []),
                intent,
                timestamp,
                json.dumps(meta or {}, default=str),
            ),
        )
        conn.commit()

    return {
        "role": role,
        "content": content,
        "sources": sources or [],
        "pinned_sources": pinned_sources or [],
        "tool_trace": tool_trace or [],
        "intent": intent,
        "created_at": timestamp,
        "meta": meta or {},
    }


def _loads(raw: Any, fallback: Any) -> Any:
    try:
        return json.loads(raw or "")
    except (TypeError, json.JSONDecodeError):
        return fallback


def _message(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "role": row["role"],
        "content": row["content"],
        "sources": _loads(row["sources_json"], []),
        "pinned_sources": _loads(row["pinned_sources_json"], []),
        "tool_trace": _loads(row["tool_trace_json"], []),
        "intent": row["intent"],
        "created_at": row["created_at"],
        "meta": _loads(row["meta_json"], {}) or {},
    }


_MESSAGE_COLUMNS = "role, content, sources_json, pinned_sources_json, tool_trace_json, intent, created_at, meta_json"


def get_session(session_id: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    session = get_session_summary(session_id, owner_id=owner_id)

    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT {_MESSAGE_COLUMNS}
            FROM agent_messages
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()

    return {
        "session": session,
        "messages": [_message(row) for row in rows],
    }


def recent_messages(session_id: str, limit: int = 12, owner_id: Any = UNSET) -> List[Dict[str, Any]]:
    """The last `limit` messages of a session in chronological order.

    A long-lived assistant session should not load its whole history on every
    turn; the ownership check happens through `get_session_summary`.
    """
    get_session_summary(session_id, owner_id=owner_id)
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT {_MESSAGE_COLUMNS}
            FROM agent_messages
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (session_id, max(0, limit)),
        ).fetchall()
    return [_message(row) for row in reversed(rows)]


def delete_session(session_id: str, owner_id: Any = UNSET) -> None:
    scope_sql, scope_params = _scope(resolve_owner(owner_id))
    with _connect() as conn:
        deleted = conn.execute(
            f"DELETE FROM agent_sessions WHERE id = ?{scope_sql}",
            (session_id, *scope_params),
        ).rowcount
        conn.commit()

    if deleted == 0:
        raise ValueError(f"Agent session not found: {session_id}")


def claim_unowned(owner: str) -> Dict[str, int]:
    with _connect() as conn:
        count = ownership.claim_unowned(conn, "agent_sessions", owner)
        conn.commit()
    return {"agent_sessions": count}

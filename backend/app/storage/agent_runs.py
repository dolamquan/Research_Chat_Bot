"""The run buffer: the newest assistant turns, each with its full timeline.

One row per turn written by app.agents.run_log. Only the newest
`MAX_RUNS_PER_OWNER` are kept per user, so the buffer stays small enough to
scan and never grows without bound.
"""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from uuid import uuid4

from app.auth.context import UNSET, resolve_owner
from app.storage import db
from app.storage.ownership import owner_clause

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "agent_runs.sqlite3"
MAX_RUNS_PER_OWNER = 300

SUMMARY_COLUMNS = "id, session_id, turn_id, question, status, total_ms, model_ms, steps, tool_calls, errors, model, created_at, summary_json"


def init_db(connection: db.Connection | None = None) -> None:
    if connection is None:
        with db.connect(DB_PATH) as conn:
            init_db(conn)
        return
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            owner_id TEXT,
            session_id TEXT,
            turn_id TEXT,
            question TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            total_ms INTEGER NOT NULL DEFAULT 0,
            model_ms INTEGER NOT NULL DEFAULT 0,
            steps INTEGER NOT NULL DEFAULT 0,
            tool_calls INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            model TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            summary_json TEXT NOT NULL DEFAULT '{}',
            events_json TEXT NOT NULL DEFAULT '[]'
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS idx_agent_runs_owner_created ON agent_runs(owner_id, created_at)")
    connection.commit()


def _connect():
    return db.connect(DB_PATH, init_db)


def _scope(owner: str | None) -> tuple[str, List[Any]]:
    sql, params = owner_clause(owner)
    return (f" AND {sql}" if sql else ""), params


def save_run(run: Dict[str, Any], owner_id: Any = UNSET) -> str:
    """Store one finished turn and drop the owner's oldest runs beyond the buffer size."""
    owner = resolve_owner(owner_id)
    run_id = str(uuid4())
    events = run.get("events") or []
    summary = {key: value for key, value in run.items() if key != "events"}
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO agent_runs (id, owner_id, session_id, turn_id, question, status, total_ms, model_ms,
                                    steps, tool_calls, errors, model, created_at, summary_json, events_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id, owner, run.get("session_id"), run.get("turn_id"), str(run.get("question") or ""),
                str(run.get("status") or "ok"), int(run.get("total_ms") or 0), int(run.get("model_ms") or 0),
                int(run.get("steps") or 0), int(run.get("tool_calls") or 0), int(run.get("errors") or 0),
                str(run.get("model") or ""), datetime.now(timezone.utc).isoformat(),
                json.dumps(summary, default=str), json.dumps(events, default=str),
            ),
        )
        owner_sql = "owner_id IS NULL" if owner is None else "owner_id = ?"
        owner_params: List[Any] = [] if owner is None else [owner]
        conn.execute(
            f"""
            DELETE FROM agent_runs WHERE {owner_sql} AND id NOT IN (
                SELECT id FROM agent_runs WHERE {owner_sql} ORDER BY created_at DESC LIMIT ?
            )
            """,
            (*owner_params, *owner_params, MAX_RUNS_PER_OWNER),
        )
        conn.commit()
    return run_id


def _summary(row: Any) -> Dict[str, Any]:
    try:
        extra = json.loads(row["summary_json"] or "{}")
    except (TypeError, ValueError):
        extra = {}
    return {**extra, "id": row["id"], "session_id": row["session_id"], "turn_id": row["turn_id"],
            "question": row["question"], "status": row["status"], "total_ms": row["total_ms"],
            "model_ms": row["model_ms"], "steps": row["steps"], "tool_calls": row["tool_calls"],
            "errors": row["errors"], "model": row["model"], "created_at": row["created_at"]}


def list_runs(limit: int = 50, session_id: str | None = None, status: str | None = None,
              owner_id: Any = UNSET) -> List[Dict[str, Any]]:
    """Newest runs first, without their timelines."""
    scope_sql, params = _scope(resolve_owner(owner_id))
    filters = ""
    if session_id:
        filters += " AND session_id = ?"
        params.append(session_id)
    if status:
        filters += " AND status = ?"
        params.append(status)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT {SUMMARY_COLUMNS} FROM agent_runs WHERE 1 = 1{scope_sql}{filters} ORDER BY created_at DESC LIMIT ?",
            (*params, max(1, min(limit, MAX_RUNS_PER_OWNER))),
        ).fetchall()
    return [_summary(row) for row in rows]


def get_run(run_id: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    """One run with its full timeline; ValueError when it does not exist for this user."""
    scope_sql, params = _scope(resolve_owner(owner_id))
    with _connect() as conn:
        row = conn.execute(
            f"SELECT {SUMMARY_COLUMNS}, events_json FROM agent_runs WHERE id = ?{scope_sql}",
            (run_id, *params),
        ).fetchone()
    if row is None:
        raise ValueError(f"No run {run_id}")
    try:
        events = json.loads(row["events_json"] or "[]")
    except (TypeError, ValueError):
        events = []
    return {**_summary(row), "events": events}

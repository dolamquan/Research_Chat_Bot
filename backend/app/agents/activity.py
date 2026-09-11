"""A short digest of the user's recent work for the assistant's prompt.

Cheap by design: three small queries, cached for a minute per owner so an
assistant that is always present does not hit sqlite on every utterance.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List

from app.auth.context import UNSET, resolve_owner

CACHE_SECONDS = 60
ITEMS = 5

_cache: Dict[str | None, tuple[float, Dict[str, Any]]] = {}


def _titles(rows: List[Dict[str, Any]], key: str = "title") -> List[str]:
    return [str(row.get(key) or "").strip()[:80] for row in rows[:ITEMS] if row.get(key)]


def activity_digest(owner_id: Any = UNSET, *, refresh: bool = False) -> Dict[str, Any]:
    owner = resolve_owner(owner_id)
    cached = _cache.get(owner)
    now = time.monotonic()
    if cached and not refresh and now - cached[0] < CACHE_SECONDS:
        return cached[1]

    from app.storage import agent_history, chat_history, notes

    digest: Dict[str, Any] = {"agent_sessions": [], "chat_sessions": [], "notes": [], "note_count": 0}
    try:
        digest["agent_sessions"] = _titles(agent_history.list_sessions(limit=ITEMS, owner_id=owner, kind="agent"))
    except Exception:
        pass
    try:
        digest["chat_sessions"] = _titles(chat_history.list_sessions(limit=ITEMS, owner_id=owner))
    except Exception:
        pass
    try:
        recent = notes.list_notes(limit=200, owner_id=owner)
        digest["note_count"] = len(recent)
        digest["notes"] = _titles(recent)
    except Exception:
        pass
    digest["generated_at"] = time.time()
    _cache[owner] = (now, digest)
    return digest


def render_activity(digest: Dict[str, Any] | None) -> str:
    if not digest:
        return "- No recent activity recorded."
    lines = []
    if digest.get("chat_sessions"):
        lines.append("- Recent chats: " + "; ".join(digest["chat_sessions"]))
    if digest.get("agent_sessions"):
        lines.append("- Recent agent sessions: " + "; ".join(digest["agent_sessions"]))
    if digest.get("notes"):
        count = digest.get("note_count") or len(digest["notes"])
        lines.append(f"- Notes ({count} total), latest: " + "; ".join(digest["notes"]))
    return "\n".join(lines) or "- No recent activity recorded."


def forget(owner_id: Any = UNSET) -> None:
    _cache.pop(resolve_owner(owner_id), None)

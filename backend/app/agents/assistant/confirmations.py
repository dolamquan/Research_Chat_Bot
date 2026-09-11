"""Risky actions wait for an explicit yes.

The Agent tab lets a destructive tool run when the user's own words asked for
it. Spoken commands are noisier, so the assistant parks destructive and
external-write calls here, tells the user exactly what it would do, and only
runs them after a `confirm` frame or a short affirmative reply.
"""
from __future__ import annotations

import os
import re
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, Literal
from uuid import uuid4

DEFAULT_TTL_SECONDS = 600
GUARDED_EFFECTS = ("destructive", "external_write")

AFFIRMATIVE = {
    "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed", "affirmative",
    "do it", "go ahead", "go for it", "proceed", "please do", "yes please", "yes do it", "correct", "right", "absolutely",
}
NEGATIVE = {
    "no", "nope", "nah", "cancel", "stop", "don't", "dont", "do not", "never mind", "nevermind", "abort",
    "negative", "no thanks", "no thank you", "skip", "leave it", "forget it",
}
_PUNCT = re.compile(r"[^\w\s']")

Guard = Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any] | None]


def confirmation_ttl() -> float:
    try:
        return max(10.0, float(os.getenv("ASSISTANT_CONFIRMATION_TTL", "") or DEFAULT_TTL_SECONDS))
    except ValueError:
        return float(DEFAULT_TTL_SECONDS)


@dataclass
class PendingAction:
    id: str
    session_id: str
    tool: str
    arguments: Dict[str, Any]
    effect: str
    summary: str
    created_at: float = field(default_factory=time.time)
    expires_at: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["expires_in"] = max(0, int(self.expires_at - time.time()))
        return data


class PendingActions:
    """One parked action per session, in memory, with a TTL.

    Deliberately not persisted: a destructive action should not silently
    survive a reload and run on the first "yes" of the next day.
    """

    def __init__(self, ttl: float | None = None) -> None:
        self._ttl = ttl
        self._store: Dict[str, PendingAction] = {}

    @property
    def ttl(self) -> float:
        return self._ttl if self._ttl is not None else confirmation_ttl()

    def _sweep(self) -> None:
        now = time.time()
        for key in [k for k, v in self._store.items() if v.expires_at <= now]:
            self._store.pop(key, None)

    def park(self, session_id: str, tool: str, arguments: Dict[str, Any], effect: str, summary: str) -> PendingAction:
        self._sweep()
        action = PendingAction(
            id=f"pa-{uuid4().hex[:10]}", session_id=session_id, tool=tool, arguments=dict(arguments or {}),
            effect=effect, summary=summary, expires_at=time.time() + self.ttl,
        )
        self._store[session_id] = action
        return action

    def get(self, session_id: str) -> PendingAction | None:
        self._sweep()
        return self._store.get(session_id)

    def pop(self, session_id: str) -> PendingAction | None:
        self._sweep()
        return self._store.pop(session_id, None)


def summarize_action(tool: Dict[str, Any], arguments: Dict[str, Any]) -> str:
    description = str(tool.get("description") or tool.get("name") or "").split(" [", 1)[0].strip()
    detail = ""
    if isinstance(arguments, dict):
        flat = {**arguments.get("path", {}), **arguments.get("query", {})} if any(k in arguments for k in ("path", "query", "body")) else arguments
        if isinstance(arguments.get("body"), dict):
            flat = {**flat, **{k: v for k, v in arguments["body"].items() if isinstance(v, (str, int, float))}}
        pairs = [f"{k}={str(v)[:40]}" for k, v in list(flat.items())[:4]]
        detail = f" ({', '.join(pairs)})" if pairs else ""
    return f"{description or tool.get('name')}{detail}"


def explicit_guard(store: PendingActions, session_id: str) -> Guard:
    """A runtime guard that parks guarded calls instead of running them."""

    def guard(tool: Dict[str, Any], arguments: Dict[str, Any]) -> Dict[str, Any] | None:
        effect = str(tool.get("effect") or "read")
        if effect not in GUARDED_EFFECTS:
            return None
        existing = store.get(session_id)
        if existing is not None and (existing.tool != tool.get("name") or existing.arguments != arguments):
            return {
                "requires_confirmation": True,
                "pending_action": existing.to_dict(),
                "error": (
                    f"Another action ({existing.tool}) is already waiting for the user's confirmation. "
                    "Ask them to answer yes or no to that first."
                ),
            }
        action = existing or store.park(session_id, str(tool.get("name")), arguments, effect, summarize_action(tool, arguments))
        return {
            "requires_confirmation": True,
            "pending_action": action.to_dict(),
            "error": (
                f"{action.tool} is marked {effect}. It has NOT run. Tell the user in one sentence exactly what it "
                f"would do ({action.summary}) and ask them to answer yes or no."
            ),
        }

    return guard


def classify_reply(text: str) -> Literal["yes", "no"] | None:
    """Short affirmative/negative utterances only; anything longer is a new request."""
    normalized = _PUNCT.sub(" ", (text or "").lower())
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized or len(normalized.split()) > 6:
        return None
    if normalized in NEGATIVE:
        return "no"
    if normalized in AFFIRMATIVE:
        return "yes"
    words = normalized.split()
    lead = " ".join(words[:2])
    if words[0] in {"no", "nope", "nah", "cancel", "stop", "abort"} or lead in {"never mind", "do not", "don't do"}:
        return "no"
    if words[0] in {"yes", "yeah", "yep", "yup", "sure", "okay", "ok", "confirm", "proceed", "affirmative"} or lead in {"go ahead", "do it", "please do"}:
        # "yes but first search X" carries a new instruction; let the model handle it.
        if any(w in words for w in ("but", "first", "instead", "after", "before", "then")):
            return None
        return "yes"
    return None

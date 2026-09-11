"""Frames exchanged over the assistant websocket.

Every frame is a JSON object with a `type`. Client frames are validated here;
server frames are plain dicts built by the connection (they are documented in
the docstring of each builder so the browser and the tests share one source).
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

HELLO_TIMEOUT_SECONDS = 10
CLOSE_UNAUTHORIZED = 4401
CLOSE_BAD_HELLO = 4400


class _Frame(BaseModel):
    model_config = ConfigDict(extra="ignore")


class HelloFrame(_Frame):
    type: Literal["hello"]
    token: str = ""
    session_id: str | None = None
    client_tools: List[Dict[str, Any]] = Field(default_factory=list)
    workspace: Dict[str, Any] = Field(default_factory=dict)
    client: Dict[str, Any] = Field(default_factory=dict)


class UserMessageFrame(_Frame):
    type: Literal["user_message"]
    id: str | None = None
    text: str = Field(..., min_length=1, max_length=8000)
    source: Literal["voice", "text"] = "text"
    workspace: Dict[str, Any] = Field(default_factory=dict)


class ClientToolResultFrame(_Frame):
    type: Literal["client_tool_result"]
    call_id: str
    ok: bool = True
    result: Any = None
    error: str | None = None


class ConfirmFrame(_Frame):
    type: Literal["confirm"]
    action_id: str | None = None
    approved: bool
    workspace: Dict[str, Any] = Field(default_factory=dict)


class CancelFrame(_Frame):
    type: Literal["cancel"]
    reason: str = "user"


class AuthFrame(_Frame):
    type: Literal["auth"]
    token: str


class WorkspaceFrame(_Frame):
    type: Literal["workspace"]
    workspace: Dict[str, Any] = Field(default_factory=dict)


class PingFrame(_Frame):
    type: Literal["ping"]


ClientFrame = Union[
    HelloFrame, UserMessageFrame, ClientToolResultFrame, ConfirmFrame, CancelFrame, AuthFrame, WorkspaceFrame, PingFrame,
]

_adapter: TypeAdapter = TypeAdapter(ClientFrame)


class BadFrame(ValueError):
    pass


def parse_client_frame(data: Any) -> ClientFrame:
    if not isinstance(data, dict):
        raise BadFrame("Frames must be JSON objects with a 'type'")
    try:
        return _adapter.validate_python(data)
    except ValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", []) if p not in ("union", "tagged-union"))
        raise BadFrame(f"Invalid {data.get('type', 'frame')!r} frame{f' at {where}' if where else ''}: {first.get('msg', 'validation failed')}") from exc


# --- server frame builders --------------------------------------------------

def error_frame(code: str, message: str, turn_id: str | None = None) -> Dict[str, Any]:
    """codes: unauthorized | bad_message | busy | provider | client_tool_timeout | internal"""
    return {"type": "error", "code": code, "message": message, "turn_id": turn_id}


def done_frame(turn_id: str, status: str = "ok", reason: str | None = None) -> Dict[str, Any]:
    """status: ok | cancelled | error; reason: superseded | user | barge_in | None"""
    return {"type": "done", "turn_id": turn_id, "status": status, "reason": reason}

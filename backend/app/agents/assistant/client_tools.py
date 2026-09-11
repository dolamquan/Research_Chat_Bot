"""Tools the browser lends the model: navigate, open a paper, jump to a page.

The frontend declares them in its `hello` frame as JSON tool specs. They are
bound to the model as ordinary function tools named `ui_<name>` (OpenAI
forbids dots in function names) and, when called, round-trip over the
websocket: the server emits `client_tool_call`, the page runs the action and
answers `client_tool_result`, which resolves a future the loop is awaiting.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, Dict, List

CLIENT_TOOL_PREFIX = "ui_"
NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,48}$")
MAX_CLIENT_TOOLS = 40
MAX_SCHEMA_CHARS = 6000
EFFECTS = ("read", "write", "destructive")
DEFAULT_TIMEOUT_SECONDS = 20.0

# The six meta tools bound by the runtime; a client tool cannot shadow them.
RESERVED = {"discover_tools", "describe_tool", "execute_tool", "app_context", "app_papers", "answer_from_papers"}


class ClientToolTimeout(Exception):
    pass


def client_tool_timeout() -> float:
    try:
        return max(1.0, float(os.getenv("ASSISTANT_CLIENT_TOOL_TIMEOUT", "") or DEFAULT_TIMEOUT_SECONDS))
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS


def validate_client_tools(specs: Any) -> Dict[str, Dict[str, Any]]:
    """Normalise the browser's tool list into {name: spec}; bad entries raise ValueError."""
    if specs in (None, []):
        return {}
    if not isinstance(specs, list):
        raise ValueError("client_tools must be a list")
    if len(specs) > MAX_CLIENT_TOOLS:
        raise ValueError(f"At most {MAX_CLIENT_TOOLS} client tools are accepted")
    result: Dict[str, Dict[str, Any]] = {}
    for spec in specs:
        if not isinstance(spec, dict):
            raise ValueError("Each client tool must be an object")
        name = str(spec.get("name") or "").strip()
        if not NAME_RE.match(name):
            raise ValueError(f"Invalid client tool name: {name!r}")
        if name in RESERVED or name in result:
            raise ValueError(f"Client tool name is reserved or duplicated: {name}")
        schema = spec.get("input_schema") or {"type": "object", "properties": {}}
        if not isinstance(schema, dict) or schema.get("type", "object") != "object":
            raise ValueError(f"Client tool {name}: input_schema must describe an object")
        if len(json.dumps(schema)) > MAX_SCHEMA_CHARS:
            raise ValueError(f"Client tool {name}: input_schema is too large")
        effect = str(spec.get("effect") or "read")
        if effect not in EFFECTS:
            raise ValueError(f"Client tool {name}: effect must be one of {EFFECTS}")
        result[name] = {
            "name": name,
            "description": str(spec.get("description") or "").strip()[:600] or f"Browser action {name}",
            "input_schema": schema,
            "effect": effect,
        }
    return result


def bind_client_tools(specs: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """OpenAI-style function definitions for the validated specs."""
    tools = []
    for spec in specs.values():
        schema = dict(spec["input_schema"])
        schema.setdefault("type", "object")
        schema.setdefault("properties", {})
        tools.append({"type": "function", "function": {
            "name": CLIENT_TOOL_PREFIX + spec["name"],
            "description": f"{spec['description']} (Runs in the user's browser and changes what they see.)",
            "parameters": schema,
        }})
    return tools


def is_client_tool(bound_name: str) -> bool:
    return bound_name.startswith(CLIENT_TOOL_PREFIX)


def client_name(bound_name: str) -> str:
    return bound_name[len(CLIENT_TOOL_PREFIX):] if is_client_tool(bound_name) else bound_name


def client_label(bound_name: str) -> str:
    """How a client tool appears in the tool trace: ui.<name>."""
    return "ui." + client_name(bound_name)


class ClientToolExecutor:
    """Futures keyed by call id, resolved by the connection's reader loop."""

    def __init__(self, timeout: float | None = None) -> None:
        self.timeout = timeout if timeout is not None else client_tool_timeout()
        self._pending: Dict[str, asyncio.Future] = {}

    def register(self, call_id: str) -> asyncio.Future:
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._pending[call_id] = future
        return future

    async def wait(self, call_id: str) -> Any:
        future = self._pending.get(call_id) or self.register(call_id)
        try:
            return await asyncio.wait_for(future, timeout=self.timeout)
        except asyncio.TimeoutError as exc:
            raise ClientToolTimeout(f"The browser did not respond within {self.timeout:.0f}s") from exc
        finally:
            self._pending.pop(call_id, None)

    def resolve(self, call_id: str, *, ok: bool = True, result: Any = None, error: str | None = None) -> bool:
        future = self._pending.get(call_id)
        if future is None or future.done():
            return False
        if ok and error is None:
            future.set_result(result if result is not None else {"ok": True})
        else:
            future.set_result({"error": error or "The browser reported a failure", "ok": False})
        return True

    def cancel_all(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()

    @property
    def outstanding(self) -> List[str]:
        return list(self._pending)

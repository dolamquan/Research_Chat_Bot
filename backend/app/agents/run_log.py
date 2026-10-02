"""A flight recorder for one assistant turn.

Every model call (latency, time to first token, token and reasoning usage,
which tools it chose), every tool call (arguments, outcome, duration, what
it returned) and the final answer land in one timeline, which is saved to
the run buffer (app.storage.agent_runs) when the turn ends. The Console's
Runs tab and the agent itself read it back to trace what happened and why.

The active recorder lives in a context variable so the runtime can report
from anywhere in the turn, workers included, without threading a parameter
through every call. Outside a recorded turn every call here is a no-op.
"""
from __future__ import annotations

import json
import time
from contextvars import ContextVar, Token
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List

MAX_EVENTS = 400
TEXT_LIMIT = 1200

_current: ContextVar["RunRecorder | None"] = ContextVar("agent_run_recorder", default=None)

Send = Callable[[Dict[str, Any]], Awaitable[None]]


def _excerpt(value: Any, limit: int = TEXT_LIMIT) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str, ensure_ascii=False)
    return text if len(text) <= limit else text[:limit] + f"... [{len(text) - limit} more chars]"


def usage_of(message: Any) -> Dict[str, int]:
    """Token usage from a LangChain message, flattened; empty when the provider sent none."""
    meta = getattr(message, "usage_metadata", None) or {}
    if not meta:
        return {}
    inputs = meta.get("input_token_details") or {}
    outputs = meta.get("output_token_details") or {}
    return {
        "input": int(meta.get("input_tokens") or 0),
        "cached": int(inputs.get("cache_read") or 0),
        "output": int(meta.get("output_tokens") or 0),
        "reasoning": int(outputs.get("reasoning") or 0),
    }


class RunRecorder:
    def __init__(self, *, session_id: str, turn_id: str, question: str, source: str = "") -> None:
        self.session_id = session_id
        self.turn_id = turn_id
        self.question = question
        self.source = source
        self.started_at = datetime.now(timezone.utc).isoformat()
        self._t0 = time.monotonic()
        self.events: List[Dict[str, Any]] = []
        self.dropped = 0
        self.answer = ""
        self._awaiting_first_token = False

    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000)

    def add(self, kind: str, **data: Any) -> None:
        if len(self.events) >= MAX_EVENTS:
            self.dropped += 1
            return
        self.events.append({"t_ms": self.elapsed_ms(), "kind": kind, **{k: v for k, v in data.items() if v is not None}})

    def observe(self, frame: Dict[str, Any]) -> None:
        """Record what the user's screen was sent; tokens only mark the first one per step."""
        kind = frame.get("type")
        worker = frame.get("worker")
        if kind == "token":
            if self._awaiting_first_token:
                self._awaiting_first_token = False
                self.add("first_token")
            return
        if kind == "thinking":
            self._awaiting_first_token = True
            self.add("model_start", step=frame.get("step"))
        elif kind == "tool_start":
            self.add("tool_start", call_id=frame.get("call_id"), tool=frame.get("tool"), effect=frame.get("effect"),
                     execution=frame.get("execution"), arguments=frame.get("arguments"), worker=worker)
        elif kind == "tool_result":
            self.add("tool_result", call_id=frame.get("call_id"), tool=frame.get("tool"), status=frame.get("status"),
                     message=_excerpt(frame.get("message") or "", 300), duration_ms=frame.get("duration_ms"), worker=worker)
        elif kind == "confirmation_required":
            self.add("confirmation_required", tool=frame.get("tool"), summary=frame.get("summary"))
        elif kind == "error":
            self.add("error", code=frame.get("code"), message=_excerpt(frame.get("message") or "", 500))
        elif kind == "answer":
            self.answer = str(frame.get("answer") or "")
            self.add("answer", text=_excerpt(self.answer, 600), sources=len(frame.get("sources") or []))

    def wrap(self, send: Send) -> Send:
        async def emit(frame: Dict[str, Any]) -> None:
            self.observe(frame)
            await send(frame)
        return emit

    def summary(self, status: str) -> Dict[str, Any]:
        main_steps = [e for e in self.events if e["kind"] == "model_step" and not e.get("worker")]
        worker_steps = [e for e in self.events if e["kind"] == "model_step" and e.get("worker")]
        tool_results = [e for e in self.events if e["kind"] == "tool_result" and not e.get("worker")]
        tokens = {"input": 0, "cached": 0, "output": 0, "reasoning": 0}
        for step in main_steps + worker_steps:
            for key in tokens:
                tokens[key] += int((step.get("usage") or {}).get(key) or 0)
        prompt = next((e for e in self.events if e["kind"] == "prompt_built"), {})
        config = next((e for e in self.events if e["kind"] == "run_config"), {})
        return {
            "session_id": self.session_id,
            "turn_id": self.turn_id,
            "question": self.question[:500],
            "source": self.source,
            "status": status,
            "answer": self.answer[:600],
            "started_at": self.started_at,
            "total_ms": self.elapsed_ms(),
            "prompt_ms": int(prompt.get("ms") or 0),
            "model_ms": sum(int(e.get("ms") or 0) for e in main_steps),
            "tool_ms": sum(int(e.get("duration_ms") or 0) for e in tool_results),
            "steps": len(main_steps),
            "worker_steps": len(worker_steps),
            "tool_calls": len([e for e in self.events if e["kind"] == "tool_start"]),
            "errors": len([e for e in self.events if e["kind"] == "error" or e.get("status") == "error"]),
            "model": str(config.get("model") or ""),
            "effort": str(config.get("effort") or ""),
            "tokens": tokens,
            "events": self.events,
            "dropped_events": self.dropped,
        }


def start(recorder: RunRecorder) -> Token:
    return _current.set(recorder)


def stop(token: Token) -> None:
    _current.reset(token)


def current() -> RunRecorder | None:
    return _current.get()


def note(kind: str, **data: Any) -> None:
    recorder = _current.get()
    if recorder is not None:
        recorder.add(kind, **data)


def note_model_step(*, started: float, first_token: float | None, response: Any, worker: str | None = None) -> None:
    recorder = _current.get()
    if recorder is None:
        return
    ended = time.monotonic()
    calls = [str(call.get("name") or "") for call in (getattr(response, "tool_calls", None) or [])]
    content = getattr(response, "content", "")
    recorder.add(
        "model_step",
        ms=int((ended - started) * 1000),
        ttft_ms=int((first_token - started) * 1000) if first_token else None,
        usage=usage_of(response) or None,
        tool_calls=calls or None,
        text_chars=len(content) if isinstance(content, str) else None,
        worker=worker,
    )


def note_tool_output(call_id: str, tool: str, result: Any, worker: str | None = None) -> None:
    recorder = _current.get()
    if recorder is not None:
        recorder.add("tool_output", call_id=call_id, tool=tool, output=_excerpt(result), worker=worker)

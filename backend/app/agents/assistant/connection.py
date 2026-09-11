"""One websocket, one user, one long-lived assistant session.

The connection authenticates on the first frame, restores the user's
assistant session, then loops over client frames. Each user message becomes a
turn task running `arun_agent`; its events are written straight back to the
socket. Browser tool calls and confirmations round-trip through the same
socket while the turn awaits them.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Dict

from fastapi import WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool

from app.agents import catalog
from app.agents.activity import activity_digest
from app.agents.assistant.client_tools import ClientToolExecutor, validate_client_tools
from app.agents.assistant.confirmations import PendingActions, classify_reply, explicit_guard
from app.agents.assistant.protocol import (
    CLOSE_BAD_HELLO,
    CLOSE_UNAUTHORIZED,
    HELLO_TIMEOUT_SECONDS,
    AuthFrame,
    BadFrame,
    CancelFrame,
    ClientToolResultFrame,
    ConfirmFrame,
    HelloFrame,
    PingFrame,
    UserMessageFrame,
    WorkspaceFrame,
    done_frame,
    error_frame,
    parse_client_frame,
)
from app.agents.context_schema import normalize_workspace
from app.agents.runtime import arun_agent
from app.auth.context import CurrentUser, set_current_user
from app.auth.deps import AuthError, authenticate_token
from app.rag.llm_provider import ProviderNotConfigured
from app.storage import agent_history

logger = logging.getLogger(__name__)

SESSION_KIND = "assistant"
DEFAULT_HISTORY_LIMIT = 12

# One store for the whole process: a parked action belongs to a session, not a socket.
PENDING = PendingActions()


def history_limit() -> int:
    try:
        return max(0, int(os.getenv("ASSISTANT_HISTORY_LIMIT", "") or DEFAULT_HISTORY_LIMIT))
    except ValueError:
        return DEFAULT_HISTORY_LIMIT


class HandshakeFailed(Exception):
    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


class AssistantConnection:
    def __init__(self, websocket: WebSocket, *, pending: PendingActions = PENDING, history: Any = agent_history) -> None:
        self.ws = websocket
        self.pending = pending
        self.history = history
        self.user: CurrentUser | None = None
        self.session_id: str = ""
        self.client_tools: Dict[str, Dict[str, Any]] = {}
        self.workspace: Dict[str, Any] = {}
        self.client_info: Dict[str, Any] = {}
        self.executor = ClientToolExecutor()
        self.turn: asyncio.Task | None = None
        self.turn_id: str = ""
        self._turns = 0
        self._send_lock = asyncio.Lock()
        self._closed = False

    # -- lifecycle --------------------------------------------------------------

    async def serve(self) -> None:
        try:
            await self._handshake()
        except HandshakeFailed as exc:
            await self._close(exc.code, exc.reason)
            return
        except WebSocketDisconnect:
            return
        try:
            while True:
                try:
                    raw = await self.ws.receive_json()
                except json.JSONDecodeError:
                    await self.send(error_frame("bad_message", "Frames must be JSON"))
                    continue
                try:
                    frame = parse_client_frame(raw)
                except BadFrame as exc:
                    await self.send(error_frame("bad_message", str(exc)))
                    continue
                await self._handle(frame)
        except WebSocketDisconnect:
            pass
        finally:
            self._closed = True
            await self.cancel_turn("disconnect", notify=False)
            self.executor.cancel_all()

    async def _close(self, code: int, reason: str) -> None:
        self._closed = True
        try:
            await self.ws.close(code=code, reason=reason[:120])
        except Exception:  # already gone
            pass

    async def send(self, frame: Dict[str, Any]) -> None:
        if self._closed:
            return
        async with self._send_lock:
            try:
                await self.ws.send_json(frame)
            except (WebSocketDisconnect, RuntimeError):
                self._closed = True

    # -- handshake --------------------------------------------------------------

    async def _handshake(self) -> None:
        try:
            raw = await asyncio.wait_for(self.ws.receive_json(), timeout=HELLO_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as exc:
            raise HandshakeFailed(CLOSE_UNAUTHORIZED, "No hello frame received") from exc
        except json.JSONDecodeError as exc:
            raise HandshakeFailed(CLOSE_BAD_HELLO, "Hello frame must be JSON") from exc
        try:
            frame = parse_client_frame(raw)
        except BadFrame as exc:
            raise HandshakeFailed(CLOSE_BAD_HELLO, str(exc)) from exc
        if not isinstance(frame, HelloFrame):
            raise HandshakeFailed(CLOSE_BAD_HELLO, "The first frame must be hello")
        try:
            self.client_tools = validate_client_tools(frame.client_tools)
        except ValueError as exc:
            raise HandshakeFailed(CLOSE_BAD_HELLO, str(exc)) from exc

        token = frame.token or self.ws.query_params.get("access_token", "")
        try:
            self.user = await authenticate_token(token)
        except AuthError as exc:
            raise HandshakeFailed(CLOSE_UNAUTHORIZED, exc.detail) from exc
        set_current_user(self.user)

        self.workspace = normalize_workspace(frame.workspace)
        self.client_info = dict(frame.client or {})
        session = await run_in_threadpool(self._resolve_session, frame.session_id)
        self.session_id = session["id"]
        messages = await run_in_threadpool(self.history.recent_messages, self.session_id, history_limit())
        tool_count = await run_in_threadpool(lambda: len(catalog.tool_catalog()))
        pending = self.pending.get(self.session_id)
        await self.send({
            "type": "session",
            "session_id": self.session_id,
            "user": {"id": self.user.id, "email": self.user.email},
            "client_tools": [f"ui.{name}" for name in self.client_tools],
            "history": [
                {
                    "role": m["role"], "content": m["content"], "created_at": m["created_at"],
                    "spoken": (m.get("meta") or {}).get("spoken"), "source": (m.get("meta") or {}).get("source"),
                    "tool_trace": m.get("tool_trace") or [], "sources": m.get("sources") or [],
                }
                for m in messages
            ],
            "pending_action": pending.to_dict() if pending else None,
            "catalog_tool_count": tool_count,
        })

    def _resolve_session(self, requested: str | None) -> Dict[str, Any]:
        """The caller's assistant session: the requested one if theirs, else the latest, else a new one."""
        if requested:
            try:
                session = self.history.get_session_summary(requested)
                if session.get("kind", "agent") == SESSION_KIND:
                    return session
            except ValueError:
                pass
        latest = self.history.latest_session(SESSION_KIND)
        if latest:
            return latest
        return self.history.create_session(title="Assistant", kind=SESSION_KIND)

    # -- frames -----------------------------------------------------------------

    async def _handle(self, frame: Any) -> None:
        if isinstance(frame, PingFrame):
            await self.send({"type": "pong"})
        elif isinstance(frame, HelloFrame):
            await self.send(error_frame("bad_message", "hello was already received on this connection"))
        elif isinstance(frame, AuthFrame):
            await self._refresh_auth(frame)
        elif isinstance(frame, WorkspaceFrame):
            if frame.workspace:
                self.workspace = normalize_workspace(frame.workspace)
        elif isinstance(frame, ClientToolResultFrame):
            resolved = self.executor.resolve(frame.call_id, ok=frame.ok, result=frame.result, error=frame.error)
            if not resolved:
                await self.send(error_frame("bad_message", f"No browser tool call is waiting for id {frame.call_id}", self.turn_id or None))
        elif isinstance(frame, CancelFrame):
            await self.cancel_turn(frame.reason)
        elif isinstance(frame, ConfirmFrame):
            await self._start_turn("Yes." if frame.approved else "No.", frame.workspace, "text", confirm=frame)
        elif isinstance(frame, UserMessageFrame):
            await self._start_turn(frame.text, frame.workspace, frame.source, message_id=frame.id)

    async def _refresh_auth(self, frame: AuthFrame) -> None:
        try:
            user = await authenticate_token(frame.token)
        except AuthError as exc:
            await self.send(error_frame("unauthorized", exc.detail))
            return
        if self.user and user.id != self.user.id:
            await self.send(error_frame("unauthorized", "The refreshed token belongs to a different user"))
            return
        self.user = user
        set_current_user(user)
        await self.send({"type": "auth_ok"})

    # -- turns ------------------------------------------------------------------

    async def _start_turn(
        self, text: str, workspace: Dict[str, Any], source: str, *, confirm: ConfirmFrame | None = None, message_id: str | None = None,
    ) -> None:
        if self.turn is not None and not self.turn.done():
            await self.cancel_turn("superseded")
        if workspace:
            self.workspace = normalize_workspace(workspace)

        self._turns += 1
        turn_id = f"t-{self._turns}"
        pending = self.pending.get(self.session_id)
        resume = declined = None
        if pending is not None:
            if confirm is not None:
                decision = "yes" if confirm.approved and (confirm.action_id in (None, pending.id)) else "no"
            else:
                decision = classify_reply(text)
            action = self.pending.pop(self.session_id)  # answered or superseded either way
            if decision == "yes":
                resume = action.to_dict()
            elif decision == "no":
                declined = action.to_dict()
        elif confirm is not None:
            await self.send(error_frame("bad_message", "No action is waiting for confirmation", turn_id))
            return

        state: Dict[str, Any] = {
            "session_id": self.session_id,
            "question": text,
            "mode": "assistant",
            "source": source,
            "turn_id": turn_id,
            "workspace": {**self.workspace, "client": {**self.client_info, "source": source}},
            "pinned_sources": list(self.workspace.get("pinned_sources") or []),
            "chat_history": [],
            "context_mode": self.workspace.get("context_mode") or "retrieval",
            "document_source": (self.workspace.get("selected_paper") or {}).get("source"),
            "cluster_id": (self.workspace.get("selected_cluster") or {}).get("cluster_id"),
            "domain": (self.workspace.get("library_filter") or {}).get("domain"),
            "category": (self.workspace.get("library_filter") or {}).get("category"),
            "resume_action": resume,
            "declined_action": declined,
        }
        self.turn_id = turn_id
        self.turn = asyncio.create_task(self._run_turn(state, turn_id, message_id))

    async def _run_turn(self, state: Dict[str, Any], turn_id: str, message_id: str | None) -> None:
        set_current_user(self.user)
        status = "ok"
        try:
            await self.send({"type": "turn_start", "turn_id": turn_id, "message_id": message_id})
            recent = await run_in_threadpool(self.history.recent_messages, self.session_id, history_limit())
            state["chat_history"] = [{"role": m["role"], "content": m["content"]} for m in recent]
            await run_in_threadpool(lambda: self.history.append_message(
                session_id=self.session_id, role="user", content=state["question"],
                meta={"source": state["source"], "turn_id": turn_id},
            ))
            activity = await run_in_threadpool(activity_digest)
            result = await arun_agent(
                state, emit=self.send, mode="assistant", client_tools=self.client_tools,
                client_executor=self.executor, guard=explicit_guard(self.pending, self.session_id),
                turn_id=turn_id, activity=activity,
            )
            await run_in_threadpool(lambda: self.history.append_message(
                session_id=self.session_id, role="assistant", content=result["answer"], sources=result["sources"],
                tool_trace=result["tool_trace"], intent=result["intent"],
                meta={"spoken": result.get("spoken", ""), "turn_id": turn_id, "workspace": self.workspace},
            ))
        except asyncio.CancelledError:
            raise
        except ProviderNotConfigured as exc:
            status = "error"
            await self.send(error_frame("provider", str(exc), turn_id))
        except Exception as exc:  # the user hears about it instead of a silent socket
            status = "error"
            logger.exception("assistant turn %s failed", turn_id)
            await self.send(error_frame("internal", f"Assistant failed: {exc}", turn_id))
        await self.send(done_frame(turn_id, status))

    async def cancel_turn(self, reason: str, *, notify: bool = True) -> None:
        task = self.turn
        if task is None or task.done():
            return
        task.cancel()
        self.executor.cancel_all()
        try:
            await task
        except BaseException:  # CancelledError, or whatever the turn was in the middle of
            pass
        if notify:
            await self.send(done_frame(self.turn_id, "cancelled", reason))

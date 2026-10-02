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
import time
from typing import Any, Dict

from fastapi import WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool

from app.agents import catalog, run_log
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
from app.auth.context import UNSET, CurrentUser, resolve_owner, set_current_user
from app.auth.deps import AuthError, authenticate_token
from app.rag.llm_provider import ProviderNotConfigured
from app.storage import agent_history, agent_runs

logger = logging.getLogger(__name__)

SESSION_KIND = "assistant"
DEFAULT_HISTORY_LIMIT = 12
MAX_QUEUED_MESSAGES = 32
MAX_BATCH_CHARACTERS = 8000

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
        self._queue_lock = asyncio.Lock()
        self._closed = False
        self.queue: list[UserMessageFrame | ConfirmFrame] = []
        self._confirmation_actions: dict[int, str] = {}

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
        session = await run_in_threadpool(self._resolve_session, frame.session_id, frame.new_session)
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

    def _resolve_session(self, requested: str | None, new_session: bool = False) -> Dict[str, Any]:
        """The caller's assistant session: the requested one if theirs, else the latest, else a new one.

        `new_session` is the browser saying the user asked for a fresh start,
        which is the one case where falling back to the latest session would
        hand back the very conversation they were trying to leave.
        """
        if new_session:
            return self.history.create_session(title="Assistant", kind=SESSION_KIND)
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
                # A browser promise may settle after Stop and a new turn.
                # Report the stale result without failing the new turn.
                await self.send(error_frame("bad_message", f"No browser tool call is waiting for id {frame.call_id}"))
        elif isinstance(frame, CancelFrame):
            await self.cancel_turn(frame.reason)
        elif isinstance(frame, ConfirmFrame):
            await self._enqueue(frame)
        elif isinstance(frame, UserMessageFrame):
            await self._enqueue(frame)

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

    async def _queue_state(self) -> None:
        await self.send({"type": "queue_state", "message_ids": [frame.id for frame in self.queue if frame.id],
                         "count": len(self.queue)})

    async def _enqueue(self, frame: UserMessageFrame | ConfirmFrame) -> None:
        pending = self.pending.get(self.session_id)
        if isinstance(frame, ConfirmFrame) and (pending is None or frame.action_id not in (None, pending.id)):
            message = "No action is waiting for confirmation" if pending is None else "That confirmation is no longer current"
            await self.send(error_frame("bad_message", message))
            if frame.id:
                await self.send({"type": "request_rejected", "message_id": frame.id,
                                 "message": message})
            return
        is_reply = pending is not None and (isinstance(frame, ConfirmFrame) or classify_reply(frame.text) is not None)
        # New instructions accumulate; only an explicit cancel interrupts work.
        if len(self.queue) >= MAX_QUEUED_MESSAGES and not is_reply:
            await self.send({"type": "request_rejected", "message_id": frame.id,
                             "message": "The instruction queue is full. Please wait for the current tasks to finish."})
            return
        if is_reply:
            # A "yes" queued BEFORE the question is asked is not an approval.
            self._confirmation_actions[id(frame)] = pending.id
        self.queue.append(frame)
        await self._queue_state()
        await self._advance_queue()

    async def _advance_queue(self) -> None:
        # A finishing turn and a newly received message can both wake the
        # scheduler. Hold the lock through task creation so only one starts.
        async with self._queue_lock:
            while not self._closed and (self.turn is None or self.turn.done()) and self.queue:
                await self._start_queued_batch()
                if self.turn is not None or self.pending.get(self.session_id):
                    break

    async def _start_queued_batch(self) -> None:
        if self._closed or (self.turn is not None and not self.turn.done()) or not self.queue:
            return
        pending = self.pending.get(self.session_id)
        if pending:
            # Follow-up tasks stay parked until the outstanding question is answered.
            # A confirmation jumps ahead of tasks, without discarding them.
            index = next((i for i, frame in enumerate(self.queue)
                          if self._confirmation_actions.get(id(frame)) == pending.id), None)
            if index is None:
                return
            batch = [self.queue.pop(index)]
        else:
            batch = [self.queue.pop(0)]
            size = len(batch[0].text) if isinstance(batch[0], UserMessageFrame) else 0
            while self.queue and isinstance(batch[0], UserMessageFrame) and isinstance(self.queue[0], UserMessageFrame):
                # Leave room for separators; never truncate an instruction.
                next_size = len(self.queue[0].text) + 2
                if size + next_size > MAX_BATCH_CHARACTERS:
                    break
                batch.append(self.queue.pop(0))
                size += next_size
        for frame in batch:
            self._confirmation_actions.pop(id(frame), None)
        await self._queue_state()
        first = batch[0]
        if isinstance(first, ConfirmFrame):
            await self._start_turn("Yes." if first.approved else "No.", first.workspace, "text",
                                   confirm=first, message_id=first.id)
        else:
            # Preserve the user's words and their arrival order in a single model request.
            # The model, rather than a keyword splitter, resolves dependencies/corrections.
            await self._start_turn("\n\n".join(frame.text for frame in batch), batch[-1].workspace,
                                   first.source, message_id=first.id,
                                   message_ids=[frame.id for frame in batch if frame.id])

    async def _start_turn(
        self, text: str, workspace: Dict[str, Any], source: str, *, confirm: ConfirmFrame | None = None, message_id: str | None = None,
        message_ids: list[str] | None = None,
    ) -> None:
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
            await self.send(error_frame("bad_message", "No action is waiting for confirmation"))
            if message_id:
                await self.send({"type": "request_rejected", "message_id": message_id,
                                 "message": "No action is waiting for confirmation"})
            self.turn = None
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
        self.turn = asyncio.create_task(self._run_turn(state, turn_id, message_id, message_ids))

    async def _run_turn(self, state: Dict[str, Any], turn_id: str, message_id: str | None,
                        message_ids: list[str] | None = None) -> None:
        set_current_user(self.user)
        status = "ok"
        recorder = run_log.RunRecorder(session_id=self.session_id, turn_id=turn_id,
                                       question=str(state["question"]), source=str(state.get("source") or ""))
        log_token = run_log.start(recorder)
        owner = resolve_owner(UNSET)
        emit = recorder.wrap(self.send)
        try:
            await self.send({"type": "turn_start", "turn_id": turn_id, "message_id": message_id,
                             "message_ids": message_ids or ([message_id] if message_id else [])})
            started = time.monotonic()
            async def load_history() -> list:
                recent = await run_in_threadpool(self.history.recent_messages, self.session_id, history_limit())
                await run_in_threadpool(lambda: self.history.append_message(
                    session_id=self.session_id, role="user", content=state["question"],
                    meta={"source": state["source"], "turn_id": turn_id},
                ))
                return recent

            # The activity digest is independent of the history, so both load at once.
            recent, activity = await asyncio.gather(load_history(), run_in_threadpool(activity_digest))
            state["chat_history"] = [{"role": m["role"], "content": m["content"]} for m in recent]
            run_log.note("context_loaded", ms=int((time.monotonic() - started) * 1000), history_messages=len(recent))
            result = await arun_agent(
                state, emit=emit, mode="assistant", client_tools=self.client_tools,
                client_executor=self.executor, guard=explicit_guard(self.pending, self.session_id),
                turn_id=turn_id, activity=activity,
            )
            await run_in_threadpool(lambda: self.history.append_message(
                session_id=self.session_id, role="assistant", content=result["answer"], sources=result["sources"],
                tool_trace=result["tool_trace"], intent=result["intent"],
                meta={"spoken": result.get("spoken", ""), "turn_id": turn_id, "workspace": self.workspace},
            ))
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except ProviderNotConfigured as exc:
            status = "error"
            await emit(error_frame("provider", str(exc), turn_id))
        except Exception as exc:  # the user hears about it instead of a silent socket
            status = "error"
            logger.exception("assistant turn %s failed", turn_id)
            await emit(error_frame("internal", f"Assistant failed: {exc}", turn_id))
        finally:
            run_log.stop(log_token)
            self._save_run(recorder, status, owner)
        await self.send(done_frame(turn_id, status))
        self.turn = None
        await self._advance_queue()

    @staticmethod
    def _save_run(recorder: run_log.RunRecorder, status: str, owner: str | None) -> None:
        """Write the run to the buffer off the event loop; recording must never break a turn."""
        try:
            run = recorder.summary(status)
        except Exception:
            logger.exception("could not summarise assistant run %s", recorder.turn_id)
            return

        def write() -> None:
            try:
                agent_runs.save_run(run, owner_id=owner)
            except Exception:
                logger.exception("could not save assistant run %s", recorder.turn_id)

        asyncio.get_running_loop().run_in_executor(None, write)

    async def cancel_turn(self, reason: str, *, notify: bool = True) -> None:
        async with self._queue_lock:
            await self._cancel_turn(reason, notify=notify)

    async def _cancel_turn(self, reason: str, *, notify: bool = True) -> None:
        self.queue.clear()
        self._confirmation_actions.clear()
        if reason != "disconnect":
            self.pending.pop(self.session_id)
        if notify:
            await self._queue_state()
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
        self.turn = None

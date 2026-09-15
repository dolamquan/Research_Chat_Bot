"""The assistant websocket end to end: handshake, turns, browser tools,
confirmations, cancellation and persistence. Offline: the model is scripted."""

from __future__ import annotations

import asyncio
from typing import Any, List

import pytest
from fastapi.testclient import TestClient
from fastapi.websockets import WebSocketDisconnect
from langchain_core.messages import AIMessage

from app.agents import catalog, runtime
from app.agents.assistant import connection
from app.storage import agent_history, article_store, notes


class ScriptedModel:
    def __init__(self, script: List[Any]) -> None:
        self.script = list(script)
        self.calls: List[List[Any]] = []

    def bind_tools(self, tools, **_kwargs):
        self.bound_tools = list(tools)
        return self

    def invoke(self, messages, **_kwargs):
        self.calls.append(list(messages))
        step = self.script.pop(0) if self.script else "No script left.\nSPEAK: No script left."
        if isinstance(step, str):
            return AIMessage(content=step)
        return AIMessage(content="", tool_calls=[
            {"id": f"call_{i}", "name": name, "args": args, "type": "tool_call"} for i, (name, args) in enumerate(step)
        ])


class BlockingModel(ScriptedModel):
    """The first call hangs until cancelled; later calls follow the script."""

    def __init__(self, script):
        super().__init__(script)
        self.blocked_once = False

    async def ainvoke(self, messages, **_kwargs):
        if not self.blocked_once:
            self.blocked_once = True
            await asyncio.sleep(30)
        return self.invoke(messages)


@pytest.fixture(scope="module")
def client():
    from app.main import app

    return TestClient(app)


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(agent_history, "DB_PATH", tmp_path / "agent_history.sqlite3")
    monkeypatch.setattr(connection, "activity_digest", lambda *a, **k: {"chat_sessions": ["Earlier chat"]})
    papers = [{"article_id": "a1", "title": "Graph RAG for Science", "source": "graph.pdf", "url": "http://x/1",
               "domain": "research", "category": "nlp", "status": "indexed", "tags": ["rag"], "abstract": "graphs"}]
    monkeypatch.setattr(article_store, "list_articles", lambda domain=None, category=None, limit=100: papers)
    monkeypatch.setattr(article_store, "list_domains", lambda: [{"domain": "research", "category": "nlp", "article_count": 1}])
    monkeypatch.setattr(notes, "list_notion_targets", lambda: [])


def _model(monkeypatch, script, cls=ScriptedModel):
    model = cls(script)
    monkeypatch.setattr(runtime, "get_llm", lambda *a, **k: model)
    return model


OPEN_PAPER = {"name": "open_paper", "description": "Open a paper in the reader.", "effect": "read",
              "input_schema": {"type": "object", "properties": {"article_id": {"type": "string"}}, "required": ["article_id"]}}
HELLO = {"type": "hello", "token": "", "session_id": None, "client_tools": [OPEN_PAPER],
         "workspace": {"active_view": "library"}, "client": {"tts": True}}


def _drain_until(ws, wanted: str, *, collect: list | None = None, limit: int = 50) -> dict:
    for _ in range(limit):
        event = ws.receive_json()
        if collect is not None:
            collect.append(event)
        if event["type"] == wanted:
            return event
    raise AssertionError(f"never received {wanted}")


def test_hello_creates_a_persistent_assistant_session(client, monkeypatch):
    _model(monkeypatch, [])
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        session = ws.receive_json()
    assert session["type"] == "session" and session["user"]["id"] == "local-dev"
    assert session["client_tools"] == ["ui.open_paper"] and session["history"] == [] and session["pending_action"] is None
    assert session["catalog_tool_count"] > 50
    stored = agent_history.get_session(session["session_id"])["session"]
    assert stored["kind"] == "assistant"
    # Reconnecting without an id resumes the same session; the Agent tab does not list it.
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({**HELLO, "session_id": None})
        assert ws.receive_json()["session_id"] == session["session_id"]
    assert agent_history.list_sessions() == []
    assert [s["id"] for s in agent_history.list_sessions(kind="assistant")] == [session["session_id"]]


def test_new_session_starts_an_empty_one_instead_of_resuming(client, monkeypatch):
    """A reconnect and a "New session" click both arrive without a session_id."""
    _model(monkeypatch, ["Noted.\nSPEAK: Noted."])
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        first = ws.receive_json()["session_id"]
        ws.send_json({"type": "user_message", "id": "m-1", "text": "remember this", "source": "text", "workspace": {}})
        _drain_until(ws, "done")

    # A dropped socket must come back to the same conversation.
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({**HELLO, "session_id": None})
        resumed = ws.receive_json()
    assert resumed["session_id"] == first
    assert [h["role"] for h in resumed["history"]] == ["user", "assistant"]

    # Asking for a new session must not.
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({**HELLO, "session_id": None, "new_session": True})
        fresh = ws.receive_json()
    assert fresh["session_id"] != first
    assert fresh["history"] == []

    # The old session is kept, and the new one is what a later reconnect resumes.
    assert {s["id"] for s in agent_history.list_sessions(kind="assistant")} == {first, fresh["session_id"]}
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({**HELLO, "session_id": None})
        assert ws.receive_json()["session_id"] == fresh["session_id"]


def test_a_turn_streams_events_and_is_persisted(client, monkeypatch):
    model = _model(monkeypatch, [[("app_papers", {"query": "graph"})], "Found **Graph RAG**.\nSPEAK: I found Graph RAG."])
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        session = ws.receive_json()
        ws.send_json({"type": "user_message", "id": "m-1", "text": "which graph papers do I have?", "source": "voice",
                      "workspace": {"active_view": "chat", "reader": {"title": "Graph RAG for Science", "page": 3}}})
        events: list = []
        done = _drain_until(ws, "done", collect=events)
    types = [e["type"] for e in events]
    assert types[0] == "turn_start" and events[0]["message_id"] == "m-1" and events[0]["turn_id"] == "t-1"
    assert types[1] == "thinking" and "tool_start" in types and "tool_result" in types
    assert types[-3:] == ["speak", "answer", "done"] and done["status"] == "ok"
    answer = events[-2]
    assert answer["answer"] == "Found **Graph RAG**." and answer["spoken"] == "I found Graph RAG."
    # The turn saw the rich workspace and the activity digest.
    system = model.calls[0][0].content
    assert "page 3" in system and "Chat view" in system and "Earlier chat" in system and "spoken aloud" in system
    stored = agent_history.get_session(session["session_id"])["messages"]
    assert [m["role"] for m in stored] == ["user", "assistant"]
    assert stored[0]["meta"]["source"] == "voice" and stored[1]["meta"]["spoken"] == "I found Graph RAG."
    # History replays on the next hello.
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({**HELLO, "session_id": session["session_id"]})
        history = ws.receive_json()["history"]
    assert [h["role"] for h in history] == ["user", "assistant"] and history[1]["spoken"] == "I found Graph RAG."


def test_browser_tools_round_trip(client, monkeypatch):
    _model(monkeypatch, [[("ui_open_paper", {"article_id": "a1"})], "Opened.\nSPEAK: Opened it."])
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        ws.send_json({"type": "user_message", "text": "open the graph paper", "source": "text"})
        call = _drain_until(ws, "client_tool_call")
        assert call["tool"] == "open_paper" and call["arguments"] == {"article_id": "a1"}
        ws.send_json({"type": "client_tool_result", "call_id": call["call_id"], "ok": True, "result": {"opened": True}})
        events: list = []
        _drain_until(ws, "done", collect=events)
    result = next(e for e in events if e["type"] == "tool_result")
    assert result["tool"] == "ui.open_paper" and result["status"] == "success" and result["execution"] == "client"
    # A stale result id is reported, not fatal.
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        ws.send_json({"type": "client_tool_result", "call_id": "nope", "ok": True})
        assert ws.receive_json()["code"] == "bad_message"
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_confirmation_flow_yes_and_no(client, monkeypatch):
    executed = []

    async def fake_aexecute(name, arguments, workspace=None):
        executed.append((name, arguments))
        return {"status": "deleted"}

    monkeypatch.setattr(catalog, "aexecute_tool", fake_aexecute)
    delete_call = [("execute_tool", {"name": "api.notes.delete_note", "arguments": {"path": {"note_id": "n1"}}})]
    _model(monkeypatch, [
        delete_call, "Shall I delete note n1?\nSPEAK: Should I delete note n1?",
        "Done.\nSPEAK: The note is gone.",
        delete_call, "Shall I delete n2?\nSPEAK: Delete n2?",
        "Okay, left alone.\nSPEAK: Okay, I left it.",
    ])
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        ws.send_json({"type": "user_message", "text": "delete the note n1", "source": "voice"})
        events: list = []
        _drain_until(ws, "done", collect=events)
        confirmation = next(e for e in events if e["type"] == "confirmation_required")
        assert confirmation["tool"] == "api.notes.delete_note" and executed == []
        assert next(e for e in events if e["type"] == "tool_result")["status"] == "skipped"

        ws.send_json({"type": "confirm", "action_id": confirmation["action_id"], "approved": True})
        events = []
        _drain_until(ws, "done", collect=events)
        assert executed == [("api.notes.delete_note", {"path": {"note_id": "n1"}})]
        assert [e["type"] for e in events][:3] == ["turn_start", "tool_start", "tool_result"]
        assert events[2]["status"] == "success"
        assert next(e for e in events if e["type"] == "answer")["spoken"] == "The note is gone."

        ws.send_json({"type": "user_message", "text": "delete note n2", "source": "voice"})
        events = []
        _drain_until(ws, "done", collect=events)
        assert any(e["type"] == "confirmation_required" for e in events)
        ws.send_json({"type": "user_message", "text": "no", "source": "voice"})
        events = []
        _drain_until(ws, "done", collect=events)
    assert len(executed) == 1
    assert not any(e["type"] == "tool_start" for e in events)
    assert next(e for e in events if e["type"] == "answer")["spoken"] == "Okay, I left it."


def test_cancel_and_supersede_a_running_turn(client, monkeypatch):
    _model(monkeypatch, ["Second.\nSPEAK: Second.", "Third.\nSPEAK: Third."], cls=BlockingModel)
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        ws.send_json({"type": "user_message", "text": "first", "source": "text"})
        _drain_until(ws, "thinking")
        ws.send_json({"type": "cancel", "reason": "barge_in"})
        done = _drain_until(ws, "done")
        assert done["status"] == "cancelled" and done["reason"] == "barge_in" and done["turn_id"] == "t-1"

        ws.send_json({"type": "user_message", "text": "second", "source": "text"})
        events: list = []
        done = _drain_until(ws, "done", collect=events)
        assert done["status"] == "ok" and done["turn_id"] == "t-2"
        assert next(e for e in events if e["type"] == "answer")["answer"] == "Second."


def test_a_new_message_supersedes_the_running_turn(client, monkeypatch):
    _model(monkeypatch, ["Replaced.\nSPEAK: Replaced."], cls=BlockingModel)
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        ws.send_json({"type": "user_message", "text": "first", "source": "text"})
        _drain_until(ws, "thinking")
        ws.send_json({"type": "user_message", "text": "actually this", "source": "text"})
        events: list = []
        done = _drain_until(ws, "done", collect=events)
        assert done["status"] == "cancelled" and done["reason"] == "superseded" and done["turn_id"] == "t-1"
        events = []
        done = _drain_until(ws, "done", collect=events)
        assert done["status"] == "ok" and done["turn_id"] == "t-2"


def test_bad_frames_are_reported_and_the_socket_stays_open(client, monkeypatch):
    _model(monkeypatch, [])
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        ws.send_json({"type": "user_message"})
        error = ws.receive_json()
        assert error["type"] == "error" and error["code"] == "bad_message" and "user_message" in error["message"]
        ws.send_json({"type": "confirm", "approved": True})
        assert "No action is waiting" in ws.receive_json()["message"]
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_handshake_rejects_missing_tokens_bad_hellos_and_silence(client, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "supabase")
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({**HELLO, "token": ""})
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
    assert info.value.code == 4401

    monkeypatch.setenv("AUTH_MODE", "disabled")
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({"type": "ping"})
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
    assert info.value.code == 4400

    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({**HELLO, "client_tools": [{"name": "execute_tool"}]})
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
    assert info.value.code == 4400

    monkeypatch.setattr(connection, "HELLO_TIMEOUT_SECONDS", 0.05)
    with client.websocket_connect("/agent/ws") as ws:
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
    assert info.value.code == 4401


def test_auth_refresh_must_be_the_same_user(client, monkeypatch):
    _model(monkeypatch, [])
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        ws.send_json({"type": "auth", "token": "anything-in-disabled-mode"})
        assert ws.receive_json()["type"] == "auth_ok"
        monkeypatch.setenv("AUTH_MODE", "supabase")
        ws.send_json({"type": "auth", "token": ""})
        error = ws.receive_json()
        assert error["type"] == "error" and error["code"] == "unauthorized"

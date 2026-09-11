"""The assistant's async loop: streamed events, browser tools, confirmations.

The model is scripted and streams `AIMessageChunk`s, so tool-call chunk
aggregation is exercised without a provider; the catalog is real.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, List

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk

from app.agents import catalog, runtime
from app.agents.assistant.client_tools import ClientToolExecutor
from app.agents.assistant.confirmations import PendingActions, explicit_guard
from app.storage import article_store, notes


class StreamingScriptedModel:
    """Replays a script; tool-call arguments are streamed split across chunks."""

    def __init__(self, script: List[Any]) -> None:
        self.script = list(script)
        self.calls: List[List[Any]] = []
        self.bound_tools: List[dict] = []

    def bind_tools(self, tools, **_kwargs):
        self.bound_tools = list(tools)
        return self

    def invoke(self, messages, **_kwargs):
        self.calls.append(list(messages))
        step = self.script.pop(0) if self.script else "No script left."
        if isinstance(step, str):
            return AIMessage(content=step)
        return AIMessage(content="", tool_calls=[
            {"id": f"call_{i}", "name": name, "args": args, "type": "tool_call"} for i, (name, args) in enumerate(step)
        ])

    async def astream(self, messages, **_kwargs):
        self.calls.append(list(messages))
        step = self.script.pop(0) if self.script else "No script left."
        if isinstance(step, str):
            for i in range(0, len(step), 7):
                yield AIMessageChunk(content=step[i:i + 7])
            return
        for index, (name, args) in enumerate(step):
            payload = json.dumps(args)
            half = max(1, len(payload) // 2)
            yield AIMessageChunk(content="", tool_call_chunks=[
                {"name": name, "args": payload[:half], "id": f"call_{index}", "index": index, "type": "tool_call_chunk"},
            ])
            yield AIMessageChunk(content="", tool_call_chunks=[
                {"name": None, "args": payload[half:], "id": None, "index": index, "type": "tool_call_chunk"},
            ])


@pytest.fixture(scope="module", autouse=True)
def app():
    from app.main import app as application

    return application


@pytest.fixture(autouse=True)
def stub_library(monkeypatch):
    papers = [
        {"article_id": "a1", "title": "Graph RAG for Science", "source": "graph.pdf", "url": "http://x/1",
         "domain": "research", "category": "nlp", "status": "indexed", "tags": ["rag"], "abstract": "retrieval over graphs"},
    ]
    monkeypatch.setattr(article_store, "list_articles", lambda domain=None, category=None, limit=100: papers)
    monkeypatch.setattr(article_store, "list_domains", lambda: [{"domain": "research", "category": "nlp", "article_count": 1}])
    monkeypatch.setattr(notes, "list_notion_targets", lambda: [])


OPEN_PAPER = {"name": "open_paper", "description": "Open a paper in the reader.", "effect": "read",
              "input_schema": {"type": "object", "properties": {"article_id": {"type": "string"}}, "required": ["article_id"]}}


def _collect(monkeypatch, script, question="hello", *, on_event=None, **kwargs):
    model = StreamingScriptedModel(script)
    monkeypatch.setattr(runtime, "get_llm", lambda *a, **k: model)
    events: List[dict] = []

    async def emit(event):
        events.append(event)
        if on_event:
            await on_event(event)

    state = {"question": question, "chat_history": [], "pinned_sources": [], **kwargs.pop("state", {})}
    result = asyncio.run(runtime.arun_agent(state, emit=emit, turn_id="t-1", **kwargs))
    return result, events, model


def test_events_stream_in_order_and_the_spoken_line_is_split_off(monkeypatch):
    script = [
        [("app_papers", {"query": "graph"})],
        "Found **Graph RAG for Science** in your library.\nSPEAK: I found Graph RAG for Science.",
    ]
    result, events, model = _collect(monkeypatch, script, question="which graph papers do I have?")
    types = [e["type"] for e in events]
    assert types[:4] == ["thinking", "tool_start", "tool_result", "thinking"]
    assert types[-2:] == ["speak", "answer"]
    assert "token" in types
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert tokens == "Found **Graph RAG for Science** in your library."
    assert result["answer"] == "Found **Graph RAG for Science** in your library."
    assert result["spoken"] == "I found Graph RAG for Science."
    # Looking papers up is reading, not acting (same rule as the Agent tab); sources are still cited.
    assert result["intent"] == "chat" and result["sources"][0]["title"] == "Graph RAG for Science"
    start = next(e for e in events if e["type"] == "tool_start")
    assert start["tool"] == "app_papers" and start["say"] == "Searching your library for 'graph'" and start["turn_id"] == "t-1"
    done = next(e for e in events if e["type"] == "tool_result")
    assert done["status"] == "success" and done["message"] == "1 papers" and done["duration_ms"] >= 0
    # The streamed tool call was aggregated from two argument chunks.
    tool_messages = [m for m in model.calls[1] if m.type == "tool"]
    assert tool_messages and "Graph RAG for Science" in tool_messages[0].content


def test_missing_marker_falls_back_to_a_derived_spoken_line(monkeypatch):
    result, events, _ = _collect(monkeypatch, ["## Summary\n\n- **Graph RAG** helps. Really.\n- Second point."])
    assert result["spoken"] == "Graph RAG helps. Really."
    assert [e["type"] for e in events][-2:] == ["speak", "answer"]


def test_assistant_prompt_describes_screen_controls_context_and_activity(monkeypatch):
    workspace = {"active_view": "notes", "open_note": {"id": "n1", "title": "Graph ideas"},
                 "reader": {"title": "Graph RAG for Science", "page": 4, "total_pages": 12}}
    _, _, model = _collect(
        monkeypatch, ["ok\nSPEAK: ok"], state={"workspace": workspace},
        client_tools={"open_paper": OPEN_PAPER}, activity={"chat_sessions": ["Graph questions"], "notes": ["Graph ideas"], "note_count": 3},
    )
    system = model.calls[0][0].content
    assert "# Screen controls" in system and "ui_open_paper (article_id)" in system
    assert "The user is on the Notes view" in system and "Open note: 'Graph ideas'" in system
    assert "page 4 of 12" in system
    assert "Recent chats: Graph questions" in system and "Notes (3 total)" in system
    assert "SPEAK:" in system and "api.notes.create_note" in system
    assert {t["function"]["name"] for t in model.bound_tools} >= {"execute_tool", "ui_open_paper"}


def test_client_tools_round_trip_through_the_executor(monkeypatch):
    executor = ClientToolExecutor(timeout=2)

    async def answer_browser(event):
        if event["type"] == "client_tool_call":
            assert event["tool"] == "open_paper" and event["arguments"] == {"article_id": "a1"}
            executor.resolve(event["call_id"], result={"opened": True, "title": "Graph RAG for Science"})

    script = [[("ui_open_paper", {"article_id": "a1"})], "Opened it.\nSPEAK: Opened it."]
    result, events, model = _collect(monkeypatch, script, question="open the graph paper", on_event=answer_browser,
                                     client_tools={"open_paper": OPEN_PAPER}, client_executor=executor)
    trace = result["tool_trace"]
    assert trace[0]["tool"] == "ui.open_paper" and trace[0]["status"] == "success" and trace[0]["execution"] == "client"
    assert result["intent"] == "agent"
    start = next(e for e in events if e["type"] == "tool_start")
    assert start["execution"] == "client" and start["say"] == "Open a paper in the reader"
    tool_message = [m for m in model.calls[1] if m.type == "tool"][0]
    assert json.loads(tool_message.content) == {"opened": True, "title": "Graph RAG for Science"}


def test_a_silent_browser_becomes_a_tool_error_the_model_can_see(monkeypatch):
    executor = ClientToolExecutor(timeout=0.05)
    script = [[("ui_open_paper", {"article_id": "a1"})], "The screen did not respond.\nSPEAK: The screen did not respond."]
    result, events, model = _collect(monkeypatch, script, client_tools={"open_paper": OPEN_PAPER}, client_executor=executor)
    assert result["tool_trace"][0]["status"] == "error" and "did not respond" in result["tool_trace"][0]["message"]
    assert next(e for e in events if e["type"] == "tool_result")["status"] == "error"
    assert "did not respond" in [m for m in model.calls[1] if m.type == "tool"][0].content


def test_explicit_guard_parks_the_action_and_announces_it(monkeypatch):
    calls = []

    async def fake_aexecute(name, arguments, workspace=None):
        calls.append((name, arguments))
        return {"status": "deleted"}

    monkeypatch.setattr(catalog, "aexecute_tool", fake_aexecute)
    store = PendingActions(ttl=60)
    script = [[("execute_tool", {"name": "api.notes.delete_note", "arguments": {"path": {"note_id": "n1"}}})],
              "Shall I delete note n1?\nSPEAK: Should I delete note n1?"]
    result, events, _ = _collect(monkeypatch, script, question="delete the note n1", guard=explicit_guard(store, "s1"))
    assert calls == []
    assert result["tool_trace"][0]["status"] == "skipped"
    confirmation = next(e for e in events if e["type"] == "confirmation_required")
    assert confirmation["tool"] == "api.notes.delete_note" and confirmation["effect"] == "destructive"
    assert store.get("s1").id == confirmation["action_id"]


def test_a_confirmed_action_runs_first_without_the_guard(monkeypatch):
    calls = []

    async def fake_aexecute(name, arguments, workspace=None):
        calls.append((name, arguments))
        return {"status": "deleted"}

    monkeypatch.setattr(catalog, "aexecute_tool", fake_aexecute)
    refuse_everything = lambda tool, arguments: {"requires_confirmation": True, "error": "no"}
    action = {"id": "pa-1", "tool": "api.notes.delete_note", "arguments": {"path": {"note_id": "n1"}}, "effect": "destructive"}
    result, events, model = _collect(monkeypatch, ["Deleted note n1.\nSPEAK: Done, the note is gone."], question="yes",
                                     guard=refuse_everything, state={"resume_action": action})
    assert calls == [("api.notes.delete_note", {"path": {"note_id": "n1"}})]
    assert result["tool_trace"][0]["status"] == "success" and result["tool_trace"][0]["effect"] == "destructive"
    assert result["intent"] == "agent"
    assert "The user confirmed" in model.calls[0][-1].content
    assert [e["type"] for e in events][:2] == ["tool_start", "tool_result"]


def test_astream_agent_yields_the_same_events(monkeypatch):
    model = StreamingScriptedModel(["Hi.\nSPEAK: Hi."])
    monkeypatch.setattr(runtime, "get_llm", lambda *a, **k: model)

    async def go():
        return [e async for e in runtime.astream_agent({"question": "hi", "chat_history": [], "pinned_sources": []})]

    events = asyncio.run(go())
    assert [e["type"] for e in events] == ["thinking", "token", "speak", "answer"]
    assert events[-1]["answer"] == "Hi." and events[-1]["spoken"] == "Hi."

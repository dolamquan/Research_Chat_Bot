"""The tool-calling loop: dispatch, tracing, sources, guardrails and limits.

The chat model is scripted, so these tests never reach a provider; the
catalog is real, so `execute_tool` exercises the application's own routes.
"""

from __future__ import annotations

from typing import Any, List

import pytest
from langchain_core.messages import AIMessage

from app.agents import catalog, runtime
from app.storage import article_store, notes


class ScriptedToolModel:
    """A chat model that replays a script of tool calls and final answers."""

    def __init__(self, script: List[Any]) -> None:
        self.script = list(script)
        self.calls: List[List[Any]] = []
        self.bound_tools: List[dict] = []

    def bind_tools(self, tools, **_kwargs):
        self.bound_tools = list(tools)
        return self

    def invoke(self, messages, **_kwargs):
        self.calls.append(list(messages))
        if not self.script:
            return AIMessage(content="No script left.")
        step = self.script.pop(0)
        if isinstance(step, str):
            return AIMessage(content=step)
        return AIMessage(content="", tool_calls=[
            {"id": f"call_{index}", "name": name, "args": args, "type": "tool_call"}
            for index, (name, args) in enumerate(step)
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


def _run(monkeypatch, script, question="hello", **state):
    model = ScriptedToolModel(script)
    monkeypatch.setattr(runtime, "get_llm", lambda *args, **kwargs: model)
    result = runtime.run_agent({"question": question, "chat_history": [], "pinned_sources": [], **state})
    return result, model


def test_plain_answer_uses_no_tools(monkeypatch):
    result, model = _run(monkeypatch, ["Hi! I can operate every part of Zoetrope."], question="what can you do?")
    assert result["answer"].startswith("Hi!")
    assert result["tool_trace"] == []
    assert result["intent"] == "chat"
    assert {t["function"]["name"] for t in model.bound_tools} == {
        "discover_tools", "describe_tool", "execute_tool", "app_context", "app_papers", "answer_from_papers",
    }


def test_system_prompt_carries_app_overview_and_tool_index(monkeypatch):
    _, model = _run(monkeypatch, ["ok"], question="hi", workspace={"selected_paper": {"title": "Graph RAG for Science"}},
                    document_source="graph.pdf")
    system = model.calls[0][0].content
    assert "Papers indexed: 1" in system
    assert "api.notes.create_note" in system
    assert "research.search_papers" in system
    assert "Graph RAG for Science" in system and "graph.pdf" in system
    assert "Notes:" in system and "Visualizer:" in system


def test_tool_calls_are_executed_traced_and_cited(monkeypatch):
    script = [
        [("app_papers", {"query": "graph"})],
        [("execute_tool", {"name": "api.health.health_check", "arguments": {}})],
        "Found **Graph RAG for Science** and the backend is healthy.",
    ]
    result, model = _run(monkeypatch, script, question="which graph papers do I have?")
    assert result["answer"].startswith("Found")
    assert result["intent"] == "agent"
    tools = [(step["tool"], step["status"]) for step in result["tool_trace"]]
    assert tools == [("app_papers", "success"), ("api.health.health_check", "success")]
    assert result["tool_trace"][0]["message"] == "1 papers"
    assert result["tool_trace"][1]["effect"] == "read"
    assert result["sources"][0]["title"] == "Graph RAG for Science"
    assert result["sources"][0]["topic"] == "papers"
    # The model saw the tool output as a ToolMessage with the right id.
    tool_messages = [m for m in model.calls[1] if m.type == "tool"]
    assert tool_messages and tool_messages[0].tool_call_id == "call_0"
    assert "Graph RAG for Science" in tool_messages[0].content


def test_unknown_or_invalid_tools_return_errors_to_the_model(monkeypatch):
    script = [
        [("execute_tool", {"name": "api.nope.missing", "arguments": {}})],
        [("execute_tool", {"name": "app.papers", "arguments": {"limit": "x"}})],
        "I could not find that tool.",
    ]
    result, model = _run(monkeypatch, script)
    statuses = [step["status"] for step in result["tool_trace"]]
    assert statuses == ["error", "error"]
    first_tool_message = [m for m in model.calls[1] if m.type == "tool"][0]
    assert "Unknown application tool" in first_tool_message.content
    second_tool_message = [m for m in model.calls[2] if m.type == "tool"][-1]
    assert "input_schema" in second_tool_message.content


def test_destructive_tools_need_the_users_words(monkeypatch):
    calls: List[tuple] = []
    monkeypatch.setattr(catalog, "execute_tool", lambda name, arguments, workspace=None: calls.append((name, arguments)) or {"status": "deleted"})

    script = [[("execute_tool", {"name": "api.notes.delete_note", "arguments": {"path": {"note_id": "n1"}}})], "I need confirmation."]
    result, _ = _run(monkeypatch, script, question="tidy up my notes about graphs")
    assert calls == []
    assert result["tool_trace"][0]["status"] == "skipped"
    assert "confirm" in result["tool_trace"][0]["message"].lower()

    script = [[("execute_tool", {"name": "api.notes.delete_note", "arguments": {"path": {"note_id": "n1"}}})], "Deleted."]
    result, _ = _run(monkeypatch, script, question="delete the note n1")
    assert calls == [("api.notes.delete_note", {"path": {"note_id": "n1"}})]
    assert result["tool_trace"][0]["status"] == "success"
    assert result["tool_trace"][0]["effect"] == "destructive"


def test_external_writes_need_the_users_words(monkeypatch):
    monkeypatch.setenv("NOTION_API_KEY", "test")
    monkeypatch.setattr(catalog, "execute_tool", lambda name, arguments, workspace=None: {"url": "https://notion.so/p"})
    def script():
        return [[("execute_tool", {"name": "notion.create_research_page", "arguments": {"title": "x"}})], "done"]

    result, _ = _run(monkeypatch, script(), question="summarize this paper")
    assert result["tool_trace"][0]["status"] == "skipped"
    result, _ = _run(monkeypatch, script(), question="export this summary to notion")
    assert result["tool_trace"][0]["status"] == "success"
    assert result["tool_trace"][0]["effect"] == "external_write"


def test_answer_from_papers_uses_rag_and_collects_sources(monkeypatch):
    seen = {}

    def fake_generate_answer(**kwargs):
        seen.update(kwargs)
        return {"answer": "Graphs help retrieval.", "sources": [{"id": "s1", "title": "Graph RAG for Science", "text": "..."}]}

    monkeypatch.setattr(runtime, "generate_answer", fake_generate_answer)
    script = [[("answer_from_papers", {"question": "how does graph rag work?"})], "Graphs help retrieval [Graph RAG for Science]."]
    result, _ = _run(monkeypatch, script, question="how does graph rag work?", document_source="graph.pdf", cluster_id=3)
    assert seen["query"] == "how does graph rag work?"
    assert seen["document_source"] == "graph.pdf" and seen["cluster_id"] == 3
    assert result["sources"] == [{"id": "s1", "title": "Graph RAG for Science", "text": "..."}]
    assert result["tool_trace"][0]["tool"] == "answer_from_papers"


def test_step_limit_forces_a_final_answer(monkeypatch):
    monkeypatch.setenv("AGENT_MAX_STEPS", "2")
    script = [
        [("app_context", {})],
        [("app_context", {})],
        "Here is what I gathered.",
        [("app_context", {})],  # never reached: the loop stops after two tool turns
    ]
    result, model = _run(monkeypatch, script)
    assert result["answer"] == "Here is what I gathered."
    assert result["tool_trace"][-1]["status"] == "skipped"
    assert "limit" in result["tool_trace"][-1]["message"]
    assert len(model.calls) == 3  # two tool turns plus the forced final answer
    assert "do not call tools" in model.calls[-1][-1].content
    assert model.script == [[("app_context", {})]]


def test_model_that_keeps_calling_tools_past_the_limit_gets_a_fallback(monkeypatch):
    monkeypatch.setenv("AGENT_MAX_STEPS", "1")
    script = [[("app_context", {})], [("app_context", {})]]
    result, _ = _run(monkeypatch, script)
    assert "app_context" in result["answer"]
    assert [step["status"] for step in result["tool_trace"]] == ["success", "skipped"]


def test_history_is_replayed_and_topology_surfaced(monkeypatch):
    monkeypatch.setattr(catalog, "execute_tool", lambda name, arguments, workspace=None: {"topology": {"nodes": []}, "summary": "Rebuilt topology."})
    script = [[("execute_tool", {"name": "research.rebuild_topology", "arguments": {}})], "Rebuilt."]
    result, model = _run(monkeypatch, script, question="rebuild topology",
                         chat_history=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}])
    assert result["topology"] == {"nodes": []}
    assert result["tool_trace"][0]["message"] == "Rebuilt topology."
    roles = [m.type for m in model.calls[0]]
    assert roles == ["system", "human", "ai", "human"]

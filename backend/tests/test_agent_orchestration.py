"""Parallel tool calls, delegation to workers and playbooks in the Agent tab's loop.

Same setup as test_agent_runtime: a scripted model (shared by the main loop
and its workers, which pop from the same script in turn) and the real catalog.
"""

from __future__ import annotations

import json
import threading

import pytest

from app.agents import catalog, runtime
from app.storage import article_store, notes
from tests.test_agent_runtime import ScriptedToolModel


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


def _tool_messages(model, call_index):
    return [m for m in model.calls[call_index] if m.type == "tool"]


# --- parallel tool calls -------------------------------------------------------------

def test_tool_calls_in_one_turn_run_concurrently_and_keep_their_order(monkeypatch):
    barrier = threading.Barrier(2, timeout=5)  # both calls must be in flight at once

    def fake_execute(name, arguments, workspace=None):
        barrier.wait()
        return {"ran": name}

    monkeypatch.setattr(catalog, "execute_tool", fake_execute)
    script = [
        [("execute_tool", {"name": "api.health.health_check", "arguments": {}}),
         ("execute_tool", {"name": "app.papers", "arguments": {"query": "graph"}})],
        "Both done.",
    ]
    result, model = _run(monkeypatch, script)
    assert result["answer"] == "Both done."
    assert sorted(step["tool"] for step in result["tool_trace"]) == ["api.health.health_check", "app.papers"]
    tool_messages = _tool_messages(model, 1)
    assert [m.tool_call_id for m in tool_messages] == ["call_0", "call_1"]
    assert "api.health.health_check" in tool_messages[0].content and "app.papers" in tool_messages[1].content


def test_parallelism_can_be_switched_off(monkeypatch):
    monkeypatch.setenv("AGENT_PARALLEL_TOOLS", "1")
    seen = []
    monkeypatch.setattr(catalog, "execute_tool", lambda name, arguments, workspace=None: seen.append(name) or {"ran": name})
    script = [[("execute_tool", {"name": "api.health.health_check", "arguments": {}}),
               ("execute_tool", {"name": "app.papers", "arguments": {}})], "ok"]
    _run(monkeypatch, script)
    assert seen == ["api.health.health_check", "app.papers"]


# --- delegation -------------------------------------------------------------------------

def test_delegate_runs_workers_that_report_back_and_cannot_delegate_again(monkeypatch):
    script = [
        [("delegate", {"tasks": [{"task": "Find the graph paper and summarize it", "label": "graph summary"}]})],
        [("app_papers", {"query": "graph"})],                          # the worker's tool call
        "Graph RAG for Science (a1) retrieves over concept graphs.",   # the worker's report
        "Here is the summary from my worker.",                         # the main loop's answer
    ]
    result, model = _run(monkeypatch, script, question="summarize my graph paper")
    assert result["answer"] == "Here is the summary from my worker."
    assert result["intent"] == "chat"  # the worker only read; nothing was changed
    trace = result["tool_trace"]
    assert [(t["tool"], t["status"], t.get("parent")) for t in trace] == [
        ("app_papers", "success", "graph summary"), ("delegate", "success", None),
    ]
    assert trace[1]["message"] == "1 of 1 workers finished"
    # The worker's sources are the main loop's sources.
    assert result["sources"][0]["title"] == "Graph RAG for Science"
    # The main loop received the report, not the worker's raw tool output.
    report = json.loads(_tool_messages(model, -1)[0].content)
    worker = report["reports"][0]
    assert worker["status"] == "ok" and worker["label"] == "graph summary" and worker["steps_used"] == 2
    assert worker["report"].startswith("Graph RAG for Science") and worker["tools"] == ["app_papers"]
    assert "_sources" not in worker and report["summary"] == "1 of 1 workers finished"
    # The worker got its own prompt and a tool set without delegate/run_playbook.
    worker_system = model.calls[1][0].content
    assert "You are a worker" in worker_system and "delegated ONE task" in worker_system
    assert "api.notes.create_note" in worker_system and "Papers indexed: 1" in worker_system
    assert model.calls[1][-1].content == "Find the graph paper and summarize it"
    assert "delegate" not in {t["function"]["name"] for t in model.bound_tools}
    assert "run_playbook" not in {t["function"]["name"] for t in model.bound_tools}


def test_several_workers_run_and_all_report(monkeypatch):
    script = [
        [("delegate", {"tasks": [{"task": "task one", "label": "one"}, {"task": "task two", "label": "two"}, "task three"]})],
        "report", "report", "report",
        "All three reported.",
    ]
    result, model = _run(monkeypatch, script)
    assert len(model.calls) == 5  # main, three workers, main
    report = json.loads(_tool_messages(model, -1)[0].content)
    assert report["summary"] == "3 of 3 workers finished"
    assert [r["label"] for r in report["reports"]] == ["one", "two", "worker 3"]
    assert all(r["status"] == "ok" and r["report"] == "report" for r in report["reports"])
    assert result["tool_trace"][-1]["tool"] == "delegate"


def test_workers_never_delete_or_publish(monkeypatch):
    calls = []

    async def fake_aexecute(name, arguments, workspace=None):
        calls.append(name)
        return {"status": "deleted"}

    monkeypatch.setattr(catalog, "aexecute_tool", fake_aexecute)
    script = [
        [("delegate", {"tasks": [{"task": "Delete note n1"}]})],
        [("execute_tool", {"name": "api.notes.delete_note", "arguments": {"path": {"note_id": "n1"}}})],
        "I cannot delete; the main agent must run api.notes.delete_note for n1.",
        "Deleting note n1 needs your confirmation.",
    ]
    result, model = _run(monkeypatch, script, question="delete note n1")
    assert calls == []
    refused = result["tool_trace"][0]
    assert refused["tool"] == "api.notes.delete_note" and refused["status"] == "skipped" and refused["parent"] == "worker 1"
    assert "workers cannot run it" in _tool_messages(model, 2)[0].content


def test_a_worker_that_runs_out_of_steps_is_told_to_report(monkeypatch):
    monkeypatch.setenv("AGENT_WORKER_MAX_STEPS", "1")
    script = [
        [("delegate", {"tasks": [{"task": "keep looking"}]})],
        [("app_papers", {"query": "graph"})],   # the worker's only allowed step
        "Ran out of steps; found Graph RAG for Science.",  # the forced report
        "Done.",
    ]
    result, model = _run(monkeypatch, script)
    report = json.loads(_tool_messages(model, -1)[0].content)["reports"][0]
    assert report["status"] == "ok" and report["report"].startswith("Ran out of steps")
    assert "do not call tools" in model.calls[2][-1].content


def test_delegate_rejects_bad_task_lists(monkeypatch):
    script = [[("delegate", {"tasks": []})], [("delegate", {"tasks": [{"label": "no task"}]})], "Nothing to delegate."]
    result, model = _run(monkeypatch, script)
    assert [t["status"] for t in result["tool_trace"]] == ["error", "error"]
    assert "non-empty 'tasks'" in _tool_messages(model, 1)[0].content
    assert "tasks[0] needs a non-empty 'task'" in _tool_messages(model, 2)[-1].content


# --- playbooks ---------------------------------------------------------------------------

QUICK_PLAYBOOK = """
name: quick_check
description: Look a paper up, check the backend, brief the paper.
parameters:
  type: object
  properties:
    q: {type: string}
  required: [q]
steps:
  - id: papers
    title: Find the paper
    group: lookups
    tool: app_papers
    arguments: {query: "{{params.q}}"}
  - id: health
    title: Check the backend
    group: lookups
    tool: api.health.health_check
    arguments: {}
  - id: brief
    title: Brief the paper
    agent: "Brief {{steps.papers.result.papers.0.title}} ({{steps.papers.result.papers.0.article_id}})."
report: "Summarize the quick check for {{params.q}}: {{steps.brief.result}}"
"""


def test_run_playbook_executes_steps_workers_and_reports(monkeypatch, tmp_path):
    (tmp_path / "quick_check.yaml").write_text(QUICK_PLAYBOOK, encoding="utf-8")
    monkeypatch.setenv("AGENT_PLAYBOOKS_DIR", str(tmp_path))
    script = [
        [("run_playbook", {"name": "quick_check", "params": {"q": "graph"}})],
        "Graph RAG for Science builds retrieval over concept graphs.",  # the brief worker's report
        "Quick check done.",
    ]
    result, model = _run(monkeypatch, script, question="quick check on graph")
    assert result["answer"] == "Quick check done."
    trace = [(t["tool"], t["status"], t.get("parent")) for t in result["tool_trace"]]
    assert ("app_papers", "success", "quick_check") in trace and ("api.health.health_check", "success", "quick_check") in trace
    assert trace[-1] == ("playbook: quick_check", "success", None)
    assert result["sources"][0]["title"] == "Graph RAG for Science"
    payload = json.loads(_tool_messages(model, -1)[0].content)
    assert payload["playbook"] == "quick_check" and payload["status"] == "completed"
    assert [(s["id"], s["status"]) for s in payload["steps"]] == [("papers", "success"), ("health", "success"), ("brief", "success")]
    assert payload["report_instructions"] == "Summarize the quick check for graph: Graph RAG for Science builds retrieval over concept graphs."
    assert result["tool_trace"][-1]["message"] == "3 of 3 steps succeeded"
    # The worker's task was rendered from the earlier step's result.
    assert model.calls[1][-1].content == "Brief Graph RAG for Science (a1)."
    # The prompt advertised the playbook next to the built-ins.
    assert "quick_check(q)" in model.calls[0][0].content and "literature_review(topic" in model.calls[0][0].content


def test_run_playbook_reports_unknown_names_and_bad_params(monkeypatch):
    script = [
        [("run_playbook", {"name": "nope"})],
        [("run_playbook", {"name": "literature_review", "params": {}})],
        "Could not run that.",
    ]
    result, model = _run(monkeypatch, script)
    assert [t["status"] for t in result["tool_trace"]] == ["error", "error"]
    assert "Unknown playbook 'nope'" in _tool_messages(model, 1)[0].content
    assert "Invalid params for playbook literature_review" in _tool_messages(model, 2)[-1].content


def test_playbook_steps_respect_the_users_confirmation_rule(monkeypatch, tmp_path):
    (tmp_path / "wipe.yaml").write_text(
        "name: wipe\nsteps:\n  - {id: look, tool: app_papers, arguments: {query: graph}}\n"
        "  - {id: wipe, title: Delete the note, tool: api.notes.delete_note, arguments: {path: {note_id: n1}}}\n"
        "  - {id: after, title: Look again, tool: app_papers}\n", encoding="utf-8")
    monkeypatch.setenv("AGENT_PLAYBOOKS_DIR", str(tmp_path))
    calls = []

    async def fake_aexecute(name, arguments, workspace=None):
        calls.append(name)
        return {"status": "deleted"}

    monkeypatch.setattr(catalog, "aexecute_tool", fake_aexecute)
    script = [[("run_playbook", {"name": "wipe"})], "The playbook stopped before deleting; shall I?"]
    result, model = _run(monkeypatch, script, question="tidy things up")
    assert calls == []
    payload = json.loads(_tool_messages(model, 1)[0].content)
    assert payload["status"] == "stopped" and "Look again" in payload["stopped_reason"]
    assert [s["status"] for s in payload["steps"]] == ["success", "skipped"]
    # The same request phrased as a deletion lets the step run (the Agent tab's keyword rule).
    calls.clear()
    script = [[("run_playbook", {"name": "wipe"})], "Deleted and looked again."]
    result, model = _run(monkeypatch, script, question="delete note n1 with the wipe playbook")
    assert calls == ["api.notes.delete_note"]
    payload = json.loads(_tool_messages(model, 1)[0].content)
    assert payload["status"] == "completed" and [s["status"] for s in payload["steps"]] == ["success", "success", "success"]

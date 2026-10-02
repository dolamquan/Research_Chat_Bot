"""The run buffer: what one assistant turn records, and how runs are stored and pruned."""

from __future__ import annotations

import asyncio
from typing import List

import pytest
from langchain_core.messages import AIMessage

from app.agents import run_log, runtime
from app.storage import agent_runs
from tests.test_assistant_runtime import StreamingScriptedModel, app, stub_library  # noqa: F401  (fixtures)


def _record_turn(monkeypatch, script) -> dict:
    model = StreamingScriptedModel(script)
    monkeypatch.setattr(runtime, "get_llm", lambda *a, **k: model)
    sent: List[dict] = []

    async def send(frame):
        sent.append(frame)

    async def turn():
        recorder = run_log.RunRecorder(session_id="s-1", turn_id="t-1", question="which graph papers?")
        token = run_log.start(recorder)
        try:
            await runtime.arun_agent({"question": "which graph papers?", "chat_history": [], "pinned_sources": []},
                                     emit=recorder.wrap(send), turn_id="t-1")
        finally:
            run_log.stop(token)
        return recorder.summary("ok")

    summary = asyncio.run(turn())
    assert sent, "the recorder must still forward every frame to the client"
    return summary


def test_a_turn_records_each_model_step_tool_call_and_the_answer(monkeypatch):
    summary = _record_turn(monkeypatch, [
        [("app_papers", {"query": "graph"})],
        "Found **Graph RAG for Science**.\nSPEAK: I found Graph RAG for Science.",
    ])

    kinds = [event["kind"] for event in summary["events"]]
    assert kinds[:2] == ["run_config", "prompt_built"]
    assert kinds.count("model_step") == 2
    for kind in ("tool_start", "tool_output", "tool_result", "answer"):
        assert kind in kinds
    first_step = next(e for e in summary["events"] if e["kind"] == "model_step")
    assert first_step["tool_calls"] == ["app_papers"] and first_step["ms"] >= 0
    output = next(e for e in summary["events"] if e["kind"] == "tool_output")
    assert output["tool"] == "app_papers" and "Graph RAG for Science" in output["output"]
    assert summary["steps"] == 2 and summary["tool_calls"] == 1 and summary["errors"] == 0
    assert summary["answer"].startswith("Found **Graph RAG")
    assert [e["t_ms"] for e in summary["events"]] == sorted(e["t_ms"] for e in summary["events"])


def test_recording_is_a_no_op_outside_a_turn():
    run_log.note("anything", value=1)
    run_log.note_tool_output("c1", "tool", {"big": "x" * 5000})
    assert run_log.current() is None


def test_usage_reads_cached_and_reasoning_tokens():
    message = AIMessage(content="ok", usage_metadata={
        "input_tokens": 6000, "output_tokens": 120, "total_tokens": 6120,
        "input_token_details": {"cache_read": 4864}, "output_token_details": {"reasoning": 64},
    })
    assert run_log.usage_of(message) == {"input": 6000, "cached": 4864, "output": 120, "reasoning": 64}
    assert run_log.usage_of(AIMessage(content="no usage")) == {}


@pytest.fixture
def run_store(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_runs, "DB_PATH", tmp_path / "agent_runs.sqlite3")
    monkeypatch.setattr(agent_runs, "MAX_RUNS_PER_OWNER", 3)
    return agent_runs


def _run(question: str, **extra) -> dict:
    return {"session_id": "s-1", "turn_id": question, "question": question, "status": "ok", "total_ms": 1200,
            "model_ms": 900, "steps": 2, "tool_calls": 1, "errors": 0, "model": "gpt-5",
            "tokens": {"input": 10, "cached": 0, "output": 5, "reasoning": 0},
            "events": [{"t_ms": 0, "kind": "run_config"}], **extra}


def test_runs_are_kept_newest_first_and_pruned_to_the_buffer_size(run_store):
    for index in range(5):
        run_store.save_run(_run(f"q{index}"), owner_id="u1")

    runs = run_store.list_runs(owner_id="u1")
    assert [run["question"] for run in runs] == ["q4", "q3", "q2"]
    assert runs[0]["tokens"]["input"] == 10 and "events" not in runs[0]
    detail = run_store.get_run(runs[0]["id"], owner_id="u1")
    assert detail["events"] == [{"t_ms": 0, "kind": "run_config"}]


def test_runs_are_private_to_their_owner(run_store):
    mine = run_store.save_run(_run("mine"), owner_id="u1")
    run_store.save_run(_run("theirs", status="error"), owner_id="u2")

    assert [run["question"] for run in run_store.list_runs(owner_id="u1")] == ["mine"]
    assert [run["question"] for run in run_store.list_runs(owner_id="u2", status="error")] == ["theirs"]
    with pytest.raises(ValueError):
        run_store.get_run(mine, owner_id="u2")

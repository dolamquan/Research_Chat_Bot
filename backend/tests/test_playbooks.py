"""Playbooks: loading, templating, parameters and the step runner.

The runner is exercised with fakes for the two things the runtime supplies
(a tool caller and a worker runner), so concurrency, fan-out, conditions and
the confirmation stop are tested without a model or the catalog.
"""

from __future__ import annotations

import asyncio
import textwrap
from typing import Any, Dict, List

import pytest
import yaml

from app.agents import playbooks


BUILTINS = {"literature_review", "paper_deep_dive", "compare_papers", "ingest_and_map"}


@pytest.fixture(autouse=True)
def builtin_dirs_only(monkeypatch):
    monkeypatch.delenv(playbooks.PLAYBOOKS_DIR_ENV, raising=False)
    playbooks.load_playbooks(refresh=True)
    yield
    playbooks.load_playbooks(refresh=True)


def _playbook(text: str) -> playbooks.Playbook:
    return playbooks.parse_playbook(yaml.safe_load(textwrap.dedent(text)))


def test_builtin_playbooks_load_and_describe_themselves():
    loaded = playbooks.load_playbooks(refresh=True)
    assert BUILTINS <= set(loaded)
    assert playbooks.load_errors() == {}
    review = loaded["literature_review"]
    assert review.signature() == "literature_review(topic, top_n=5, ingest=false, sources?)"
    assert loaded["compare_papers"].signature() == 'compare_papers(papers, focus="")'
    index = playbooks.playbook_index()
    assert "literature_review(topic" in index and "paper_deep_dive(paper" in index
    described = review.to_dict()
    assert described["steps"][0] == {
        "id": "library", "title": "Search the indexed library", "kind": "tool", "tool": "research.search_library",
        "arguments": {"query": "{{params.topic}}", "limit": 10}, "group": "search",
    }
    assert [s["id"] for s in described["steps"] if s.get("each")] == ["briefs"]
    assert [s["id"] for s in described["steps"] if s.get("when")] == ["ingest", "topology"]


def test_builtin_tool_steps_name_real_tools():
    from app.main import app  # noqa: F401  (configures the catalog)
    from app.agents import catalog
    from app.agents.runtime import META_TOOL_NAMES, ORCHESTRATION_TOOLS

    known = {t["name"] for t in catalog.tool_catalog()} | (META_TOOL_NAMES - ORCHESTRATION_TOOLS)
    for playbook in playbooks.load_playbooks().values():
        for step in playbook.steps:
            if step.kind == "tool":
                assert step.tool in known, f"{playbook.name}.{step.id} names unknown tool {step.tool}"


def test_render_keeps_types_for_lone_expressions_and_stringifies_inline():
    ctx = {"params": {"topic": "graph rag", "n": 3, "flag": False},
           "steps": {"s": {"data": [{"title": "A"}], "result": {"papers": []}}}}
    assert playbooks.render("{{params.n}}", ctx) == 3
    assert playbooks.render("{{ steps.s.data }}", ctx) == [{"title": "A"}]
    assert playbooks.render("{{steps.s.data.0.title}}", ctx) == "A"
    assert playbooks.render("Topic: {{params.topic}} ({{params.n}}) {{params.flag}}", ctx) == "Topic: graph rag (3) false"
    assert playbooks.render("List: {{steps.s.data}}", ctx) == 'List: [{"title": "A"}]'
    assert playbooks.render("{{params.missing}}", ctx) is None
    assert playbooks.render("x {{params.missing}} y", ctx) == "x  y"
    assert playbooks.render({"a": "{{params.n}}", "b": ["{{params.topic}}"], "c": 1}, ctx) == {"a": 3, "b": ["graph rag"], "c": 1}


def test_truthy_and_json_extraction():
    assert playbooks.truthy(True) and playbooks.truthy("yes") and playbooks.truthy([1]) and playbooks.truthy(2)
    assert not any(playbooks.truthy(v) for v in (False, None, "", "false", "0", "no", [], 0))
    assert playbooks.extract_json('Ranked.\n```json\n[{"title": "A"}]\n```') == [{"title": "A"}]
    assert playbooks.extract_json('Result {"k": 1}') == {"k": 1}
    assert playbooks.extract_json("no json here") is None


def test_prepare_params_applies_defaults_and_reports_schema_errors():
    review = playbooks.get_playbook("literature_review")
    assert playbooks.prepare_params(review, {"topic": "x"}) == {"topic": "x", "top_n": 5, "ingest": False}
    with pytest.raises(playbooks.PlaybookError) as missing:
        playbooks.prepare_params(review, {})
    assert "topic" in str(missing.value) and "Expected" in str(missing.value)
    with pytest.raises(playbooks.PlaybookError):
        playbooks.prepare_params(review, {"topic": "x", "top_n": 50})
    with pytest.raises(playbooks.PlaybookError):
        playbooks.prepare_params(review, {"topic": "x", "bogus": 1})
    with pytest.raises(playbooks.PlaybookError) as unknown:
        playbooks.get_playbook("nope")
    assert "Available: compare_papers" in str(unknown.value)


def test_malformed_definitions_are_rejected_with_a_reason():
    with pytest.raises(playbooks.PlaybookError, match="exactly one of 'tool' or 'agent'"):
        _playbook("name: bad\nsteps:\n  - id: s\n    tool: x\n    agent: y\n")
    with pytest.raises(playbooks.PlaybookError, match="duplicate step ids"):
        _playbook("name: bad\nsteps:\n  - {id: s, tool: x}\n  - {id: s, tool: y}\n")
    with pytest.raises(playbooks.PlaybookError, match="non-empty list of steps"):
        _playbook("name: bad\nsteps: []\n")
    with pytest.raises(playbooks.PlaybookError, match="playbook name"):
        _playbook("name: Bad Name\nsteps:\n  - {id: s, tool: x}\n")


def test_custom_directories_add_and_override_and_bad_files_are_reported(tmp_path, monkeypatch):
    (tmp_path / "quick.yaml").write_text("name: quick\ndescription: Quick check.\nsteps:\n  - {id: ctx, tool: app_context}\n", encoding="utf-8")
    (tmp_path / "literature_review.yaml").write_text(
        "name: literature_review\ndescription: Overridden.\nsteps:\n  - {id: ctx, tool: app_context}\n", encoding="utf-8")
    (tmp_path / "broken.yaml").write_text("name: broken\nsteps: []\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("ignored", encoding="utf-8")
    monkeypatch.setenv(playbooks.PLAYBOOKS_DIR_ENV, str(tmp_path))
    loaded = playbooks.load_playbooks(refresh=True)
    assert "quick" in loaded and loaded["quick"].signature() == "quick()"
    assert loaded["literature_review"].description == "Overridden."
    assert "broken" not in loaded
    assert any("broken.yaml" in path for path in playbooks.load_errors())
    # Editing a file is picked up without a restart.
    (tmp_path / "quick.yaml").write_text("name: quick\ndescription: Edited.\nsteps:\n  - {id: ctx, tool: app_context}\n", encoding="utf-8")
    import os, time
    os.utime(tmp_path / "quick.yaml", (time.time() + 5, time.time() + 5))
    assert playbooks.load_playbooks()["quick"].description == "Edited."


def _run(playbook: playbooks.Playbook, params: Dict[str, Any], call_tool, run_task, **kwargs) -> Dict[str, Any]:
    prepared = playbooks.prepare_params(playbook, params)
    return asyncio.run(playbooks.run_playbook(playbook, prepared, call_tool=call_tool, run_task=run_task, **kwargs))


RUNNER_PLAYBOOK = """
name: runner_test
description: Exercises groups, fan-out, conditions and workers.
parameters:
  type: object
  properties:
    q: {type: string}
    flag: {type: boolean, default: false}
  required: [q]
steps:
  - id: a
    title: First search
    group: search
    tool: fake.search
    arguments: {query: "{{params.q}}", empty: "{{params.missing}}"}
  - id: b
    title: Second search
    group: search
    tool: fake.search
    arguments: {query: "{{params.q}} again"}
  - id: fan
    title: Echo each hit
    each: "{{steps.a.result.hits}}"
    max_items: 2
    tool: fake.echo
    arguments: {value: "{{item}}", position: "{{index}}"}
  - id: never
    title: Only when flagged
    when: "{{params.flag}}"
    tool: fake.never
  - id: rank
    title: Rank
    format: json
    agent: "Rank {{steps.fan.result}} for {{params.q}}"
report: "Report on {{params.q}}: {{steps.rank.summary}} / flag {{params.flag}}"
"""


def test_runner_groups_run_concurrently_fans_out_skips_conditions_and_renders_the_report():
    playbook = _playbook(RUNNER_PLAYBOOK)
    calls: List[tuple] = []
    active = {"now": 0, "max": 0}

    async def call_tool(name: str, arguments: Dict[str, Any]) -> Any:
        calls.append((name, arguments))
        active["now"] += 1
        active["max"] = max(active["max"], active["now"])
        await asyncio.sleep(0.05)
        active["now"] -= 1
        if name == "fake.search":
            return {"hits": ["h1", "h2", "h3"], "summary": f"3 hits for {arguments['query']}"}
        return {"echo": arguments}

    tasks: List[tuple] = []

    async def run_task(task: str, label: str, fmt: str) -> Dict[str, Any]:
        tasks.append((task, label, fmt))
        return {"status": "ok", "report": 'Ranked.\n```json\n[{"title": "h1"}]\n```', "data": [{"title": "h1"}]}

    payload = _run(playbook, {"q": "graphs"}, call_tool, run_task)

    assert active["max"] >= 2  # the two grouped searches overlapped
    assert calls[0] == ("fake.search", {"query": "graphs"})  # the empty template argument was dropped
    assert ("fake.echo", {"value": "h1", "position": 0}) in calls and ("fake.echo", {"value": "h2", "position": 1}) in calls
    assert not any(name == "fake.never" for name, _ in calls)
    assert len([c for c in calls if c[0] == "fake.echo"]) == 2  # max_items
    assert tasks == [('Rank [{"echo": {"value": "h1", "position": 0}}, {"echo": {"value": "h2", "position": 1}}] for graphs', "Rank", "json")]

    assert payload["playbook"] == "runner_test" and payload["status"] == "completed"
    statuses = {s["id"]: s["status"] for s in payload["steps"]}
    assert statuses == {"a": "success", "b": "success", "fan": "success", "never": "skipped", "rank": "success"}
    by_id = {s["id"]: s for s in payload["steps"]}
    assert by_id["a"]["summary"] == "3 hits for graphs"
    assert by_id["fan"]["items"] == 2 and by_id["fan"]["summary"] == "2/2 items"
    assert by_id["never"]["summary"] == "condition not met"
    assert payload["report_instructions"] == "Report on graphs: Ranked. / flag false"
    assert payload["summary"] == "4 of 5 steps succeeded, 1 skipped"


def test_runner_stops_at_a_step_that_needs_confirmation_and_names_what_is_left():
    playbook = _playbook("""
    name: stopper
    steps:
      - {id: read, tool: fake.read}
      - {id: wipe, title: Wipe it, tool: fake.delete}
      - {id: after, title: Afterwards, tool: fake.read}
    report: "done"
    """)
    calls: List[str] = []

    async def call_tool(name: str, arguments: Dict[str, Any]) -> Any:
        calls.append(name)
        if name == "fake.delete":
            return {"requires_confirmation": True, "error": "fake.delete is marked destructive. It has NOT run.",
                    "pending_action": {"id": "pa-1", "tool": "fake.delete"}}
        return {"ok": True}

    async def run_task(task, label, fmt):
        raise AssertionError("no agent steps here")

    payload = _run(playbook, {}, call_tool, run_task)
    assert calls == ["fake.read", "fake.delete"]
    assert payload["status"] == "stopped"
    assert payload["needs_confirmation"] == {"id": "pa-1", "tool": "fake.delete"}
    assert "Wipe it" in payload["stopped_reason"] and "Afterwards" in payload["stopped_reason"]
    assert [s["status"] for s in payload["steps"]] == ["success", "skipped"]


def test_step_errors_are_recorded_and_the_playbook_continues():
    playbook = _playbook("""
    name: errors
    steps:
      - {id: bad, tool: fake.bad}
      - {id: worker, agent: "Do a thing with {{steps.bad.result}}"}
      - {id: good, tool: fake.good}
    """)

    async def call_tool(name, arguments):
        return {"error": "boom"} if name == "fake.bad" else {"ok": True}

    async def run_task(task, label, fmt):
        return {"status": "error", "report": "Worker failed: nope"}

    payload = _run(playbook, {}, call_tool, run_task)
    assert [s["status"] for s in payload["steps"]] == ["error", "error", "success"]
    assert payload["steps"][0]["summary"] == "boom" and payload["steps"][1]["summary"] == "Worker failed: nope"
    assert payload["status"] == "completed" and payload["summary"] == "1 of 3 steps succeeded, 2 failed"
    assert payload["report_instructions"] == ""


def test_large_results_are_clipped_to_a_budget():
    playbook = _playbook("name: big\nsteps:\n  - {id: s, tool: fake.big}\n")

    async def call_tool(name, arguments):
        return {"blob": "x" * 20000}

    async def run_task(task, label, fmt):
        raise AssertionError

    payload = _run(playbook, {}, call_tool, run_task)
    clipped = payload["steps"][0]["result"]
    assert isinstance(clipped, str) and clipped.endswith("...") and len(clipped) <= playbooks.MAX_STEP_CHARS

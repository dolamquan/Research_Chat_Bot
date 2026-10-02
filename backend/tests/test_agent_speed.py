"""Speed and scoping of the assistant loop: effort per step, argument hints, prompt layout, signed-in user in threads."""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

from app.agents import catalog, models, runtime
from app.auth.context import CurrentUser, current_owner_id, reset_current_user, set_current_user
from app.storage import article_store
from tests.test_assistant_runtime import StreamingScriptedModel, app, stub_library  # noqa: F401  (fixtures)


def _run(monkeypatch, script, *, user: CurrentUser | None = None, **state_extra) -> tuple[dict, StreamingScriptedModel, List[Dict[str, Any]]]:
    model = StreamingScriptedModel(script)
    built: List[Dict[str, Any]] = []

    def fake_llm(*_args, **kwargs):
        built.append(kwargs)
        return model

    monkeypatch.setattr(runtime, "get_llm", fake_llm)

    async def emit(_event):
        pass

    async def turn():
        token = set_current_user(user) if user else None
        try:
            state = {"question": "hello", "chat_history": [], "pinned_sources": [], **state_extra}
            return await runtime.arun_agent(state, emit=emit, turn_id="t-1")
        finally:
            if token is not None:
                reset_current_user(token)

    return asyncio.run(turn()), model, built


def test_the_first_step_plans_at_the_configured_effort_and_later_steps_think_minimally(monkeypatch):
    monkeypatch.setenv("AGENT_MODEL", "gpt-5")
    monkeypatch.setenv("AGENT_REASONING_EFFORT", "low")
    monkeypatch.delenv("AGENT_FOLLOWUP_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("AGENT_VERBOSITY", raising=False)

    _, _, built = _run(monkeypatch, [[("app_papers", {"query": "graph"})], "Found it.\nSPEAK: Found it."])

    assert [kwargs.get("reasoning_effort") for kwargs in built] == ["low", "minimal"]
    assert all("verbosity" not in kwargs for kwargs in built)


def test_followup_effort_and_verbosity_are_configurable_and_only_apply_to_gpt5(monkeypatch):
    monkeypatch.setenv("AGENT_FOLLOWUP_REASONING_EFFORT", "low")
    monkeypatch.setenv("AGENT_VERBOSITY", "low")
    assert models.followup_kwargs("gpt-5") == {"reasoning_effort": "low"}
    assert models.verbosity_kwargs("gpt-5") == {"verbosity": "low"}
    assert models.verbosity_kwargs("gpt-4o-mini") == {}
    monkeypatch.delenv("AGENT_FOLLOWUP_REASONING_EFFORT")
    monkeypatch.setenv("AGENT_REASONING_EFFORT", "medium")
    # o-series and later gpt-5 releases reject "minimal", so they keep the agent's effort.
    assert models.followup_kwargs("o4-mini") == {"reasoning_effort": "medium"}
    assert models.followup_kwargs("gpt-5.1") == {"reasoning_effort": "medium"}
    assert models.followup_kwargs("gpt-5-pro") == {"reasoning_effort": "medium"}
    assert models.followup_kwargs("gpt-5-mini-2025-08-07") == {"reasoning_effort": "minimal"}
    assert models.followup_kwargs("gpt-4o-mini") == {}


def test_argument_hints_flatten_grouped_api_schemas_and_mark_required_fields():
    grouped = {
        "type": "object",
        "properties": {"path": {"type": "object", "properties": {"note_id": {"type": "string"}}, "required": ["note_id"]},
                       "body": {"$ref": "#/components/schemas/NoteUpdate"}},
        "components": {"schemas": {"NoteUpdate": {"properties": {"title": {}, "body_md": {}}, "required": ["title"]}}},
    }
    assert catalog.argument_hint(grouped) == "path{note_id*} body{title*, body_md}"
    flat = {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]}
    assert catalog.argument_hint(flat) == "{query*, limit}"
    assert catalog.argument_hint({"type": "object", "properties": {}}) == ""
    many = {"type": "object", "properties": {f"f{i}": {} for i in range(11)}}
    assert catalog.argument_hint(many).endswith(", +3 more}")


def test_the_index_lists_arguments_so_api_tools_need_no_describe_step():
    index = catalog.catalog_index()
    line = next(row for row in index.splitlines() if row.startswith("- api.annotations.save_annotation "))
    assert "body{source*, page*, selected_text*" in line


def test_the_fixed_prompt_prefix_does_not_change_with_the_screen(monkeypatch):
    def system_for(workspace: Dict[str, Any]) -> str:
        _, model, _ = _run(monkeypatch, ["ok\nSPEAK: ok"], workspace=workspace)
        return model.calls[0][0].content

    library = system_for({"active_view": "library"})
    reader = system_for({"active_view": "chat", "reader": {"title": "Graph RAG for Science", "page": 4, "total_pages": 12}})
    cut = library.index("# Application overview")
    assert reader.index("# Application overview") == cut and library[:cut] == reader[:cut]
    assert library.index("# Tool index") < cut < library.index("# What the user is looking at right now")


def test_builtin_tools_run_as_the_signed_in_user(monkeypatch):
    seen: List[str | None] = []

    def list_articles(domain=None, category=None, limit=100, owner_id=None):
        seen.append(current_owner_id())
        return []

    monkeypatch.setattr(article_store, "list_articles", list_articles)
    _run(monkeypatch, [[("app_papers", {"query": "graph"})], "None.\nSPEAK: None."],
         user=CurrentUser(id="user-42", email="u@example.com"))

    assert seen and set(seen) == {"user-42"}

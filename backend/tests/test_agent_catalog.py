"""The agent's tool catalog mirrors the running application.

Every route is either a tool or explicitly excluded, names are readable and
unique, arguments are validated against the route's own schema, and the
/agent/tools routes expose the same catalog the agent uses.
"""

from __future__ import annotations

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.agents import catalog
from app.storage import article_store, notes


@pytest.fixture(scope="module")
def app():
    from app.main import app as application

    return application


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def stub_library(monkeypatch):
    papers = [
        {"article_id": "a1", "title": "Graph RAG for Science", "source": "graph.pdf", "url": "http://x/1",
         "domain": "research", "category": "nlp", "status": "indexed", "tags": ["rag"], "abstract": "retrieval over graphs"},
        {"article_id": "a2", "title": "Diffusion Models Survey", "source": "diff.pdf", "url": "http://x/2",
         "domain": "research", "category": "vision", "status": "indexed", "tags": [], "abstract": "denoising"},
    ]
    monkeypatch.setattr(article_store, "list_articles", lambda domain=None, category=None, limit=100: [
        p for p in papers if (not domain or p["domain"] == domain) and (not category or p["category"] == category)
    ])
    monkeypatch.setattr(article_store, "list_domains", lambda: [
        {"domain": "research", "category": "nlp", "article_count": 1},
        {"domain": "research", "category": "vision", "article_count": 1},
    ])
    monkeypatch.setattr(notes, "list_notion_targets", lambda: [])


def test_every_route_is_a_tool_or_explicitly_excluded(app):
    tools = {(t["method"], t["path"]) for t in catalog.tool_catalog() if t.get("execution") == "api"}
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in route.methods:
            key = (method, route.path)
            assert key in tools or key in catalog.EXCLUDED, f"{key} is neither a tool nor excluded"
    for key in catalog.EXCLUDED:
        assert key not in tools


def test_tool_names_are_unique_and_readable(app):
    tools = catalog.tool_catalog()
    names = [t["name"] for t in tools]
    assert len(names) == len(set(names))
    api_names = [n for n in names if n.startswith("api.")]
    assert api_names, "API routes should be in the catalog"
    assert all(len(n.split(".")) == 3 for n in api_names), api_names
    assert "api.notes.create_note" in names
    assert "api.visualizer.generate_scene_endpoint" in names
    assert "research.search_papers" in names
    assert {"app.context", "app.papers"} <= set(names)
    for tool in tools:
        assert tool["effect"] in {"read", "write", "destructive", "external_write"}
        assert tool["description"], tool["name"]


def test_effects_follow_method_and_integration(app):
    by_name = {t["name"]: t for t in catalog.tool_catalog()}
    assert by_name["api.notes.delete_note"]["effect"] == "destructive"
    assert by_name["api.notes.export_note_to_notion"]["effect"] == "external_write"
    assert by_name["api.notes.list_notes"]["effect"] == "read"
    assert by_name["api.notes.create_note"]["effect"] == "write"
    assert by_name["research.add_paper"]["effect"] == "write"
    assert by_name["notion.create_research_page"]["effect"] == "external_write"


def test_api_tool_schema_groups_path_query_and_body(app):
    tool = catalog.describe_tool("api.notes.update_note")
    props = tool["input_schema"]["properties"]
    assert "path" in props and "note_id" in props["path"]["properties"]
    assert "body" in props
    assert "path" in tool["input_schema"]["required"]


def test_catalog_index_lists_every_tool_grouped(app):
    tools = catalog.tool_catalog()
    index = catalog.catalog_index(tools)
    for tool in tools:
        assert f"- {tool['name']}" in index
    assert "## notes" in index and "## application" in index


def test_discover_filters_by_query_and_category(app):
    result = catalog.discover_tools("notion")
    assert result["total"] > 0
    assert all("notion" in (t["name"] + t["description"]).lower() for t in result["tools"])
    assert all("input_schema" not in t for t in result["tools"])

    notes_only = catalog.discover_tools(category="notes", limit=5)
    assert notes_only["tools"] and all(t["category"] == "notes" for t in notes_only["tools"])
    assert notes_only["next_offset"] == 5


def test_execute_read_tool_through_the_app(app):
    assert catalog.execute_tool("api.health.health_check", {}) == {"status": "ok"}


def test_execute_validates_arguments_with_schema_in_message(app):
    with pytest.raises(ValueError) as exc:
        catalog.execute_tool("app.papers", {"limit": "five"})
    assert "Invalid arguments for app.papers" in str(exc.value)
    assert "input_schema" in str(exc.value)


def test_execute_rejects_unknown_and_unavailable_tools(app, monkeypatch):
    with pytest.raises(ValueError, match="Unknown application tool"):
        catalog.execute_tool("api.nope.missing", {})
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    with pytest.raises(ValueError, match="credentials"):
        catalog.execute_tool("github.create_issue", {"title": "x"})


def test_library_papers_searches_every_field(app):
    result = catalog.library_papers("graph")
    assert result["total"] == 1
    assert result["papers"][0]["article_id"] == "a1"
    assert catalog.library_papers("", limit=1)["next_offset"] == 1
    assert catalog.library_papers(category="vision")["papers"][0]["article_id"] == "a2"


def test_application_context_summarises_the_app(app):
    context = catalog.application_context({"selected_paper": {"title": "Graph RAG for Science"}})
    assert context["paper_count"] == 2
    assert context["tool_count"] == len(catalog.tool_catalog())
    assert context["workspace"]["selected_paper"]["title"] == "Graph RAG for Science"
    assert set(context["guide"]) >= {"Notes", "Visualizer", "Evaluation"}


def test_agent_tool_routes(client):
    listing = client.get("/agent/tools", params={"query": "papers", "limit": 10}).json()
    assert listing["total"] >= 1 and len(listing["tools"]) <= 10

    detail = client.get("/agent/tools/app.papers")
    assert detail.status_code == 200 and "input_schema" in detail.json()
    assert client.get("/agent/tools/api.nope.missing").status_code == 404

    call = client.post("/agent/tools/call", json={"name": "app.papers", "arguments": {"query": "diffusion"}})
    assert call.status_code == 200
    assert call.json()["result"]["papers"][0]["article_id"] == "a2"

    bad = client.post("/agent/tools/call", json={"name": "app.papers", "arguments": {"limit": "x"}})
    assert bad.status_code == 400
    assert client.post("/agent/tools/call", json={"name": "api.nope.missing"}).status_code == 404

    context = client.get("/agent/context").json()
    assert context["application"] == "Zoetrope" and context["paper_count"] == 2


def test_aexecute_runs_api_and_builtin_tools_inside_a_running_loop(app):
    import asyncio

    async def go():
        health = await catalog.aexecute_tool("api.health.health_check", {})
        papers = await catalog.aexecute_tool("app.papers", {"query": "graph", "limit": 5})
        return health, papers

    health, papers = asyncio.run(go())
    assert health == {"status": "ok"}
    assert [p["article_id"] for p in papers["papers"]] == ["a1"]

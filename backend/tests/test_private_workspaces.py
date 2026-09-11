"""Everything except the public paper library is private to its user.

Covers the second wave of ownership: diagrams and variants, extracted figures
and uploads, evaluation runs, topology/graph caches, per-user integration
credentials, and the route guards that keep derived data behind its diagram.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth.context import LOCAL_USER, CurrentUser, reset_current_user, set_current_user
from app.evaluation import evaluator
from app.rag import clusterer, graph_rag
from app.routes import evaluate as evaluate_routes
from app.storage import integrations, variant_store, visual_assets, visualization_store

A = CurrentUser(id="user-a")
B = CurrentUser(id="user-b")
ADMIN = CurrentUser(id="admin-1", role="admin")


@contextmanager
def acting_as(user: CurrentUser | None):
    token = set_current_user(user)
    try:
        yield
    finally:
        reset_current_user(token)


@pytest.fixture(autouse=True)
def temp_storage(monkeypatch, tmp_path: Path):
    db = tmp_path / "workspace.sqlite3"
    for module in (visualization_store, variant_store, visual_assets, integrations):
        monkeypatch.setattr(module, "DATA_DIR", tmp_path)
        monkeypatch.setattr(module, "DB_PATH", db)
    monkeypatch.setattr(integrations, "KEY_PATH", tmp_path / "integration.key")
    monkeypatch.delenv("INTEGRATION_SECRET_KEY", raising=False)
    monkeypatch.setattr(evaluator, "EVALUATION_RUNS_DIR", tmp_path / "evaluation_runs")
    monkeypatch.setattr(evaluate_routes, "EVALUATION_RUNS_DIR", tmp_path / "evaluation_runs")
    monkeypatch.setattr(clusterer, "CLUSTERS_PATH", tmp_path / "clusters.json")
    monkeypatch.setattr(clusterer, "CLUSTERS_DIR", tmp_path / "clusters")
    monkeypatch.setattr(graph_rag, "GRAPH_DIR", tmp_path / "graph_rag")
    return tmp_path


def _diagram(article_id="paper-1", kind="method_flow", title="Diagram"):
    return visualization_store.upsert_visualization(
        article_id=article_id, document_source=f"{article_id}.pdf", diagram_kind=kind, title=title,
        algorithm_name="Algo", diagram={"nodes": [], "edges": [], "groups": []},
        summary="", key_insight="", model="test",
    )


def test_each_user_has_their_own_diagram_of_the_same_paper():
    with acting_as(A):
        mine = _diagram(title="A's view")
        again = _diagram(title="A's view v2")
        assert again["viz_id"] == mine["viz_id"]  # same owner + paper + kind upserts in place
    with acting_as(B):
        theirs = _diagram(title="B's view")
        assert theirs["viz_id"] != mine["viz_id"]
        assert [v["title"] for v in visualization_store.list_visualizations("paper-1")] == ["B's view"]
        assert visualization_store.get_visualization_by_id(mine["viz_id"]) is None
        assert visualization_store.delete_visualization(mine["viz_id"]) is False
    with acting_as(A):
        assert visualization_store.get_visualization_by_id(mine["viz_id"])["title"] == "A's view v2"
        assert visualization_store.get_visualization("paper-1", "method_flow")["owner_id"] == "user-a"
    assert len(visualization_store.list_visualizations("paper-1", owner_id=None)) == 2


def test_legacy_visualization_table_is_migrated_and_claimable(tmp_path: Path, monkeypatch):
    db = tmp_path / "legacy.sqlite3"
    monkeypatch.setattr(visualization_store, "DB_PATH", db)
    with sqlite3.connect(db) as conn:
        conn.execute(
            """CREATE TABLE paper_visualizations (
                viz_id TEXT PRIMARY KEY, article_id TEXT NOT NULL, document_source TEXT NOT NULL,
                diagram_kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', algorithm_name TEXT NOT NULL DEFAULT '',
                diagram_json TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', key_insight TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '', source_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(article_id, diagram_kind))"""
        )
        conn.execute(
            "INSERT INTO paper_visualizations VALUES ('v1','p','p.pdf','method_flow','Old','','{}','','','',0,'t','t')"
        )
    visualization_store.init_db()
    visualization_store.init_db()  # idempotent
    legacy = visualization_store.get_visualization_by_id("v1", owner_id=None)
    assert legacy["owner_id"] is None and legacy["title"] == "Old"
    with acting_as(A):
        assert visualization_store.get_visualization_by_id("v1") is None
    assert visualization_store.claim_unowned(ADMIN.id) == {"visualizations": 1}
    with acting_as(ADMIN):
        assert visualization_store.get_visualization_by_id("v1")["owner_id"] == "admin-1"


def _variant(root_viz_id="viz-1"):
    return variant_store.create_variant(
        root_viz_id=root_viz_id, parent_variant_id=None, article_id="paper-1", document_source="paper-1.pdf",
        diagram_kind="method_flow", title="t", algorithm_name="a", variant_title="v",
        diagram={"nodes": [], "edges": [], "groups": []}, summary="", key_insight="", worked_example=None,
        intent="try", patch={}, patch_result={}, changed_node_ids=[], depth=1, model="test",
    )


def test_variants_are_private():
    with acting_as(A):
        variant = _variant()
        assert variant["owner_id"] == "user-a"
    with acting_as(B):
        assert variant_store.get_variant(variant["variant_id"]) is None
        assert variant_store.list_variants_for_visualization("viz-1") == []
        assert variant_store.list_variants_for_article("paper-1") == []
    with acting_as(A):
        assert len(variant_store.list_variants_for_article("paper-1")) == 1
    legacy = _variant(root_viz_id="viz-legacy")
    assert legacy["owner_id"] is None
    assert variant_store.claim_unowned(ADMIN.id) == {"variants": 1}


def test_figures_follow_their_paper_and_uploads_stay_private():
    shared = visual_assets.create_visual_asset(
        source="public.pdf", image_path="x", image_url="/visuals/fig1.png/image", caption="", owner_id=None,
    )
    with acting_as(A):
        mine = visual_assets.create_visual_asset(
            source="mine.png", image_path="y", image_url="/visuals/upload1.png/image", caption="", asset_type="uploaded_image",
        )
        assert mine["owner_id"] == "user-a"
        assert {a["asset_id"] for a in visual_assets.list_visual_assets()} == {shared["asset_id"], mine["asset_id"]}
    with acting_as(B):
        assert [a["asset_id"] for a in visual_assets.list_visual_assets()] == [shared["asset_id"]]
        with pytest.raises(ValueError):
            visual_assets.get_visual_asset(mine["asset_id"])
        assert visual_assets.can_access_visual_file("fig1.png")
        assert not visual_assets.can_access_visual_file("upload1.png")
        assert visual_assets.can_access_visual_file("never-recorded.png")


def test_integration_credentials_are_per_user_with_admin_env_fallback(monkeypatch):
    monkeypatch.setenv("NOTION_API_KEY", "env-notion")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)

    with acting_as(A):
        assert integrations.get_secret("notion") == ""
        unset = integrations.status_for("notion")
        assert (unset["configured"], unset["source"], unset["method"], unset["meta"]) == (False, None, None, {})
        status = integrations.set_secret("notion", "  secret-a  ")
        assert status["configured"] and status["source"] == "user" and status["method"] == "token"
        assert integrations.get_secret("notion") == "secret-a"
        with pytest.raises(ValueError):
            integrations.set_secret("notion", "   ")
    with acting_as(B):
        assert integrations.get_secret("notion") == ""
        assert not integrations.delete_secret("notion")
    with acting_as(ADMIN):
        assert integrations.get_secret("notion") == "env-notion"
        assert integrations.secret_source("notion") == "environment"
        assert integrations.get_secret("github") == ""
    assert integrations.get_secret("notion") == "env-notion"  # nobody acting: CLI scripts
    with acting_as(A):
        assert integrations.delete_secret("notion")
        assert integrations.get_secret("notion") == ""
    with pytest.raises(integrations.UnknownProvider):
        integrations.get_secret("slack")

    # The ciphertext in the table is not the secret.
    with acting_as(A):
        integrations.set_secret("github", "ghp_x")
    with sqlite3.connect(integrations.DB_PATH) as conn:
        stored = conn.execute("SELECT secret FROM user_integrations").fetchone()[0]
    assert "ghp_x" not in stored


def test_evaluation_runs_are_per_user_and_admins_keep_the_archive(tmp_path: Path):
    archive = evaluator.EVALUATION_RUNS_DIR
    archive.mkdir(parents=True)
    (archive / "rag_eval_old.json").write_text(json.dumps({"summary": {}, "results": []}), encoding="utf-8")

    assert evaluator.runs_dir(owner_id=None) == archive
    with acting_as(A):
        own = evaluator.runs_dir()
        assert own == archive / "users" / "user-a"
        own.mkdir(parents=True)
        (own / "rag_eval_mine.json").write_text(json.dumps({"summary": {}, "results": []}), encoding="utf-8")
        assert [p.name for p in evaluate_routes._run_paths()] == ["rag_eval_mine.json"]
    with acting_as(B):
        assert evaluate_routes._run_paths() == []
    with acting_as(ADMIN):
        assert {p.name for p in evaluate_routes._run_paths()} == {"rag_eval_old.json"}


def test_topology_and_graph_caches_are_per_user_with_shared_fallback():
    shared = {"clusters": [{"cluster_id": 0}], "documents": [{"source": "pub.pdf", "cluster_id": 0}], "scope": {}}
    clusterer.CLUSTERS_PATH.write_text(json.dumps(shared), encoding="utf-8")

    with acting_as(A):
        inherited = clusterer.load_clusters()
        assert inherited["shared"] is True and inherited["stale"] is False
        assert clusterer.cluster_sources(0) == ["pub.pdf"]
        own = {"clusters": [{"cluster_id": 0}], "documents": [{"source": "mine.pdf", "cluster_id": 0}], "scope": {}}
        clusterer.save_clusters(own)
        assert clusterer._clusters_path().parent == clusterer.CLUSTERS_DIR / "users" / "user-a"
        assert clusterer.load_clusters()["shared"] is False
        assert clusterer.cluster_sources(0) == ["mine.pdf"]
    with acting_as(B):
        assert clusterer.cluster_sources(0) == ["pub.pdf"]  # B still sees the shared topology
    assert clusterer.load_clusters()["documents"][0]["source"] == "pub.pdf"

    graph_rag.GRAPH_DIR.mkdir(parents=True)
    graph_rag._shared_graph_path().write_text(json.dumps({"nodes": [1], "edges": [], "stale": False}), encoding="utf-8")
    with acting_as(A):
        assert graph_rag._graph_path().parent == graph_rag.GRAPH_DIR / "users" / "user-a"
        assert graph_rag.load_graph_rag()["nodes"] == [1]


def test_derived_diagram_data_is_hidden_behind_ownership():
    from app.main import app

    client = TestClient(app)
    # AUTH_MODE=disabled acts as LOCAL_USER; another user's diagram must look absent.
    with acting_as(B):
        theirs = _diagram(article_id="paper-x")
    with acting_as(LOCAL_USER):
        mine = _diagram(article_id="paper-y")

    assert client.get(f"/visualizer/item/{theirs['viz_id']}/expansions").status_code == 404
    assert client.get(f"/visualizer/item/{theirs['viz_id']}/scene").status_code == 404
    assert client.get(f"/visualizer/item/{theirs['viz_id']}/stage-scenes").json() == {"stage_scenes": []}
    assert client.delete(f"/visualizer/item/{theirs['viz_id']}").status_code == 404
    assert client.get(f"/variants/for-visualization/{theirs['viz_id']}").status_code == 404
    assert client.get(f"/variants/item/{theirs['viz_id']}/chat").status_code == 404

    assert client.get(f"/visualizer/item/{mine['viz_id']}/expansions").status_code == 200
    assert client.get("/visualizer/paper-y").json()["visualizations"][0]["viz_id"] == mine["viz_id"]
    assert client.get("/visualizer/paper-x").json()["visualizations"] == []
    assert client.delete(f"/visualizer/item/{mine['viz_id']}").json()["status"] == "deleted"

    status = client.get("/integrations").json()["integrations"]
    assert {item["provider"] for item in status} == {"notion", "github"}
    assert client.put("/integrations/slack", json={"secret": "x"}).status_code == 404

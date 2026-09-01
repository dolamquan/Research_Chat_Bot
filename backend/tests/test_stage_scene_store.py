"""Persistence for per-node stage scenes, and their API surface."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.rag import scene_service
from app.rag.scene_coder import SCHEMA_VERSION, scene_code_from_diagram
from app.storage import stage_scene_store, visualization_store


@pytest.fixture(autouse=True)
def temp_db(monkeypatch, tmp_path: Path):
    db = tmp_path / "stage_scenes.sqlite3"
    for module in (visualization_store, stage_scene_store):
        monkeypatch.setattr(module, "DB_PATH", db)
        monkeypatch.setattr(module, "DATA_DIR", tmp_path)
    stage_scene_store.init_db()
    return db


def _store(sample_visualization, viz_id="viz_1", node_id="encoder"):
    scene = scene_code_from_diagram(sample_visualization)
    scene["node_id"] = node_id
    return stage_scene_store.upsert_stage_scene(
        viz_id=viz_id,
        node_id=node_id,
        scene=scene,
        verification={"valid": True, "findings": [], "checks": "static"},
        provider="openai",
        model="gpt-5",
        schema_version=SCHEMA_VERSION,
    )


# --- store -------------------------------------------------------------------


def test_roundtrip_per_node(sample_visualization):
    _store(sample_visualization, node_id="encoder")
    _store(sample_visualization, node_id="input")
    encoder = stage_scene_store.get_stage_scene("viz_1", "encoder", SCHEMA_VERSION)
    assert encoder is not None and encoder["node_id"] == "encoder"
    assert stage_scene_store.get_stage_scene("viz_1", "missing", SCHEMA_VERSION) is None
    listed = stage_scene_store.list_stage_scenes("viz_1", SCHEMA_VERSION)
    assert [record["node_id"] for record in listed] == ["encoder", "input"]


def test_regenerating_a_node_replaces_its_row(sample_visualization):
    _store(sample_visualization, node_id="encoder")
    _store(sample_visualization, node_id="encoder")
    assert len(stage_scene_store.list_stage_scenes("viz_1", SCHEMA_VERSION)) == 1


def test_delete_removes_all_nodes_for_a_visualization(sample_visualization):
    _store(sample_visualization, node_id="encoder")
    _store(sample_visualization, node_id="input")
    _store(sample_visualization, viz_id="viz_2", node_id="encoder")
    assert stage_scene_store.delete_stage_scenes_for_visualization("viz_1") == 2
    assert stage_scene_store.list_stage_scenes("viz_1", SCHEMA_VERSION) == []
    assert len(stage_scene_store.list_stage_scenes("viz_2", SCHEMA_VERSION)) == 1


# --- routes ------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    from app.main import app

    return TestClient(app)


def test_list_stage_scenes_is_empty_not_404(client):
    response = client.get("/visualizer/item/ghost/stage-scenes")
    assert response.status_code == 200
    assert response.json()["stage_scenes"] == []


def test_list_stage_scenes_returns_stored_records(client, sample_visualization):
    _store(sample_visualization, node_id="encoder")
    response = client.get("/visualizer/item/viz_1/stage-scenes")
    assert response.status_code == 200
    records = response.json()["stage_scenes"]
    assert len(records) == 1
    assert records[0]["node_id"] == "encoder"
    assert "function init" in records[0]["scene"]["code"]


def test_generate_stage_scene_unknown_viz_is_404(client, monkeypatch):
    import app.routes.visualizer as routes

    monkeypatch.setattr(scene_service, "get_visualization_by_id", lambda viz_id: None)
    monkeypatch.setattr(routes, "build_stage_scene", scene_service.build_stage_scene)
    response = client.post(
        "/visualizer/generate-stage-scene",
        json={"viz_id": "nope", "node_id": "encoder", "force": True},
    )
    assert response.status_code == 404


def test_generate_stage_scene_unknown_node_is_404(
    client, monkeypatch, sample_visualization
):
    import app.routes.visualizer as routes

    monkeypatch.setattr(
        scene_service, "get_visualization_by_id", lambda viz_id: sample_visualization
    )
    monkeypatch.setattr(routes, "build_stage_scene", scene_service.build_stage_scene)
    response = client.post(
        "/visualizer/generate-stage-scene",
        json={"viz_id": "viz_1", "node_id": "not_a_node", "force": True},
    )
    assert response.status_code == 404
    assert "node" in response.json()["detail"].lower()


def test_generate_stage_scene_returns_cached_record(client, sample_visualization):
    _store(sample_visualization, node_id="encoder")
    response = client.post(
        "/visualizer/generate-stage-scene",
        json={"viz_id": "viz_1", "node_id": "encoder"},
    )
    assert response.status_code == 200
    assert response.json()["stage_scene"]["node_id"] == "encoder"


def test_stage_routes_sit_above_the_catch_all():
    from app.main import app

    ordered = [
        route.path for route in app.routes if str(route.path).startswith("/visualizer")
    ]
    catch_all = ordered.index("/visualizer/{article_id}")
    for literal in (
        "/visualizer/generate-stage-scene",
        "/visualizer/item/{viz_id}/stage-scenes",
    ):
        assert ordered.index(literal) < catch_all, f"{literal} is below the catch-all"

"""API surface: status codes, error mapping, and that no key ever leaks."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.rag import scene_service
from app.rag.llm_provider import ProviderNotConfigured
from app.rag.scene_ir import parse_scene
from app.rag.scene_planner import ScenePlanningError
from app.rag.scene_verifier import verify_scene
from app.storage import scene_store, visualization_store


@pytest.fixture(autouse=True)
def temp_db(monkeypatch, tmp_path: Path):
    db = tmp_path / "routes.sqlite3"
    for module in (visualization_store, scene_store):
        monkeypatch.setattr(module, "DB_PATH", db)
        monkeypatch.setattr(module, "DATA_DIR", tmp_path)
    scene_store.init_db()
    return db


@pytest.fixture
def client() -> TestClient:
    from app.main import app

    return TestClient(app)


def _seed(transformer_scene, viz_id="viz_1"):
    scene = parse_scene(transformer_scene)
    report = verify_scene(scene)
    return scene_store.upsert_scene(
        viz_id=viz_id,
        article_id="article_1",
        scene=scene.model_dump(mode="json"),
        verification=report.model_dump(mode="json"),
        provider="openai",
        model="gpt-4o-mini",
    )


# --- GET /visualizer/item/{viz_id}/scene --------------------------------------


def test_get_scene_returns_the_record(client, transformer_scene):
    _seed(transformer_scene)
    response = client.get("/visualizer/item/viz_1/scene")
    assert response.status_code == 200
    payload = response.json()["scene"]
    assert payload["scene"]["algorithm_name"] == "Transformer self-attention"
    assert payload["verification"]["valid"] is True


def test_get_missing_scene_is_404(client):
    response = client.get("/visualizer/item/nothing_here/scene")
    assert response.status_code == 404
    assert "no scene" in response.json()["detail"].lower()


# --- POST /visualizer/item/{viz_id}/verify-scene ------------------------------


def test_verify_scene_reruns_checks(client, transformer_scene):
    _seed(transformer_scene)
    response = client.post("/visualizer/item/viz_1/verify-scene")
    assert response.status_code == 200
    assert response.json()["scene"]["verification"]["valid"] is True


def test_verify_missing_scene_is_404(client):
    assert client.post("/visualizer/item/ghost/verify-scene").status_code == 404


def test_verify_reports_a_stored_scene_that_no_longer_parses(
    client, transformer_scene, monkeypatch
):
    _seed(transformer_scene)
    # Corrupt the stored payload the way a schema change might.
    broken = dict(transformer_scene)
    broken["steps"] = [{"id": "s1", "primitive": "gone_rogue"}]
    scene_store.upsert_scene(
        viz_id="viz_1",
        article_id="article_1",
        scene=broken,
        verification={"valid": True, "findings": [], "entity_count": 0,
                      "step_count": 0, "grounded_entity_ratio": 0.0,
                      "grounded_step_ratio": 0.0},
    )
    response = client.post("/visualizer/item/viz_1/verify-scene")
    assert response.status_code == 200
    verification = response.json()["scene"]["verification"]
    assert verification["valid"] is False
    assert verification["findings"][0]["code"] == "scene_parse_failed"


# --- POST /visualizer/generate-scene -----------------------------------------


def test_generate_scene_returns_the_cached_record(client, transformer_scene):
    _seed(transformer_scene)
    response = client.post("/visualizer/generate-scene", json={"viz_id": "viz_1"})
    assert response.status_code == 200
    assert response.json()["scene"]["scene"]["algorithm_name"] == (
        "Transformer self-attention"
    )


def test_generate_scene_unknown_visualization_is_404(client, monkeypatch):
    import app.routes.visualizer as routes

    monkeypatch.setattr(
        scene_service, "get_visualization_by_id", lambda viz_id: None
    )
    monkeypatch.setattr(routes, "build_scene", scene_service.build_scene)
    response = client.post(
        "/visualizer/generate-scene", json={"viz_id": "nope", "force": True}
    )
    assert response.status_code == 404


def test_unknown_provider_is_422(client):
    response = client.post(
        "/visualizer/generate-scene",
        json={"viz_id": "viz_1", "force": True, "provider": "cohere"},
    )
    assert response.status_code == 422
    assert "unsupported" in response.json()["detail"].lower()


def test_provider_failure_is_502_and_leaks_no_key(client, monkeypatch):
    def _unconfigured(**_kwargs):
        raise ProviderNotConfigured("ANTHROPIC_API_KEY is not set, so the "
                                    "anthropic provider cannot be used.")

    import app.routes.visualizer as routes

    monkeypatch.setattr(routes, "build_scene", _unconfigured)
    response = client.post(
        "/visualizer/generate-scene", json={"viz_id": "viz_1", "force": True}
    )
    assert response.status_code == 502
    detail = response.json()["detail"]
    assert "ANTHROPIC_API_KEY" in detail
    # The variable is named; its value is never echoed.
    assert "sk-" not in detail and "Bearer" not in detail


def test_planning_failure_is_502(client, monkeypatch):
    def _fail(**_kwargs):
        raise ScenePlanningError("The model could not produce a valid scene: nope")

    import app.routes.visualizer as routes

    monkeypatch.setattr(routes, "build_scene", _fail)
    response = client.post(
        "/visualizer/generate-scene", json={"viz_id": "viz_1", "force": True}
    )
    assert response.status_code == 502


def test_offline_fallback_is_opt_in(client, monkeypatch, transformer_scene):
    """With no provider, the fallback only runs when explicitly requested."""
    def _unconfigured(**_kwargs):
        raise ProviderNotConfigured("OPENAI_API_KEY is not set.")

    monkeypatch.setattr(scene_service, "build_scene", _unconfigured)

    called: dict[str, bool] = {}

    def _from_expansions(viz_id: str):
        called["yes"] = True
        return _seed(transformer_scene, viz_id=viz_id)

    monkeypatch.setattr(scene_service, "build_scene_from_expansions", _from_expansions)
    # Patch the names the route module bound at import time.
    import app.routes.visualizer as routes

    monkeypatch.setattr(routes, "build_scene", _unconfigured)
    monkeypatch.setattr(routes, "build_scene_from_expansions", _from_expansions)

    without = client.post(
        "/visualizer/generate-scene", json={"viz_id": "viz_1", "force": True}
    )
    assert without.status_code == 502
    assert "yes" not in called

    with_fallback = client.post(
        "/visualizer/generate-scene",
        json={"viz_id": "viz_1", "force": True, "allow_offline_fallback": True},
    )
    assert with_fallback.status_code == 200
    assert with_fallback.json()["fallback"] == "process_steps"
    assert called["yes"] is True


# --- GET /visualizer/providers ------------------------------------------------


def test_providers_endpoint_never_returns_secrets(client, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-never-appear")
    response = client.get("/visualizer/providers")
    assert response.status_code == 200
    body = response.text
    assert "sk-should-never-appear" not in body
    assert isinstance(response.json()["providers"], list)


# --- existing behaviour ------------------------------------------------------


def test_existing_visualizer_routes_still_exist(client):
    """The scene routes must not have shadowed the catch-all article route."""
    from app.main import app

    paths = {route.path for route in app.routes}
    for path in (
        "/visualizer/generate",
        "/visualizer/expand-node",
        "/visualizer/item/{viz_id}/expansions",
        "/visualizer/{article_id}",
        "/visualizer/item/{viz_id}",
    ):
        assert path in paths

    # And the catch-all still resolves rather than being captured by /providers.
    response = client.get("/visualizer/some_article_id")
    assert response.status_code == 200
    assert "visualizations" in response.json()

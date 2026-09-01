"""Persistence for generated scene-code records.

`scene_store` reads `DB_PATH` from `visualization_store` at call time, so both
are patched onto one temp database. The store is format-agnostic (it persists
whatever dict it is given); these tests exercise it with the code documents the
current pipeline produces.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.rag.scene_coder import SCHEMA_VERSION, scene_code_from_diagram
from app.storage import scene_store, visualization_store


@pytest.fixture(autouse=True)
def temp_db(monkeypatch, tmp_path: Path):
    db = tmp_path / "scenes.sqlite3"
    for module in (visualization_store, scene_store):
        monkeypatch.setattr(module, "DB_PATH", db)
        monkeypatch.setattr(module, "DATA_DIR", tmp_path)
    scene_store.init_db()
    return db


def _store(sample_visualization, viz_id="viz_1", article_id="article_1", title=None):
    scene = scene_code_from_diagram(sample_visualization)
    if title:
        scene["title"] = title
        scene["algorithm_name"] = title
    return scene_store.upsert_scene(
        viz_id=viz_id,
        article_id=article_id,
        scene=scene,
        verification={"valid": True, "findings": [], "checks": "static"},
        provider="openai",
        model="gpt-4o-mini",
        schema_version=SCHEMA_VERSION,
    )


def test_roundtrip_preserves_the_scene_document(sample_visualization):
    stored = _store(sample_visualization)
    fetched = scene_store.get_scene("viz_1", SCHEMA_VERSION)
    assert fetched is not None
    assert fetched["scene"] == stored["scene"]
    assert fetched["scene"]["format"] == "threejs-code@1"
    assert "function init" in fetched["scene"]["code"]
    assert fetched["valid"] is True


def test_get_scene_respects_schema_version(sample_visualization):
    _store(sample_visualization)
    assert scene_store.get_scene("viz_1", "1.0") is None
    assert scene_store.get_scene("viz_1", SCHEMA_VERSION) is not None


def test_missing_scene_is_none():
    assert scene_store.get_scene("nope", SCHEMA_VERSION) is None


def test_regenerating_replaces_rather_than_accumulates(sample_visualization):
    _store(sample_visualization, title="First")
    _store(sample_visualization, title="Second")
    record = scene_store.get_scene("viz_1", SCHEMA_VERSION)
    assert record["scene"]["title"] == "Second"
    assert len(scene_store.list_scenes_for_article("article_1")) == 1


def test_scenes_are_listed_per_article(sample_visualization):
    _store(sample_visualization, viz_id="viz_a", title="Transformer")
    _store(sample_visualization, viz_id="viz_b", title="CNN")
    assert scene_store.get_scene("viz_a", SCHEMA_VERSION)["scene"]["title"] == "Transformer"
    assert scene_store.get_scene("viz_b", SCHEMA_VERSION)["scene"]["title"] == "CNN"
    assert len(scene_store.list_scenes_for_article("article_1")) == 2


def test_update_verification_flips_the_valid_flag(sample_visualization):
    _store(sample_visualization)
    failing = {
        "valid": False,
        "findings": ["forbidden construct: network access via fetch()"],
        "checks": "static",
    }
    updated = scene_store.update_verification("viz_1", failing, SCHEMA_VERSION)
    assert updated["valid"] is False
    assert updated["verification"]["findings"] == failing["findings"]


def test_delete_scenes_for_visualization(sample_visualization):
    _store(sample_visualization, viz_id="viz_a")
    _store(sample_visualization, viz_id="viz_b")
    assert scene_store.delete_scenes_for_visualization("viz_a") == 1
    assert scene_store.get_scene("viz_a", SCHEMA_VERSION) is None
    assert scene_store.get_scene("viz_b", SCHEMA_VERSION) is not None


def test_init_db_is_idempotent(sample_visualization):
    scene_store.init_db()
    scene_store.init_db()
    _store(sample_visualization)
    assert scene_store.get_scene("viz_1", SCHEMA_VERSION) is not None

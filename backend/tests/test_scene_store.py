"""Scene persistence, against a temporary database.

`scene_store` reads `DB_PATH` from `visualization_store` at call time, so both
modules are repointed at a tmp file for the duration of each test. Nothing here
touches the developer's real database.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.rag.scene_ir import parse_scene
from app.rag.scene_verifier import verify_scene
from app.storage import scene_store, visualization_store


@pytest.fixture(autouse=True)
def temp_db(monkeypatch, tmp_path: Path):
    db = tmp_path / "test.sqlite3"
    monkeypatch.setattr(visualization_store, "DB_PATH", db)
    monkeypatch.setattr(visualization_store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(scene_store, "DB_PATH", db)
    monkeypatch.setattr(scene_store, "DATA_DIR", tmp_path)
    scene_store.init_db()
    return db


def _store(transformer_scene, viz_id="viz_1"):
    scene = parse_scene(transformer_scene)
    report = verify_scene(scene)
    return scene_store.upsert_scene(
        viz_id=viz_id,
        article_id="article_1",
        scene=scene.model_dump(mode="json"),
        verification=report.model_dump(mode="json"),
        provider="openai",
        model="gpt-4o-mini",
        extraction_strategy="docling",
    )


def test_insert_and_read_back(transformer_scene):
    record = _store(transformer_scene)
    assert record["viz_id"] == "viz_1"
    assert record["provider"] == "openai"
    assert record["extraction_strategy"] == "docling"
    assert record["valid"] is True
    assert record["created_at"] and record["updated_at"]

    fetched = scene_store.get_scene("viz_1")
    assert fetched is not None
    assert fetched["scene"]["algorithm_name"] == "Transformer self-attention"
    # The stored payload must survive a round trip through the IR unchanged.
    assert parse_scene(fetched["scene"]).steps[0].id == "s1"


def test_missing_scene_returns_none():
    assert scene_store.get_scene("nope") is None


def test_upsert_replaces_rather_than_duplicating(transformer_scene, cnn_scene):
    _store(transformer_scene)
    _store(cnn_scene)
    record = scene_store.get_scene("viz_1")
    assert record is not None
    assert record["scene"]["algorithm_name"] == "CNN convolution pipeline"
    assert len(scene_store.list_scenes_for_article("article_1")) == 1


def test_scene_identity_is_per_visualization(transformer_scene, cnn_scene):
    _store(transformer_scene, viz_id="viz_a")
    _store(cnn_scene, viz_id="viz_b")
    assert scene_store.get_scene("viz_a")["scene"]["algorithm_name"].startswith("Transformer")
    assert scene_store.get_scene("viz_b")["scene"]["algorithm_name"].startswith("CNN")
    assert len(scene_store.list_scenes_for_article("article_1")) == 2


def test_update_verification_without_regenerating(transformer_scene):
    _store(transformer_scene)
    failing = {
        "valid": False,
        "findings": [
            {"code": "made_up", "severity": "error", "message": "m",
             "entity_ids": [], "step_ids": [], "evidence_ids": []}
        ],
        "entity_count": 6,
        "step_count": 5,
        "grounded_entity_ratio": 1.0,
        "grounded_step_ratio": 1.0,
    }
    updated = scene_store.update_verification("viz_1", failing)
    assert updated is not None
    assert updated["valid"] is False
    assert updated["verification"]["findings"][0]["code"] == "made_up"
    # The scene itself is untouched.
    assert updated["scene"]["algorithm_name"] == "Transformer self-attention"


def test_delete_cascade_by_visualization(transformer_scene):
    _store(transformer_scene, viz_id="viz_a")
    _store(transformer_scene, viz_id="viz_b")
    assert scene_store.delete_scenes_for_visualization("viz_a") == 1
    assert scene_store.get_scene("viz_a") is None
    assert scene_store.get_scene("viz_b") is not None


def test_init_db_is_idempotent(transformer_scene):
    scene_store.init_db()
    scene_store.init_db()
    _store(transformer_scene)
    assert scene_store.get_scene("viz_1") is not None

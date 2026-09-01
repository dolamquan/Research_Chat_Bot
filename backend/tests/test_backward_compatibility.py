"""Nothing that worked before may have stopped working.

This suite exists because the change touched shared foundations: `get_llm` is
called from twelve places, `routes/visualizer.py` gained routes below a
catch-all, and `visualization_store` is now imported by a second storage module.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest


# --- get_llm and its callers ---------------------------------------------------


def test_get_llm_signature_is_unchanged():
    """Existing positional and keyword calls must still type-check and run."""
    import inspect

    from app.rag.generator import get_llm

    signature = inspect.signature(get_llm)
    assert list(signature.parameters) == ["model", "temperature", "provider"]
    assert signature.parameters["model"].default == "gpt-4o-mini"
    assert signature.parameters["temperature"].default == 0
    # New parameter must be optional, or every existing call site breaks.
    assert signature.parameters["provider"].default is None


@pytest.mark.parametrize(
    "module_name",
    [
        "app.rag.generator",
        "app.rag.paper_visualizer",
        "app.rag.diagram_mutator",
        "app.rag.research_tools",
        "app.rag.variant_lab",
        "app.rag.variant_verifier",
        "app.rag.variant_chat",
        "app.rag.scene_coder",
        "app.rag.scene_service",
        "app.rag.document_structure",
        "app.rag.llm_provider",
        "app.rag.model_graph",
        "app.storage.visualization_store",
        "app.storage.variant_store",
        "app.storage.scene_store",
        "app.routes.visualizer",
        "app.routes.variants",
        "app.main",
    ],
)
def test_module_imports_cleanly(module_name):
    """A circular import between the new and existing modules would show here."""
    assert importlib.import_module(module_name) is not None


def test_existing_llm_call_sites_still_resolve():
    """Every module that imports get_llm still gets a callable."""
    from app.rag.diagram_mutator import get_llm as mutator_get_llm
    from app.rag.generator import get_llm as generator_get_llm
    from app.rag.paper_visualizer import get_llm as visualizer_get_llm

    for candidate in (generator_get_llm, visualizer_get_llm, mutator_get_llm):
        assert callable(candidate)
    assert visualizer_get_llm is generator_get_llm


# --- routes -------------------------------------------------------------------


def test_all_pre_existing_routes_are_still_registered():
    from app.main import app

    paths = {route.path for route in app.routes}
    for path in (
        "/visualizer/generate",
        "/visualizer/expand-node",
        "/visualizer/item/{viz_id}/expansions",
        "/visualizer/item/{viz_id}",
        "/visualizer/{article_id}",
    ):
        assert path in paths, f"route disappeared: {path}"


def test_scene_routes_do_not_shadow_the_catch_all():
    """`/visualizer/{article_id}` must still be reachable.

    The scene routes were inserted above it deliberately; if any of them were
    registered below, FastAPI would match `/visualizer/providers` as an article
    id instead.
    """
    from app.main import app

    ordered = [route.path for route in app.routes if str(route.path).startswith("/visualizer")]
    catch_all = ordered.index("/visualizer/{article_id}")
    for literal in ("/visualizer/generate-scene", "/visualizer/providers"):
        assert ordered.index(literal) < catch_all, f"{literal} is below the catch-all"


# --- storage ------------------------------------------------------------------


def test_scene_store_shares_the_visualization_database():
    """Storage identity is preserved: one database, not a second one."""
    from app.storage import scene_store, visualization_store

    assert scene_store.DB_PATH == visualization_store.DB_PATH


def test_existing_store_functions_are_intact():
    from app.storage import visualization_store as store

    for name in (
        "init_db",
        "upsert_visualization",
        "get_visualization",
        "get_visualization_by_id",
        "list_visualizations",
        "delete_visualization",
        "upsert_node_expansion",
        "get_node_expansion",
        "list_node_expansions",
        "copy_node_expansions",
        "delete_node_expansions",
        "set_worked_example",
        "set_mechanism_domain",
    ):
        assert hasattr(store, name), f"store function disappeared: {name}"


def test_scene_table_creation_does_not_disturb_existing_tables(monkeypatch, tmp_path: Path):
    """Creating the scene table must leave the diagram tables usable."""
    import sqlite3

    from app.storage import scene_store, visualization_store

    db = tmp_path / "compat.sqlite3"
    for module in (visualization_store, scene_store):
        monkeypatch.setattr(module, "DB_PATH", db)
        monkeypatch.setattr(module, "DATA_DIR", tmp_path)

    visualization_store.init_db()
    scene_store.init_db()

    connection = sqlite3.connect(db)
    tables = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    connection.close()
    assert {"paper_visualizations", "node_expansions", "algorithm_scenes"} <= tables


# --- offline scene derivation ---------------------------------------------------


def test_a_scene_can_be_derived_without_a_model_call(sample_visualization):
    """The offline path still yields playable code straight from the diagram."""
    from app.rag.scene_coder import check_scene_code, scene_code_from_diagram

    scene = scene_code_from_diagram(sample_visualization)
    assert scene["format"] == "threejs-code@1"
    # Every diagram node label is embedded in the generated data block.
    for node in sample_visualization["diagram"]["nodes"]:
        assert node["label"] in scene["code"]
    assert check_scene_code(scene["code"]) == []

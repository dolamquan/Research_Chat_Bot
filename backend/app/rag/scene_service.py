"""Orchestration between the visualizer, the planner and storage.

Routes stay thin by delegating here: this module resolves the visualization and
its article, recovers document structure, plans the scene, verifies it, and
persists the result. It is also the single place that decides when a cached
scene may be reused.

Kept separate from `scene_planner` so that planning stays a pure function of
its inputs and can be tested without touching the database.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List

from app.rag.llm_provider import resolve_provider
from app.rag.document_structure import (
    EXTRACTION_EMPTY,
    StructuredPaper,
    extract_structured_paper,
)
from app.rag.scene_ir import SCHEMA_VERSION, AlgorithmScene, SceneIRError, parse_scene
from app.rag.scene_planner import (
    ScenePlanningError,
    generate_algorithm_scene,
    scene_from_process_steps,
)
from app.rag.scene_verifier import verify_scene
from app.storage.scene_store import get_scene, update_verification, upsert_scene
from app.storage.visualization_store import (
    get_visualization_by_id,
    list_node_expansions,
)

logger = logging.getLogger(__name__)

MAX_SCENE_CHUNKS = 60


class SceneNotFound(LookupError):
    """No scene exists for the requested visualization."""


class VisualizationNotFound(LookupError):
    """The visualization a scene was requested for does not exist."""


def _resolve_pdf_path(article: Dict[str, Any] | None) -> Path | None:
    """Where the original PDF lives, if the article record points at one."""
    if not article:
        return None
    for key in ("file_path", "path", "pdf_path", "source_path", "local_path"):
        value = article.get(key)
        if value:
            candidate = Path(str(value))
            if candidate.exists():
                return candidate
    return None


def load_structured_paper(
    article: Dict[str, Any] | None, chunks: List[Dict[str, Any]]
) -> StructuredPaper:
    """Structured view of the paper, Docling if possible, chunks otherwise."""
    return extract_structured_paper(
        pdf_path=_resolve_pdf_path(article), chunks=chunks
    )


def build_scene(
    viz_id: str,
    force: bool = False,
    provider: str | None = None,
    model: str | None = None,
    llm: Any = None,
) -> Dict[str, Any]:
    """Generate, verify and persist a scene for one visualization.

    A cached scene is returned untouched unless `force` is set or its schema
    version is out of date, because planning is the most expensive call in the
    pipeline and the diagram it describes rarely changes.
    """
    # Validate the request before touching storage: a bad provider name is a
    # 422 about the request, and should not be reported as a missing
    # visualization just because the lookup happened to run first.
    if provider is not None:
        resolve_provider(provider)

    if not force:
        cached = get_scene(viz_id, SCHEMA_VERSION)
        if cached:
            return cached

    record = get_visualization_by_id(viz_id)
    if record is None:
        raise VisualizationNotFound(f"Visualization not found: {viz_id}")

    # Imported here rather than at module scope: these pull in the retriever and
    # article store, and keeping the import local means unit tests can exercise
    # `build_scene` with a stubbed planner without a live vector store.
    from app.rag.retriever import retrieve_document_chunks
    from app.storage.article_store import get_article

    try:
        article = get_article(record["article_id"])
    except ValueError:
        article = None

    chunks = retrieve_document_chunks(
        document_source=record["document_source"], limit=MAX_SCENE_CHUNKS
    )
    structured_paper = load_structured_paper(article, chunks)

    scene, origin = generate_algorithm_scene(
        visualization=record,
        article=article,
        structured_paper=structured_paper,
        chunks=chunks,
        llm=llm,
        force=force,
        provider=provider,
        model=model,
    )

    report = verify_scene(scene)

    return upsert_scene(
        viz_id=viz_id,
        article_id=record["article_id"],
        scene=scene.model_dump(mode="json"),
        verification=report.model_dump(mode="json"),
        provider=origin.get("provider", ""),
        model=origin.get("model", ""),
        extraction_strategy=structured_paper.extraction_strategy,
        schema_version=SCHEMA_VERSION,
    )


def fetch_scene(viz_id: str) -> Dict[str, Any]:
    """The stored scene for a visualization, or raise `SceneNotFound`."""
    record = get_scene(viz_id, SCHEMA_VERSION)
    if record is None:
        raise SceneNotFound(f"No scene has been generated for {viz_id}")
    return record


def reverify_scene(viz_id: str) -> Dict[str, Any]:
    """Re-run deterministic verification against the stored scene.

    Useful after the verifier itself changes: no model call, no regeneration.
    """
    record = fetch_scene(viz_id)
    try:
        scene = parse_scene(record["scene"])
    except SceneIRError as error:
        # A stored scene that no longer parses is a real finding, not a crash.
        failure = {
            "valid": False,
            "findings": [
                {
                    "code": "scene_parse_failed",
                    "severity": "error",
                    "message": f"Stored scene no longer validates: {error}",
                    "entity_ids": [],
                    "step_ids": [],
                    "evidence_ids": [],
                }
            ],
            "entity_count": 0,
            "step_count": 0,
            "grounded_entity_ratio": 0.0,
            "grounded_step_ratio": 0.0,
        }
        updated = update_verification(viz_id, failure, SCHEMA_VERSION)
        return updated or record

    report = verify_scene(scene)
    updated = update_verification(viz_id, report.model_dump(mode="json"), SCHEMA_VERSION)
    return updated or record


def build_scene_from_expansions(viz_id: str) -> Dict[str, Any]:
    """Derive a scene from stored storyboards, with no model call.

    The offline path: it lets papers explored before the Scene IR existed play
    in the new player straight away, and gives the API something to return when
    no provider is configured. The result is deliberately uncited, so the
    verifier marks it low-confidence rather than presenting it as grounded.
    """
    record = get_visualization_by_id(viz_id)
    if record is None:
        raise VisualizationNotFound(f"Visualization not found: {viz_id}")

    expansions = list_node_expansions(viz_id)
    scene: AlgorithmScene = scene_from_process_steps(record, expansions)
    report = verify_scene(scene)

    return upsert_scene(
        viz_id=viz_id,
        article_id=record["article_id"],
        scene=scene.model_dump(mode="json"),
        verification=report.model_dump(mode="json"),
        provider="none",
        model="derived-from-process-steps",
        extraction_strategy=EXTRACTION_EMPTY,
        schema_version=SCHEMA_VERSION,
    )

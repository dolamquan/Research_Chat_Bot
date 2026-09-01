"""Orchestration between the visualizer, the scene coder and storage.

Routes stay thin by delegating here: this module resolves the visualization and
its article, recovers document structure, has the model write the scene code,
runs the static contract checks, and persists the result. It is also the single
place that decides when a cached scene may be reused.

Kept separate from `scene_coder` so that code generation stays a pure function
of its inputs and can be tested without touching the database.
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
from app.rag.scene_coder import (
    SCHEMA_VERSION,
    SceneCodingError,
    check_scene_code,
    generate_scene_code,
    generate_stage_code,
    scene_code_from_diagram,
)
from app.storage.scene_store import get_scene, update_verification, upsert_scene
from app.storage.stage_scene_store import (
    get_stage_scene,
    list_stage_scenes,
    upsert_stage_scene,
)
from app.storage.visualization_store import (
    get_node_expansion,
    get_visualization_by_id,
)

logger = logging.getLogger(__name__)

MAX_SCENE_CHUNKS = 60


class SceneNotFound(LookupError):
    """No scene exists for the requested visualization."""


class VisualizationNotFound(LookupError):
    """The visualization a scene was requested for does not exist."""


class NodeNotFound(LookupError):
    """The diagram has no node with the requested id."""


def _verification_report(findings: List[str]) -> Dict[str, Any]:
    """The static-check result in the shape `scene_store` persists.

    Far lighter than the old grounding report: with generated code there is
    nothing to ground, only contract violations to name.
    """
    return {"valid": not findings, "findings": findings, "checks": "static"}


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
    """Generate, check and persist scene code for one visualization.

    A cached scene is returned untouched unless `force` is set or its schema
    version is out of date, because code generation is the most expensive call
    in the pipeline and the diagram it animates rarely changes.
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
    # `build_scene` with a stubbed coder without a live vector store.
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

    scene, origin = generate_scene_code(
        visualization=record,
        article=article,
        structured_paper=structured_paper,
        chunks=chunks,
        llm=llm,
        provider=provider,
        model=model,
    )

    report = _verification_report(check_scene_code(scene.get("code", "")))

    return upsert_scene(
        viz_id=viz_id,
        article_id=record["article_id"],
        scene=scene,
        verification=report,
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
    """Re-run the static contract checks against the stored scene code.

    Useful after the checks themselves change: no model call, no regeneration.
    """
    record = fetch_scene(viz_id)
    code = str((record.get("scene") or {}).get("code", ""))
    report = _verification_report(check_scene_code(code))
    updated = update_verification(viz_id, report, SCHEMA_VERSION)
    return updated or record


def build_scene_from_expansions(viz_id: str) -> Dict[str, Any]:
    """Derive a scene from the stored diagram, with no model call.

    The offline path: it gives the API something playable when no provider is
    configured. The name is kept from the old pipeline so callers and routes
    are untouched; the diagram, not the expansions, is now the source because
    the code template animates nodes and edges directly.
    """
    record = get_visualization_by_id(viz_id)
    if record is None:
        raise VisualizationNotFound(f"Visualization not found: {viz_id}")

    scene = scene_code_from_diagram(record)
    report = _verification_report(check_scene_code(scene.get("code", "")))

    return upsert_scene(
        viz_id=viz_id,
        article_id=record["article_id"],
        scene=scene,
        verification=report,
        provider="none",
        model="diagram-template",
        extraction_strategy=EXTRACTION_EMPTY,
        schema_version=SCHEMA_VERSION,
    )


def build_stage_scene(
    viz_id: str,
    node_id: str,
    force: bool = False,
    provider: str | None = None,
    model: str | None = None,
    llm: Any = None,
) -> Dict[str, Any]:
    """Generate, check and persist stage code for one diagram node.

    Cached like `build_scene`: a stage animates one component, and neither the
    node nor its stored expansion changes often. The node's expansion (when one
    exists) supplies the mechanism text the code is written from; a node that
    was never expanded still gets a scene from the diagram context alone.
    """
    if provider is not None:
        resolve_provider(provider)

    if not force:
        cached = get_stage_scene(viz_id, node_id, SCHEMA_VERSION)
        if cached:
            return cached

    record = get_visualization_by_id(viz_id)
    if record is None:
        raise VisualizationNotFound(f"Visualization not found: {viz_id}")

    nodes = (record.get("diagram") or {}).get("nodes") or []
    node = next((n for n in nodes if str(n.get("id")) == node_id), None)
    if node is None:
        raise NodeNotFound(f"Node not found in diagram: {node_id}")

    from app.rag.paper_visualizer import _stage_context
    from app.rag.retriever import retrieve_document_chunks
    from app.storage.article_store import get_article

    try:
        article = get_article(record["article_id"])
    except ValueError:
        article = None

    expansion = get_node_expansion(viz_id, node_id)

    # Excerpts about THIS stage, retrieved by the stage's own label and detail,
    # so the code is written from the section that describes the mechanism
    # rather than the paper's opening pages. Best-effort like everything else.
    try:
        chunks = retrieve_document_chunks(
            document_source=record["document_source"], limit=MAX_SCENE_CHUNKS
        )
        stage_context = _stage_context(record, node, chunks)
    except Exception:
        stage_context = ""

    scene, origin = generate_stage_code(
        visualization=record,
        node=node,
        expansion=expansion,
        article=article,
        stage_context=stage_context,
        llm=llm,
        provider=provider,
        model=model,
    )

    report = _verification_report(check_scene_code(scene.get("code", "")))

    return upsert_stage_scene(
        viz_id=viz_id,
        node_id=node_id,
        scene=scene,
        verification=report,
        provider=origin.get("provider", ""),
        model=origin.get("model", ""),
        schema_version=SCHEMA_VERSION,
    )


def fetch_stage_scenes(viz_id: str) -> List[Dict[str, Any]]:
    """Every stored stage scene for a visualization (possibly empty)."""
    return list_stage_scenes(viz_id, SCHEMA_VERSION)


__all__ = [
    "NodeNotFound",
    "SceneCodingError",
    "SceneNotFound",
    "VisualizationNotFound",
    "build_scene",
    "build_scene_from_expansions",
    "build_stage_scene",
    "fetch_scene",
    "fetch_stage_scenes",
    "load_structured_paper",
    "reverify_scene",
]

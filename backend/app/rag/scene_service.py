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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from app.rag.llm_provider import resolve_provider
from app.rag.scene_requests import share_scene_request
from app.rag.retriever import PaperStoreUnavailable
from app.rag.document_structure import (
    EXTRACTION_EMPTY,
    StructuredPaper,
    extract_structured_paper,
)
from app.rag.scene_coder import (
    SCHEMA_VERSION,
    SceneCodingError,
    check_scene_code,
    classify_refinement,
    generate_scene_code,
    generate_stage_code,
    refine_scene_code,
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


class RefinementNeedsAcknowledgement(RuntimeError):
    """The requested change alters the method itself; the user must confirm first."""

    def __init__(self, classification: Dict[str, Any]) -> None:
        super().__init__(classification.get("reason") or "This change alters the method shown.")
        self.classification = classification


# A freshly written scene has passed the static checks and nothing else. Only
# the browser can execute it, so it stays `unverified` until the player probes
# it and reports back; "ready" in the UI means `passed`, never merely stored.
RUNTIME_UNVERIFIED: Dict[str, Any] = {"status": "unverified"}
MAX_REPORTED_OVERLAPS = 20


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _verification_report(
    findings: List[str], runtime: Dict[str, Any] | None = None
) -> Dict[str, Any]:
    """The static-check result in the shape `scene_store` persists.

    Far lighter than the old grounding report: with generated code there is
    nothing to ground, only contract violations to name. `runtime` is the
    browser's verdict when one exists; a new scene starts unverified.
    """
    return {
        "valid": not findings,
        "findings": findings,
        "checks": "static",
        "runtime": dict(runtime or RUNTIME_UNVERIFIED),
    }


def _runtime_verdict(report: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise what the browser sends after probing a scene.

    Only the fields the repair prompt and the UI use are kept, and every text
    field is bounded: this is untrusted client input that ends up both in the
    database and in a model prompt.
    """
    status = str(report.get("status") or "")
    if status not in {"passed", "failed"}:
        raise ValueError(f"Unknown runtime status: {status!r}")
    verdict: Dict[str, Any] = {"status": status, "checked_at": _now_iso()}
    error = report.get("error")
    if error:
        verdict["error"] = str(error)[:2000]
    overlaps = []
    for pair in list(report.get("overlaps") or []):
        if len(overlaps) >= MAX_REPORTED_OVERLAPS:
            break
        if not isinstance(pair, dict):
            continue
        seconds = [float(s) for s in list(pair.get("seconds") or [])[:12] if isinstance(s, (int, float))]
        overlaps.append({
            "a": str(pair.get("a") or "")[:80],
            "b": str(pair.get("b") or "")[:80],
            "seconds": seconds,
        })
    verdict["overlaps"] = overlaps
    if report.get("samples") is not None:
        verdict["samples"] = int(report["samples"])
    return verdict


def _previous_code(record: Dict[str, Any] | None) -> str | None:
    code = str(((record or {}).get("scene") or {}).get("code") or "")
    return code or None


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


@share_scene_request
def build_scene(
    viz_id: str,
    force: bool = False,
    provider: str | None = None,
    model: str | None = None,
    llm: Any = None,
    runtime_error: str | None = None,
    layout_report: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Generate, check and persist scene code for one visualization.

    A cached scene is returned untouched unless `force` is set or its schema
    version is out of date, because code generation is the most expensive call
    in the pipeline and the diagram it animates rarely changes.

    `runtime_error` / `layout_report` come from the browser after it probed
    the stored scene. With `force`, the stored code is handed back to the
    model with that evidence as a repair rather than a fresh generation.
    """
    # Validate the request before touching storage: a bad provider name is a
    # 422 about the request, and should not be reported as a missing
    # visualization just because the lookup happened to run first.
    if provider is not None:
        resolve_provider(provider)

    cached = get_scene(viz_id, SCHEMA_VERSION)
    if not force:
        if cached and not check_scene_code(str((cached.get("scene") or {}).get("code", ""))):
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
        previous_code=_previous_code(cached) if force else None,
        runtime_error=runtime_error,
        layout_report=layout_report,
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


@share_scene_request
def build_stage_scene(
    viz_id: str,
    node_id: str,
    force: bool = False,
    provider: str | None = None,
    model: str | None = None,
    llm: Any = None,
    runtime_error: str | None = None,
    layout_report: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Generate, check and persist stage code for one diagram node.

    Cached like `build_scene`: a stage animates one component, and neither the
    node nor its stored expansion changes often. The node's expansion (when one
    exists) supplies the mechanism text the code is written from; a node that
    was never expanded still gets a scene from the diagram context alone.
    `runtime_error` / `layout_report` turn a forced rebuild into a repair of
    the stored code, exactly as in `build_scene`.
    """
    if provider is not None:
        resolve_provider(provider)

    cached = get_stage_scene(viz_id, node_id, SCHEMA_VERSION)
    if not force:
        if cached and not check_scene_code(str((cached.get("scene") or {}).get("code", ""))):
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
    except PaperStoreUnavailable:
        # Do not silently generate a new scene without its paper during an outage.
        raise
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
        previous_code=_previous_code(cached) if force else None,
        runtime_error=runtime_error,
        layout_report=layout_report,
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
    return [record for record in list_stage_scenes(viz_id, SCHEMA_VERSION)
            if not check_scene_code(str((record.get("scene") or {}).get("code", "")))]


# --- runtime verdicts -------------------------------------------------------------


def record_scene_runtime(viz_id: str, report: Dict[str, Any]) -> Dict[str, Any]:
    """Store the browser's verdict on the whole-method scene.

    Static validity is untouched: a scene can be contract-complete and still
    crash at runtime, and the two facts are kept apart so the UI can say which.
    """
    record = fetch_scene(viz_id)
    verification = {**(record.get("verification") or {}), "runtime": _runtime_verdict(report)}
    updated = update_verification(viz_id, verification, SCHEMA_VERSION)
    return updated or record


def record_stage_runtime(viz_id: str, node_id: str, report: Dict[str, Any]) -> Dict[str, Any]:
    """Store the browser's verdict on one stage scene."""
    record = get_stage_scene(viz_id, node_id, SCHEMA_VERSION)
    if record is None:
        raise SceneNotFound(f"No stage scene has been generated for {viz_id}/{node_id}")
    verification = {**(record.get("verification") or {}), "runtime": _runtime_verdict(report)}
    # The store upserts on (viz, node, version); re-sending the scene as-is
    # updates only the verification and timestamp.
    return upsert_stage_scene(
        viz_id=viz_id,
        node_id=node_id,
        scene=record["scene"],
        verification=verification,
        provider=record.get("provider", ""),
        model=record.get("model", ""),
        schema_version=SCHEMA_VERSION,
    )


# --- user-directed refinement ---------------------------------------------------


def _classify_or_acknowledge(
    instruction: str,
    acknowledge_fundamental: bool,
    *,
    title: str,
    llm: Any,
    provider: str | None,
    model: str | None,
) -> Dict[str, Any]:
    """Classify the request, or accept the user's acknowledgement of a fundamental one.

    The acknowledgement only ever follows a refused attempt, so there is
    nothing left to decide: the user has seen the warning and chosen to
    proceed, and the record says so.
    """
    if acknowledge_fundamental:
        return {
            "kind": "fundamental",
            "reason": "The user acknowledged that this changes the method shown.",
            "basis": "acknowledged",
        }
    classification = classify_refinement(
        instruction, title=title, llm=llm, provider=provider, model=model
    )
    if classification.get("kind") == "fundamental":
        raise RefinementNeedsAcknowledgement(classification)
    return classification


def _refined_scene(
    scene: Dict[str, Any], code: str, instruction: str, classification: Dict[str, Any]
) -> Dict[str, Any]:
    """The stored document with new code and one more entry in its edit trail.

    The trail is what lets the UI say "edited by you" and, after a fundamental
    change, "no longer follows the paper" — claims that must survive reloads.
    """
    edits = list(scene.get("edits") or [])
    edits.append({
        "instruction": " ".join(instruction.split())[:2000],
        "kind": classification.get("kind", "cosmetic"),
        "basis": classification.get("basis", ""),
        "at": _now_iso(),
    })
    return {**scene, "code": code, "edits": edits}


def refine_scene(
    viz_id: str,
    instruction: str,
    acknowledge_fundamental: bool = False,
    provider: str | None = None,
    model: str | None = None,
    llm: Any = None,
) -> Dict[str, Any]:
    """Apply one user-described change to the whole-method scene.

    Returns `{"scene": record, "classification": {...}}`. Raises
    `RefinementNeedsAcknowledgement` — before any code is generated — when the
    change would alter the method and the user has not yet confirmed.
    """
    if provider is not None:
        resolve_provider(provider)
    record = fetch_scene(viz_id)
    scene = record.get("scene") or {}
    title = str(scene.get("title") or scene.get("algorithm_name") or "")
    classification = _classify_or_acknowledge(
        instruction, acknowledge_fundamental, title=title, llm=llm, provider=provider, model=model
    )
    code, origin = refine_scene_code(
        str(scene.get("code") or ""), instruction,
        title=title, kind=classification["kind"], llm=llm, provider=provider, model=model,
    )
    updated = upsert_scene(
        viz_id=viz_id,
        article_id=record["article_id"],
        scene=_refined_scene(scene, code, instruction, classification),
        verification=_verification_report(check_scene_code(code)),
        provider=origin.get("provider", ""),
        model=origin.get("model", ""),
        extraction_strategy=record.get("extraction_strategy", ""),
        schema_version=SCHEMA_VERSION,
    )
    return {"scene": updated, "classification": classification}


def refine_stage_scene(
    viz_id: str,
    node_id: str,
    instruction: str,
    acknowledge_fundamental: bool = False,
    provider: str | None = None,
    model: str | None = None,
    llm: Any = None,
) -> Dict[str, Any]:
    """Apply one user-described change to a stage scene; see `refine_scene`."""
    if provider is not None:
        resolve_provider(provider)
    record = get_stage_scene(viz_id, node_id, SCHEMA_VERSION)
    if record is None:
        raise SceneNotFound(f"No stage scene has been generated for {viz_id}/{node_id}")
    scene = record.get("scene") or {}
    title = str(scene.get("title") or scene.get("algorithm_name") or "")
    classification = _classify_or_acknowledge(
        instruction, acknowledge_fundamental, title=title, llm=llm, provider=provider, model=model
    )
    code, origin = refine_scene_code(
        str(scene.get("code") or ""), instruction,
        title=title, kind=classification["kind"], llm=llm, provider=provider, model=model,
    )
    updated = upsert_stage_scene(
        viz_id=viz_id,
        node_id=node_id,
        scene=_refined_scene(scene, code, instruction, classification),
        verification=_verification_report(check_scene_code(code)),
        provider=origin.get("provider", ""),
        model=origin.get("model", ""),
        schema_version=SCHEMA_VERSION,
    )
    return {"stage_scene": updated, "classification": classification}


__all__ = [
    "NodeNotFound",
    "RUNTIME_UNVERIFIED",
    "RefinementNeedsAcknowledgement",
    "SceneCodingError",
    "SceneNotFound",
    "VisualizationNotFound",
    "build_scene",
    "build_scene_from_expansions",
    "build_stage_scene",
    "fetch_scene",
    "fetch_stage_scenes",
    "load_structured_paper",
    "record_scene_runtime",
    "record_stage_runtime",
    "refine_scene",
    "refine_stage_scene",
    "reverify_scene",
]

from typing import Any, Dict, List, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.rag.llm_provider import (
    ProviderNotConfigured,
    UnknownProvider,
    available_providers,
)
from app.rag.paper_visualizer import expand_node, generate_paper_visualization
from app.rag.retriever import PaperStoreUnavailable
from app.rag.scene_coder import SceneCodingError
from app.rag.scene_service import (
    NodeNotFound,
    RefinementNeedsAcknowledgement,
    SceneNotFound,
    VisualizationNotFound,
    build_scene,
    build_scene_from_expansions,
    build_stage_scene,
    fetch_scene,
    fetch_stage_scenes,
    record_scene_runtime,
    record_stage_runtime,
    refine_scene,
    refine_stage_scene,
    reverify_scene,
)
from app.auth.context import current_user
from app.storage.scene_store import delete_scenes_for_visualization
from app.storage.stage_scene_store import delete_stage_scenes_for_visualization
from app.storage.variant_store import delete_variants_for_visualization, get_variant
from app.storage.visualization_store import (
    delete_node_expansions,
    delete_visualization,
    get_visualization_by_id,
    list_expanded_node_ids,
    list_node_expansions,
    list_visualizations,
)


router = APIRouter(prefix="/visualizer", tags=["visualizer"])


def _owned_by_caller(target_id: str) -> bool:
    """Scenes, expansions and stage scenes hang off a diagram (or variant).

    When that diagram exists and belongs to someone else, its derived data
    must look absent. A diagram that no longer exists protects nothing, so
    the scene lookups keep their own "no scene" answers.
    """
    record = get_visualization_by_id(target_id, owner_id=None) or get_variant(target_id, owner_id=None)
    if record is None:
        return True
    owner = record.get("owner_id")
    user = current_user()
    if owner is None:
        # Pre-account data: the administrator's until claimed.
        return user is None or user.is_admin
    return user is not None and user.id == owner


def _require_owned(target_id: str) -> None:
    if not _owned_by_caller(target_id):
        raise HTTPException(status_code=404, detail=f"Diagram not found: {target_id}")


class GenerateVisualizationRequest(BaseModel):
    article_id: str
    diagram_kind: Literal["auto", "architecture", "method_flow", "pipeline"] = "auto"
    force: bool = False


@router.post("/generate")
def generate_visualization_endpoint(request: GenerateVisualizationRequest) -> Dict[str, Any]:
    try:
        visualization = generate_paper_visualization(
            article_id=request.article_id,
            diagram_kind=request.diagram_kind,
            force=request.force,
        )
    except PaperStoreUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        message = str(error)
        status = 404 if "not found" in message.lower() else 422
        raise HTTPException(status_code=status, detail=message) from error
    except Exception as error:
        raise HTTPException(
            status_code=502, detail=f"Visualization generation failed: {error}"
        ) from error
    return {"visualization": visualization}


class ExpandNodeRequest(BaseModel):
    viz_id: str
    node_id: str
    force: bool = False


@router.post("/expand-node")
def expand_node_endpoint(request: ExpandNodeRequest) -> Dict[str, Any]:
    try:
        expansion = expand_node(
            viz_id=request.viz_id,
            node_id=request.node_id,
            force=request.force,
        )
    except PaperStoreUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        message = str(error)
        status = 404 if "not found" in message.lower() else 422
        raise HTTPException(status_code=status, detail=message) from error
    except Exception as error:
        raise HTTPException(
            status_code=502, detail=f"Node expansion failed: {error}"
        ) from error
    return {"expansion": expansion}


@router.get("/item/{viz_id}/expansions")
def list_prepared_stages(viz_id: str) -> Dict[str, Any]:
    """Prepared node ids plus their stored storyboards.

    The 3D scene builds each stage's internal machinery from these primitives,
    so it needs the content, not just which stages exist.
    """
    _require_owned(viz_id)
    return {
        "prepared": list_expanded_node_ids(viz_id),
        "expansions": list_node_expansions(viz_id),
    }


class GenerateSceneRequest(BaseModel):
    viz_id: str
    force: bool = False
    provider: str | None = None
    model: str | None = None
    # When no provider is configured, derive a scene from stored storyboards
    # rather than failing outright. Off by default so a misconfigured
    # deployment is visible instead of silently degraded.
    allow_offline_fallback: bool = False
    # Evidence from the browser's probe of the stored scene. With `force`,
    # the rebuild becomes a repair of that code instead of a fresh attempt.
    runtime_error: str | None = Field(default=None, max_length=4000)
    layout_report: Dict[str, Any] | None = None


@router.post("/generate-scene")
def generate_scene_endpoint(request: GenerateSceneRequest) -> Dict[str, Any]:
    """Generate, check and persist Three.js scene code for one visualization."""
    # No pre-check here: build_scene resolves the diagram through the scoped
    # store itself, so someone else's id already surfaces as VisualizationNotFound.
    try:
        record = build_scene(
            viz_id=request.viz_id,
            force=request.force,
            provider=request.provider,
            model=request.model,
            runtime_error=request.runtime_error,
            layout_report=request.layout_report,
        )
    except PaperStoreUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except VisualizationNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except UnknownProvider as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ProviderNotConfigured as error:
        if request.allow_offline_fallback:
            record = build_scene_from_expansions(request.viz_id)
            return {"scene": record, "fallback": "diagram_template"}
        # The message names the missing variable, never its value.
        raise HTTPException(status_code=502, detail=str(error)) from error
    except SceneCodingError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    return {"scene": record}


@router.get("/item/{viz_id}/scene")
def get_scene_endpoint(viz_id: str) -> Dict[str, Any]:
    _require_owned(viz_id)
    try:
        return {"scene": fetch_scene(viz_id)}
    except SceneNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/item/{viz_id}/verify-scene")
def verify_scene_endpoint(viz_id: str) -> Dict[str, Any]:
    """Re-run deterministic verification. No model call, no regeneration."""
    _require_owned(viz_id)
    try:
        return {"scene": reverify_scene(viz_id)}
    except SceneNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


class GenerateStageSceneRequest(BaseModel):
    viz_id: str
    node_id: str
    force: bool = False
    provider: str | None = None
    model: str | None = None
    runtime_error: str | None = Field(default=None, max_length=4000)
    layout_report: Dict[str, Any] | None = None


@router.post("/generate-stage-scene")
def generate_stage_scene_endpoint(request: GenerateStageSceneRequest) -> Dict[str, Any]:
    """Generate, check and persist Three.js code for ONE diagram node."""
    try:
        record = build_stage_scene(
            viz_id=request.viz_id,
            node_id=request.node_id,
            force=request.force,
            provider=request.provider,
            model=request.model,
            runtime_error=request.runtime_error,
            layout_report=request.layout_report,
        )
    except PaperStoreUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except (VisualizationNotFound, NodeNotFound) as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except UnknownProvider as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ProviderNotConfigured as error:
        # No offline template here: the classic stage theater is the fallback
        # tier and already renders without a model.
        raise HTTPException(status_code=502, detail=str(error)) from error
    except SceneCodingError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    return {"stage_scene": record}


@router.get("/item/{viz_id}/stage-scenes")
def list_stage_scenes_endpoint(viz_id: str) -> Dict[str, Any]:
    """Every stored stage scene for a visualization. Empty list, never 404:
    the frontend polls this to decide which nodes can play dynamically."""
    if not _owned_by_caller(viz_id):
        return {"stage_scenes": []}
    return {"stage_scenes": fetch_stage_scenes(viz_id)}


# --- runtime verdicts ---------------------------------------------------------
#
# The backend cannot execute Three.js. After the browser probes a scene — runs
# init, sweeps update() across the animation cycle, measures label overlaps —
# it posts the verdict here so "ready" survives a reload and a failed scene is
# never counted as prepared.


class RuntimeReportRequest(BaseModel):
    status: Literal["passed", "failed"]
    error: str | None = Field(default=None, max_length=4000)
    overlaps: List[Dict[str, Any]] = Field(default_factory=list, max_length=50)
    samples: int | None = Field(default=None, ge=0, le=1000)


@router.post("/item/{viz_id}/runtime")
def report_scene_runtime_endpoint(viz_id: str, request: RuntimeReportRequest) -> Dict[str, Any]:
    _require_owned(viz_id)
    try:
        return {"scene": record_scene_runtime(viz_id, request.model_dump())}
    except SceneNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/item/{viz_id}/stage-scenes/{node_id}/runtime")
def report_stage_runtime_endpoint(
    viz_id: str, node_id: str, request: RuntimeReportRequest
) -> Dict[str, Any]:
    _require_owned(viz_id)
    try:
        return {"stage_scene": record_stage_runtime(viz_id, node_id, request.model_dump())}
    except SceneNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


# --- user-directed refinement -------------------------------------------------


class RefineRequest(BaseModel):
    instruction: str = Field(min_length=3, max_length=2000)
    # A change that alters the method itself is refused with 409 until the
    # user has seen the warning and re-sent the request with this set.
    acknowledge_fundamental: bool = False
    provider: str | None = None
    model: str | None = None


def _refinement_errors(run):
    """Shared error mapping for both refine endpoints."""
    try:
        return run()
    except RefinementNeedsAcknowledgement as error:
        # 409: the request is well-formed but conflicts with what the scene
        # claims to be (an illustration of the paper). Nothing was generated.
        raise HTTPException(
            status_code=409,
            detail={"code": "needs_acknowledgement", **error.classification},
        ) from error
    except SceneNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except UnknownProvider as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (ProviderNotConfigured, SceneCodingError) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.post("/item/{viz_id}/refine")
def refine_scene_endpoint(viz_id: str, request: RefineRequest) -> Dict[str, Any]:
    """Apply one user-described change to the whole-method scene."""
    _require_owned(viz_id)
    return _refinement_errors(lambda: refine_scene(
        viz_id,
        request.instruction,
        acknowledge_fundamental=request.acknowledge_fundamental,
        provider=request.provider,
        model=request.model,
    ))


@router.post("/item/{viz_id}/stage-scenes/{node_id}/refine")
def refine_stage_scene_endpoint(
    viz_id: str, node_id: str, request: RefineRequest
) -> Dict[str, Any]:
    """Apply one user-described change to a stage scene."""
    _require_owned(viz_id)
    return _refinement_errors(lambda: refine_stage_scene(
        viz_id,
        node_id,
        request.instruction,
        acknowledge_fundamental=request.acknowledge_fundamental,
        provider=request.provider,
        model=request.model,
    ))


@router.get("/providers")
def list_providers_endpoint() -> Dict[str, Any]:
    """Which providers this deployment can actually reach. Never returns keys."""
    return {"providers": available_providers()}


@router.get("/{article_id}")
def get_article_visualizations(article_id: str) -> Dict[str, Any]:
    """The signed-in user's diagrams for a paper."""
    return {"visualizations": list_visualizations(article_id)}


@router.delete("/item/{viz_id}")
def delete_visualization_endpoint(viz_id: str) -> Dict[str, Any]:
    _require_owned(viz_id)
    # Variants descend from this diagram, so they go first. Done here rather
    # than in the store to keep the two storage modules independent.
    variant_ids = delete_variants_for_visualization(viz_id)
    for variant_id in variant_ids:
        delete_node_expansions(variant_id)
        delete_scenes_for_visualization(variant_id)
        delete_stage_scenes_for_visualization(variant_id)
    delete_stage_scenes_for_visualization(viz_id)
    scenes_deleted = delete_scenes_for_visualization(viz_id)
    if not delete_visualization(viz_id):
        raise HTTPException(status_code=404, detail="Visualization not found")
    return {
        "status": "deleted",
        "variants_deleted": len(variant_ids),
        "scenes_deleted": scenes_deleted,
    }

from typing import Any, Dict, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.rag.llm_provider import (
    ProviderNotConfigured,
    UnknownProvider,
    available_providers,
)
from app.rag.paper_visualizer import expand_node, generate_paper_visualization
from app.rag.scene_ir import SceneIRError
from app.rag.scene_planner import ScenePlanningError
from app.rag.scene_service import (
    SceneNotFound,
    VisualizationNotFound,
    build_scene,
    build_scene_from_expansions,
    fetch_scene,
    reverify_scene,
)
from app.storage.scene_store import delete_scenes_for_visualization
from app.storage.variant_store import delete_variants_for_visualization
from app.storage.visualization_store import (
    delete_node_expansions,
    delete_visualization,
    list_expanded_node_ids,
    list_node_expansions,
    list_visualizations,
)


router = APIRouter(prefix="/visualizer", tags=["visualizer"])


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


@router.post("/generate-scene")
def generate_scene_endpoint(request: GenerateSceneRequest) -> Dict[str, Any]:
    """Plan, verify and persist an AlgorithmScene for one visualization."""
    try:
        record = build_scene(
            viz_id=request.viz_id,
            force=request.force,
            provider=request.provider,
            model=request.model,
        )
    except VisualizationNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except UnknownProvider as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except SceneIRError as error:
        raise HTTPException(
            status_code=422, detail=f"Generated scene failed validation: {error}"
        ) from error
    except ProviderNotConfigured as error:
        if request.allow_offline_fallback:
            record = build_scene_from_expansions(request.viz_id)
            return {"scene": record, "fallback": "process_steps"}
        # The message names the missing variable, never its value.
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ScenePlanningError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    return {"scene": record}


@router.get("/item/{viz_id}/scene")
def get_scene_endpoint(viz_id: str) -> Dict[str, Any]:
    try:
        return {"scene": fetch_scene(viz_id)}
    except SceneNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/item/{viz_id}/verify-scene")
def verify_scene_endpoint(viz_id: str) -> Dict[str, Any]:
    """Re-run deterministic verification. No model call, no regeneration."""
    try:
        return {"scene": reverify_scene(viz_id)}
    except SceneNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/providers")
def list_providers_endpoint() -> Dict[str, Any]:
    """Which providers this deployment can actually reach. Never returns keys."""
    return {"providers": available_providers()}


@router.get("/{article_id}")
def get_article_visualizations(article_id: str) -> Dict[str, Any]:
    return {"visualizations": list_visualizations(article_id)}


@router.delete("/item/{viz_id}")
def delete_visualization_endpoint(viz_id: str) -> Dict[str, Any]:
    # Variants descend from this diagram, so they go first. Done here rather
    # than in the store to keep the two storage modules independent.
    variant_ids = delete_variants_for_visualization(viz_id)
    for variant_id in variant_ids:
        delete_node_expansions(variant_id)
        delete_scenes_for_visualization(variant_id)
    scenes_deleted = delete_scenes_for_visualization(viz_id)
    if not delete_visualization(viz_id):
        raise HTTPException(status_code=404, detail="Visualization not found")
    return {
        "status": "deleted",
        "variants_deleted": len(variant_ids),
        "scenes_deleted": scenes_deleted,
    }

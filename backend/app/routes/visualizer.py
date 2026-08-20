from typing import Any, Dict, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.rag.paper_visualizer import expand_node, generate_paper_visualization
from app.storage.visualization_store import (
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


@router.get("/{article_id}")
def get_article_visualizations(article_id: str) -> Dict[str, Any]:
    return {"visualizations": list_visualizations(article_id)}


@router.delete("/item/{viz_id}")
def delete_visualization_endpoint(viz_id: str) -> Dict[str, Any]:
    if not delete_visualization(viz_id):
        raise HTTPException(status_code=404, detail="Visualization not found")
    return {"status": "deleted"}

from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.rag.clusterer import (
    build_cluster_graph,
    get_cluster_documents,
    get_document_detail,
    load_clusters,
)


router = APIRouter(prefix="/clusters", tags=["clusters"])


class BuildClustersRequest(BaseModel):
    cluster_count: int | None = Field(default=None, ge=1, le=50)


@router.get("")
def get_clusters() -> Dict[str, Any]:
    """
    Return the latest saved document topology and cluster assignments.
    """
    return load_clusters()


@router.get("/documents/detail")
def get_cluster_document_detail(source: str, chunk_limit: int = 5) -> Dict[str, Any]:
    """
    Return article metadata and representative chunks for the details sidebar.
    """
    try:
        return get_document_detail(source=source, chunk_limit=chunk_limit)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{cluster_id}/documents")
def list_cluster_documents(cluster_id: int) -> Dict[str, Any]:
    """
    Return papers that belong to one selected cluster.
    """
    return {
        "cluster_id": cluster_id,
        "documents": get_cluster_documents(cluster_id),
    }


@router.post("/build")
def build_clusters(request: BuildClustersRequest) -> Dict[str, Any]:
    """
    Rebuild article-level clusters from the vectors currently stored in Qdrant.
    """
    try:
        return build_cluster_graph(cluster_count=request.cluster_count)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to build clusters: {exc}",
        ) from exc

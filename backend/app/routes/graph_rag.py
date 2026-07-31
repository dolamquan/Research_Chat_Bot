from typing import List, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app.rag.graph_rag import (
    build_graph_rag,
    explain_graph_connection,
    get_node_neighborhood,
    load_graph_rag,
    query_graph_rag,
)


router = APIRouter(prefix="/graph-rag", tags=["graph-rag"])


class BuildGraphRagRequest(BaseModel):
    domain: Optional[str] = None
    category: Optional[str] = None
    article_ids: List[str] = Field(default_factory=list)
    concept_limit: int = Field(default=12, ge=4, le=24)
    similarity_threshold: int = Field(default=2, ge=1, le=8)


class GraphRagQueryRequest(BaseModel):
    query: str = Field(..., min_length=1)
    domain: Optional[str] = None
    category: Optional[str] = None
    article_ids: List[str] = Field(default_factory=list)
    limit: int = Field(default=8, ge=1, le=25)


class GraphRagNeighborsRequest(BaseModel):
    node_id: str = Field(..., min_length=1)
    domain: Optional[str] = None
    category: Optional[str] = None
    article_ids: List[str] = Field(default_factory=list)
    limit: int = Field(default=30, ge=1, le=100)


class GraphRagPathRequest(BaseModel):
    source_id: str = Field(..., min_length=1)
    target_id: str = Field(..., min_length=1)
    domain: Optional[str] = None
    category: Optional[str] = None
    article_ids: List[str] = Field(default_factory=list)
    max_depth: int = Field(default=5, ge=2, le=10)


@router.get("")
def get_graph_rag(
    domain: Optional[str] = Query(default=None),
    category: Optional[str] = Query(default=None),
    article_ids: List[str] = Query(default=[]),
):
    return load_graph_rag(
        domain=domain,
        category=category,
        article_ids=article_ids,
    )


@router.post("/build")
def rebuild_graph_rag(request: BuildGraphRagRequest):
    return build_graph_rag(
        domain=request.domain,
        category=request.category,
        article_ids=request.article_ids,
        concept_limit=request.concept_limit,
        similarity_threshold=request.similarity_threshold,
    )


@router.post("/query")
def query_graph(request: GraphRagQueryRequest):
    return query_graph_rag(
        query=request.query,
        domain=request.domain,
        category=request.category,
        article_ids=request.article_ids,
        limit=request.limit,
    )


@router.post("/neighbors")
def graph_neighbors(request: GraphRagNeighborsRequest):
    return get_node_neighborhood(
        node_id=request.node_id,
        domain=request.domain,
        category=request.category,
        article_ids=request.article_ids,
        limit=request.limit,
    )


@router.post("/path")
def graph_path(request: GraphRagPathRequest):
    return explain_graph_connection(
        source_id=request.source_id,
        target_id=request.target_id,
        domain=request.domain,
        category=request.category,
        article_ids=request.article_ids,
        max_depth=request.max_depth,
    )

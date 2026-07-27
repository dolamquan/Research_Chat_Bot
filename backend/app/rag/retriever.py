from typing import Any, Dict, List

from qdrant_client.models import FieldCondition, Filter, MatchValue

from app.rag.embedder import embed_text
from app.rag.vector_store import COLLECTION_NAME, get_client, search_vectors

from langsmith import traceable

def format_retrieved_point(point: Any) -> Dict[str, Any]:
    """
    Convert a Qdrant result point into a cleaner dictionary.
    """
    payload = point.payload or {}

    return {
        "id": point.id,
        "score": getattr(point, "score", None),
        "text": payload.get("text", ""),
        "parent_id": payload.get("parent_id"),
        "document_id": payload.get("document_id"),
        "parent_index": payload.get("parent_index"),
        "child_index": payload.get("child_index"),
        "source": payload.get("source"),
        "topic": payload.get("topic", "unknown"),
        "document_type": payload.get("document_type", "unknown"),
        "section_type": payload.get("section_type", "unknown"),
        "keywords": payload.get("keywords", []),
        "summary": payload.get("summary", ""),
        "cluster_id": payload.get("cluster_id"),
        "cluster_label": payload.get("cluster_label"),
    }

@traceable(name="build_retrieval_filter",run_type="retriever")
def build_retrieval_filter(
    cluster_id: int | None = None,
    document_source: str | None = None,
) -> Filter | None:
    conditions = []

    if cluster_id is not None:
        conditions.append(
            FieldCondition(
                key="cluster_id",
                match=MatchValue(value=cluster_id),
            )
        )

    if document_source:
        conditions.append(
            FieldCondition(
                key="source",
                match=MatchValue(value=document_source),
            )
        )

    if not conditions:
        return None

    return Filter(must=conditions)


@traceable(name="retrieve_chunks", run_type="retriever")
def retrieve(
    query: str,
    limit: int = 10,
    cluster_id: int | None = None,
    document_source: str | None = None,
) -> List[Dict[str, Any]]:
    """
    Embed the query, search for similar vectors in the vector store, and return formatted results.
    """
    query_vector = embed_text(query)
    points = search_vectors(
        query_vector,
        limit=limit,
        query_filter=build_retrieval_filter(
            cluster_id=cluster_id,
            document_source=document_source,
        ),
    )
    return [
        format_retrieved_point(point)
        for point in points
    ]

@traceable(name="retrieve_document_chunks",run_type="retriever")
def retrieve_document_chunks(
    document_source: str,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    """
    Fetch chunks from one document directly, in document order.
    """
    client = get_client()
    chunks: List[Dict[str, Any]] = []
    offset: Any = None

    while len(chunks) < limit:
        points, offset = client.scroll(
            collection_name=COLLECTION_NAME,
            limit=min(256, limit - len(chunks)),
            offset=offset,
            with_payload=True,
            with_vectors=False,
            scroll_filter=build_retrieval_filter(document_source=document_source),
        )

        if not points:
            break

        chunks.extend(format_retrieved_point(point) for point in points)

        if offset is None:
            break

    chunks.sort(
        key=lambda chunk: (
            chunk.get("parent_index")
            if chunk.get("parent_index") is not None
            else 10**9,
            chunk.get("child_index")
            if chunk.get("child_index") is not None
            else 10**9,
        )
    )
    return chunks

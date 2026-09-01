"""Semantic index over the user's own notes.

Notes live in their own Qdrant collection so "what did I write about X?"
retrieves the user's thinking, not just the papers. Indexing is best-effort:
note CRUD must keep working when Qdrant is down, so callers use
`index_note_safe` / `remove_note_safe`.
"""

import logging
import uuid
from typing import Any, Dict, List

from qdrant_client.models import Distance, PointIdsList, VectorParams

from app.rag.embedder import embed_text, get_embedding_dimension
from app.rag.vector_store import get_client

logger = logging.getLogger(__name__)

NOTES_COLLECTION = "research_notes"


def _point_id(note_id: str) -> str:
    try:
        return str(uuid.UUID(hex=note_id))
    except ValueError:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"note:{note_id}"))


def ensure_collection() -> None:
    client = get_client()
    existing = {collection.name for collection in client.get_collections().collections}
    if NOTES_COLLECTION not in existing:
        client.create_collection(
            collection_name=NOTES_COLLECTION,
            vectors_config=VectorParams(
                size=get_embedding_dimension(),
                distance=Distance.COSINE,
            ),
        )


def _note_text(note: Dict[str, Any]) -> str:
    parts = [
        note.get("title", ""),
        note.get("selected_text", ""),
        note.get("body_md", ""),
    ]
    return "\n\n".join(part for part in parts if part).strip()


def index_note(note: Dict[str, Any]) -> None:
    text = _note_text(note)
    if not text:
        remove_note(note["note_id"])
        return

    ensure_collection()
    get_client().upsert(
        collection_name=NOTES_COLLECTION,
        points=[
            {
                "id": _point_id(note["note_id"]),
                "vector": embed_text(text[:4000]),
                "payload": {
                    "note_id": note["note_id"],
                    "note_type": note.get("note_type", ""),
                    "title": note.get("title", ""),
                    "text": text[:2000],
                    "source_ref": note.get("source_ref", ""),
                    "source_title": note.get("source_title", ""),
                    "page": note.get("page"),
                    "tags": note.get("tags", []),
                    "updated_at": note.get("updated_at", ""),
                },
            }
        ],
    )


def remove_note(note_id: str) -> None:
    client = get_client()
    existing = {collection.name for collection in client.get_collections().collections}
    if NOTES_COLLECTION not in existing:
        return
    client.delete(
        collection_name=NOTES_COLLECTION,
        points_selector=PointIdsList(points=[_point_id(note_id)]),
    )


def index_note_safe(note: Dict[str, Any]) -> None:
    try:
        index_note(note)
    except Exception:  # noqa: BLE001 - indexing must never break note CRUD.
        logger.warning("Could not index note %s for search", note.get("note_id"), exc_info=True)


def remove_note_safe(note_id: str) -> None:
    try:
        remove_note(note_id)
    except Exception:  # noqa: BLE001
        logger.warning("Could not remove note %s from the search index", note_id, exc_info=True)


def search_notes(query: str, limit: int = 8) -> List[Dict[str, Any]]:
    ensure_collection()
    results = get_client().query_points(
        collection_name=NOTES_COLLECTION,
        query=embed_text(query),
        limit=limit,
    )

    hits = []
    for point in results.points:
        payload = dict(point.payload or {})
        payload["score"] = float(point.score) if point.score is not None else 0.0
        hits.append(payload)
    return hits

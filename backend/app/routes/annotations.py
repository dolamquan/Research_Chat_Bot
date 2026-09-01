"""Legacy annotation endpoints.

PDF highlights now live in the unified `notes` table (note_type='highlight').
These routes stay so the PDF reader keeps its existing API, but they read and
write the notes store and return the historic annotation shape.
"""

from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.rag import notes_index
from app.storage import notes as notes_store


router = APIRouter(prefix="/annotations", tags=["annotations"])


class AnnotationRequest(BaseModel):
    source: str = Field(..., min_length=1)
    page: int = Field(..., ge=1)
    selected_text: str = Field(..., min_length=1)
    note: str = ""
    article_id: str | None = None
    title: str | None = None


def _safe_pdf_source(source: str) -> str:
    safe_name = Path(source).name
    if safe_name != source or not safe_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Invalid PDF filename.")
    return safe_name


def _note_to_annotation(note: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "annotation_id": note["note_id"],
        "source": note["source_ref"],
        "article_id": note.get("article_id") or "",
        "title": note.get("source_title") or note.get("title") or "",
        "page": note.get("page") or 1,
        "selected_text": note.get("selected_text", ""),
        "note": note.get("body_md", ""),
        "created_at": note["created_at"],
        "updated_at": note["updated_at"],
    }


@router.get("")
def get_annotations(source: str | None = None, limit: int = 100) -> Dict[str, Any]:
    safe_source = _safe_pdf_source(source) if source else None
    notes = notes_store.list_notes(
        note_type="highlight",
        source_ref=safe_source,
        limit=limit,
    )
    return {"annotations": [_note_to_annotation(note) for note in notes]}


@router.post("")
def save_annotation(request: AnnotationRequest) -> Dict[str, Any]:
    safe_source = _safe_pdf_source(request.source)
    note = notes_store.create_note(
        note_type="highlight",
        source_type="pdf",
        source_ref=safe_source,
        source_title=request.title or "",
        article_id=request.article_id or "",
        page=request.page,
        selected_text=request.selected_text.strip(),
        title=request.title or "",
        body_md=request.note.strip(),
    )
    notes_index.index_note_safe(note)
    return {"annotation": _note_to_annotation(note)}


@router.delete("/{annotation_id}")
def remove_annotation(annotation_id: str) -> Dict[str, str]:
    try:
        notes_store.delete_note(annotation_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    notes_index.remove_note_safe(annotation_id)
    return {"status": "deleted"}

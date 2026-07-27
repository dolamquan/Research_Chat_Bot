from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.storage.annotations import (
    create_annotation,
    delete_annotation,
    list_annotations,
)


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


@router.get("")
def get_annotations(source: str | None = None, limit: int = 100) -> Dict[str, Any]:
    safe_source = _safe_pdf_source(source) if source else None
    return {
        "annotations": list_annotations(source=safe_source, limit=limit),
    }


@router.post("")
def save_annotation(request: AnnotationRequest) -> Dict[str, Any]:
    safe_source = _safe_pdf_source(request.source)
    return {
        "annotation": create_annotation(
            source=safe_source,
            page=request.page,
            selected_text=request.selected_text.strip(),
            note=request.note.strip(),
            article_id=request.article_id or "",
            title=request.title or "",
        )
    }


@router.delete("/{annotation_id}")
def remove_annotation(annotation_id: str) -> Dict[str, str]:
    try:
        delete_annotation(annotation_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {"status": "deleted"}

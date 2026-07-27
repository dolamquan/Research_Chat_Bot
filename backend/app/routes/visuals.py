from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.rag.vector_store import index_visual_assets
from app.rag.visual_analyzer import UPLOAD_IMAGE_DIR, VISUAL_ASSET_DIR, extract_pdf_visuals
from app.storage.visual_assets import list_visual_assets


router = APIRouter(prefix="/visuals", tags=["visuals"])

UPLOAD_FOLDER = Path(__file__).resolve().parents[1] / "data" / "uploaded_docs"


def _safe_pdf_source(source: str) -> str:
    safe_name = Path(source).name
    if safe_name != source or not safe_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Invalid PDF filename.")
    return safe_name


@router.get("")
def get_visual_assets(source: str | None = None, limit: int = 100) -> Dict[str, Any]:
    safe_source = _safe_pdf_source(source) if source else None
    return {
        "visuals": list_visual_assets(source=safe_source, limit=limit),
    }


@router.post("/extract")
def extract_document_visuals(source: str, max_images: int = 20) -> Dict[str, Any]:
    safe_source = _safe_pdf_source(source)
    pdf_path = UPLOAD_FOLDER / safe_source

    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {safe_source}")

    try:
        assets = extract_pdf_visuals(
            pdf_path,
            source=safe_source,
            article_metadata={
                "title": Path(safe_source).stem.replace("_", " "),
                "tags": ["pdf-figure", "visual", "graph"],
            },
            max_images=max_images,
        )
        index_visual_assets(
            assets,
            article_metadata={
                "title": Path(safe_source).stem.replace("_", " "),
                "tags": ["pdf-figure", "visual", "graph"],
            },
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract visuals: {exc}",
        ) from exc

    return {
        "status": "extracted",
        "visuals": assets,
    }


@router.get("/{filename}/image")
def get_visual_image(filename: str) -> FileResponse:
    safe_name = Path(filename).name
    if safe_name != filename:
        raise HTTPException(status_code=400, detail="Invalid image filename.")

    for folder in [VISUAL_ASSET_DIR, UPLOAD_IMAGE_DIR]:
        image_path = folder / safe_name
        if image_path.exists():
            return FileResponse(path=image_path)

    raise HTTPException(status_code=404, detail=f"Image not found: {safe_name}")

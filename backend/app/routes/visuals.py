from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app.rag.vector_store import index_visual_assets
from app.rag.visual_analyzer import (
    UPLOAD_IMAGE_DIR,
    VISUAL_ASSET_DIR,
    extract_pdf_visuals,
    save_captured_pdf_visual,
)
from app.storage.visual_assets import get_visual_asset_blob, list_visual_assets


router = APIRouter(prefix="/visuals", tags=["visuals"])

UPLOAD_FOLDER = Path(__file__).resolve().parents[1] / "data" / "uploaded_docs"


class CaptureVisualRequest(BaseModel):
    source: str
    image_data: str
    article_id: str | None = None
    title: str | None = None
    page: int | None = None
    caption: str | None = None


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


@router.post("/capture")
def capture_document_visual(request: CaptureVisualRequest) -> Dict[str, Any]:
    safe_source = _safe_pdf_source(request.source)
    pdf_path = UPLOAD_FOLDER / safe_source

    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {safe_source}")

    metadata = {
        "article_id": request.article_id or "",
        "title": request.title or Path(safe_source).stem.replace("_", " "),
        "tags": ["pdf-region", "visual", "figure", "graph"],
    }

    try:
        asset = save_captured_pdf_visual(
            source=safe_source,
            article_id=metadata["article_id"],
            title=metadata["title"],
            page=request.page,
            image_data=request.image_data,
            caption=request.caption or "",
        )
        index_visual_assets([asset], article_metadata=metadata)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save captured visual: {exc}",
        ) from exc

    return {
        "status": "captured",
        "visual": asset,
    }


@router.get("/{filename}/image")
def get_visual_image(filename: str):
    safe_name = Path(filename).name
    if safe_name != filename:
        raise HTTPException(status_code=400, detail="Invalid image filename.")

    blob = get_visual_asset_blob(safe_name)
    if blob is not None:
        return Response(
            content=bytes(blob["content"]),
            media_type=str(blob["mime_type"]),
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Visual-Asset-Storage": "sqlite",
            },
        )

    for folder in [VISUAL_ASSET_DIR, UPLOAD_IMAGE_DIR]:
        image_path = folder / safe_name
        if image_path.exists():
            return FileResponse(path=image_path)

    raise HTTPException(status_code=404, detail=f"Image not found: {safe_name}")

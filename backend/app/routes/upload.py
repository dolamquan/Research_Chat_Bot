from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.rag.vector_store import index_visual_assets
from app.rag.visual_analyzer import save_uploaded_image

router = APIRouter(prefix="/upload", tags=["upload"])


@router.post("")
def upload_disabled():
    """
    Runtime uploads are disabled because documents are indexed from uploaded_docs.
    """
    raise HTTPException(
        status_code=405,
        detail="Document upload is disabled. Add PDFs to app/data/uploaded_docs and run ingest.py.",
    )


@router.post("/image")
async def upload_image(
    file: UploadFile = File(...),
    title: str = Form(""),
    domain: str = Form("research"),
    category: str = Form("uncategorized"),
) -> dict:
    """
    Upload a standalone image/graph, caption it, and index the caption for retrieval.
    """
    try:
        content = await file.read()
        asset = save_uploaded_image(
            filename=file.filename or "uploaded_image.png",
            content=content,
            title=title,
            domain=domain,
            category=category,
        )
        index_visual_assets(
            [asset],
            article_metadata={
                "title": asset.get("title") or title,
                "domain": domain,
                "category": category,
                "tags": ["uploaded-image", "visual", "graph"],
            },
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to upload image: {exc}",
        ) from exc

    return {
        "status": "indexed",
        "asset": asset,
    }

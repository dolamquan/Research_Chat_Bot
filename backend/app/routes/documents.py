from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from langchain_community.document_loaders import PyPDFLoader

from app.storage import files
from app.storage.article_store import can_access_source


router = APIRouter(prefix="/documents", tags=["documents"])


def _resolve_pdf(source: str) -> Path:
    """A local file for a PDF the current user may read (fetched from Storage if needed), or an HTTP error."""
    try:
        safe_name = files.safe_pdf_name(source)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid PDF filename.")

    # One PDF file can back a public paper and private copies; a user who owns
    # none of them gets the same answer as for a file that does not exist.
    if not can_access_source(safe_name):
        raise HTTPException(status_code=404, detail=f"PDF not found: {safe_name}")
    try:
        return files.pdf_path(safe_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"PDF not found: {safe_name}")


@router.get("/pdf")
def get_document_pdf(source: str) -> FileResponse:
    """
    Serve an original uploaded PDF by filename.
    """
    pdf_path = _resolve_pdf(source)

    return FileResponse(
        path=pdf_path,
        media_type="application/pdf",
        filename=pdf_path.name,
        headers={"Content-Disposition": f'inline; filename="{pdf_path.name}"'},
    )


@router.get("/text")
def get_document_text(source: str) -> dict:
    """
    Return extracted PDF text for manual selection in the frontend.
    """
    pdf_path = _resolve_pdf(source)

    pages = PyPDFLoader(str(pdf_path)).load()
    page_texts = [
        {
            "page": index + 1,
            "text": page.page_content,
        }
        for index, page in enumerate(pages)
        if page.page_content.strip()
    ]

    return {
        "source": pdf_path.name,
        "pages": page_texts,
    }

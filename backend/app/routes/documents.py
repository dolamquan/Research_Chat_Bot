from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from langchain_community.document_loaders import PyPDFLoader

from app.storage.article_store import can_access_source


router = APIRouter(prefix="/documents", tags=["documents"])

UPLOAD_FOLDER = Path(__file__).resolve().parents[1] / "data" / "uploaded_docs"


def _resolve_pdf(source: str) -> Path:
    """The on-disk PDF for a filename the current user may read, or an HTTP error."""
    safe_name = Path(source).name

    if safe_name != source or not safe_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Invalid PDF filename.")

    pdf_path = UPLOAD_FOLDER / safe_name

    # One PDF file can back a public paper and private copies; a user who owns
    # none of them gets the same answer as for a file that does not exist.
    if not pdf_path.exists() or not can_access_source(safe_name):
        raise HTTPException(status_code=404, detail=f"PDF not found: {safe_name}")

    return pdf_path


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

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from langchain_community.document_loaders import PyPDFLoader


router = APIRouter(prefix="/documents", tags=["documents"])

UPLOAD_FOLDER = Path(__file__).resolve().parents[1] / "data" / "uploaded_docs"


@router.get("/pdf")
def get_document_pdf(source: str) -> FileResponse:
    """
    Serve an original uploaded PDF by filename.
    """
    safe_name = Path(source).name

    if safe_name != source or not safe_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Invalid PDF filename.")

    pdf_path = UPLOAD_FOLDER / safe_name

    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {safe_name}")

    return FileResponse(
        path=pdf_path,
        media_type="application/pdf",
        filename=safe_name,
        headers={"Content-Disposition": f'inline; filename="{safe_name}"'},
    )


@router.get("/text")
def get_document_text(source: str) -> dict:
    """
    Return extracted PDF text for manual selection in the frontend.
    """
    safe_name = Path(source).name

    if safe_name != source or not safe_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Invalid PDF filename.")

    pdf_path = UPLOAD_FOLDER / safe_name

    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {safe_name}")

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
        "source": safe_name,
        "pages": page_texts,
    }

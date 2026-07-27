from fastapi import APIRouter, HTTPException


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

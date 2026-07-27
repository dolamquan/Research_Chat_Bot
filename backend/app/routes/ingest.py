from typing import Any, Dict, List

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from app.ingestion.url_ingester import ingest_article_url
from app.storage.ingestion_jobs import (
    create_ingestion_job,
    get_ingestion_job,
    list_ingestion_jobs,
    update_ingestion_job,
)


router = APIRouter(prefix="/ingest", tags=["ingest"])


class IngestUrlRequest(BaseModel):
    url: str = Field(..., min_length=1)
    title: str | None = None
    domain: str = "research"
    category: str = "uncategorized"
    tags: List[str] = Field(default_factory=list)


def _run_ingestion_job(job_id: str, request: IngestUrlRequest) -> None:
    update_ingestion_job(
        job_id,
        status="running",
        stage="downloading",
        message="Resolving metadata and downloading the PDF.",
    )

    try:
        update_ingestion_job(
            job_id,
            status="running",
            stage="indexing",
            message="Chunking, embedding, and storing the paper in Qdrant.",
        )
        result = ingest_article_url(
            url=request.url,
            title=request.title,
            domain=request.domain,
            category=request.category,
            tags=request.tags,
        )
        article = result["article"]
        update_ingestion_job(
            job_id,
            status="indexed",
            stage="indexed",
            message="Paper is ready for retrieval. Rebuild topology to place it on the map.",
            article_id=article.get("article_id"),
            article_title=article.get("title"),
            source=article.get("source"),
            pdf_url=result.get("pdf_url", ""),
            completed=True,
        )
    except Exception as exc:
        update_ingestion_job(
            job_id,
            status="failed",
            stage="failed",
            message="Paper ingestion failed.",
            error=str(exc),
            completed=True,
        )


@router.post("/url")
def ingest_url(request: IngestUrlRequest, background_tasks: BackgroundTasks) -> Dict[str, Any]:
    """
    Add a paper by URL. Supports arXiv abstract URLs, arXiv PDF URLs, and direct PDF URLs.
    """
    job = create_ingestion_job(
        url=request.url,
        title=request.title,
        domain=request.domain,
        category=request.category,
        tags=request.tags,
    )

    background_tasks.add_task(_run_ingestion_job, job["job_id"], request)

    return {
        "status": "queued",
        "job": job,
    }


@router.get("/jobs")
def get_ingestion_jobs(limit: int = 20) -> Dict[str, Any]:
    return {
        "jobs": list_ingestion_jobs(limit=limit),
    }


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> Dict[str, Any]:
    try:
        return get_ingestion_job(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

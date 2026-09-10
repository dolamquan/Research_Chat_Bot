import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth.deps import require_admin
from app.rag import vector_store
from app.storage.article_store import get_article, list_articles, list_domains, set_article_visibility


router = APIRouter(prefix="/articles", tags=["articles"])
logger = logging.getLogger(__name__)


class VisibilityRequest(BaseModel):
    public: bool = True
    # Only used when public is false: who the paper should belong to.
    owner_id: str | None = None


@router.get("")
def get_articles(
    domain: str | None = None,
    category: str | None = None,
    limit: int = 100,
) -> Dict[str, Any]:
    """Papers visible to the current user: the shared library plus their own."""
    return {
        "articles": list_articles(
            domain=domain,
            category=category,
            limit=limit,
        )
    }


@router.get("/domains")
def get_domains() -> Dict[str, Any]:
    return {
        "domains": list_domains(),
    }


@router.get("/{article_id}")
def get_article_detail(article_id: str) -> Dict[str, Any]:
    try:
        return get_article(article_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{article_id}/visibility", dependencies=[Depends(require_admin)])
def set_visibility(article_id: str, request: VisibilityRequest) -> Dict[str, Any]:
    """Administrators publish a private paper to everyone, or hand it to one owner."""
    try:
        article = set_article_visibility(article_id, public=request.public, owner_id=request.owner_id)
    except ValueError as exc:
        status = 404 if "not found" in str(exc) else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    try:
        vector_store.set_article_owner(article_id, article.get("owner_id"))
    except Exception as exc:  # noqa: BLE001 - SQLite is authoritative; report, don't fail.
        logger.warning("Visibility changed in SQLite but not in Qdrant for %s: %s", article_id, exc)
        article["warning"] = f"Chunk visibility was not updated in the vector store: {exc}"
    return article

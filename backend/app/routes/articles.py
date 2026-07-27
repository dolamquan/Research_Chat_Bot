from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.storage.article_store import get_article, list_articles, list_domains


router = APIRouter(prefix="/articles", tags=["articles"])


@router.get("")
def get_articles(
    domain: str | None = None,
    category: str | None = None,
    limit: int = 100,
) -> Dict[str, Any]:
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

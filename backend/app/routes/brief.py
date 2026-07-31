from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.rag.brief import generate_research_brief


router = APIRouter(prefix="/brief", tags=["brief"])


class ResearchBriefRequest(BaseModel):
    topic: str = ""
    domain: Optional[str] = None
    category: Optional[str] = None
    article_ids: List[str] = Field(default_factory=list)
    limit: int = Field(default=8, ge=1, le=20)


@router.post("/research")
def create_research_brief(request: ResearchBriefRequest):
    return generate_research_brief(
        topic=request.topic,
        domain=request.domain,
        category=request.category,
        article_ids=request.article_ids,
        limit=request.limit,
    )

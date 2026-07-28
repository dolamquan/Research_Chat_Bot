from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from langsmith import traceable
from pydantic import BaseModel, Field

from app.rag.generator import generate_answer
from app.storage.chat_history import (
    append_message,
    create_session,
    delete_session,
    get_session,
    list_sessions,
)


router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(BaseModel):
    session_id: str | None = None
    question: str = Field(..., min_length=1)
    retrieval_limit: int = Field(default=20, ge=1, le=50)
    context_limit: int = Field(default=5, ge=1, le=20)
    context_mode: str = Field(default="retrieval")
    use_reranking: bool = True
    parallel_reranking: bool = True
    rerank_workers: int = Field(default=3, ge=1, le=8)
    chat_history: List[Dict[str, str]] = Field(default_factory=list)
    pinned_sources: List[Dict[str, Any]] = Field(default_factory=list)
    cluster_id: int | None = None
    document_source: str | None = None
    domain: str | None = None
    category: str | None = None
    tags: List[str] = Field(default_factory=list)


class ChatResponse(BaseModel):
    session_id: str
    answer: str
    sources: List[Dict[str, Any]]


class ChatSessionCreateRequest(BaseModel):
    title: str | None = None
    cluster_id: int | None = None
    document_source: str | None = None
    context_mode: str = "retrieval"


@router.post("", response_model=ChatResponse)
@traceable(name="chat", run_type="chain")
def chat(request: ChatRequest) -> ChatResponse:
    """
    Answer a user question using the indexed document collection.
    """
    session_id = request.session_id

    if session_id is None:
        session = create_session(
            first_question=request.question,
            cluster_id=request.cluster_id,
            document_source=request.document_source,
            context_mode=request.context_mode,
        )
        session_id = session["id"]

    append_message(
        session_id=session_id,
        role="user",
        content=request.question,
        sources=[],
        pinned_sources=request.pinned_sources,
    )

    try:
        result = generate_answer(
            query=request.question,
            retrieval_limit=request.retrieval_limit,
            context_limit=request.context_limit,
            context_mode=request.context_mode,
            use_reranking=request.use_reranking,
            parallel_reranking=request.parallel_reranking,
            rerank_workers=request.rerank_workers,
            chat_history=request.chat_history,
            pinned_sources=request.pinned_sources,
            cluster_id=request.cluster_id,
            document_source=request.document_source,
            domain=request.domain,
            category=request.category,
            tags=request.tags,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate answer: {exc}",
        ) from exc

    append_message(
        session_id=session_id,
        role="assistant",
        content=result["answer"],
        sources=result["sources"],
    )

    return ChatResponse(
        session_id=session_id,
        answer=result["answer"],
        sources=result["sources"],
    )


@router.get("/sessions")
def get_chat_sessions(limit: int = 50) -> Dict[str, Any]:
    """
    Return recent saved chat sessions.
    """
    return {
        "sessions": list_sessions(limit=limit),
    }


@router.post("/sessions")
def create_chat_session(request: ChatSessionCreateRequest) -> Dict[str, Any]:
    """
    Create an empty chat session.
    """
    return create_session(
        title=request.title,
        cluster_id=request.cluster_id,
        document_source=request.document_source,
        context_mode=request.context_mode,
    )


@router.get("/sessions/{session_id}")
def get_chat_session(session_id: str) -> Dict[str, Any]:
    """
    Return one saved chat session and its messages.
    """
    try:
        return get_session(session_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/sessions/{session_id}")
def remove_chat_session(session_id: str) -> Dict[str, str]:
    """
    Delete one saved chat session.
    """
    try:
        delete_session(session_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {"status": "deleted"}

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from langsmith import traceable
from pydantic import BaseModel, Field

from app.agents.graph import agent_graph
from app.storage.agent_history import (
    append_message,
    create_session,
    delete_session,
    get_session,
    list_sessions,
)


router = APIRouter(prefix="/agent", tags=["agent"])


class AgentChatRequest(BaseModel):
    session_id: str | None = None
    question: str = Field(..., min_length=1)
    retrieval_limit: int = Field(default=20, ge=1, le=50)
    context_limit: int = Field(default=5, ge=1, le=20)
    context_mode: str = "retrieval"
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


class AgentChatResponse(BaseModel):
    session_id: str
    answer: str
    sources: List[Dict[str, Any]]
    intent: str
    topology: Dict[str, Any] | None = None
    tool_trace: List[Dict[str, Any]] = Field(default_factory=list)


class AgentSessionCreateRequest(BaseModel):
    title: str | None = None
    cluster_id: int | None = None
    document_source: str | None = None
    context_mode: str = "retrieval"


@router.post("/chat", response_model=AgentChatResponse)
@traceable(name="agent_chat", run_type="chain")
def agent_chat(request: AgentChatRequest) -> AgentChatResponse:
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

    request_data = (
        request.model_dump()
        if hasattr(request, "model_dump")
        else request.dict()
    )
    state = {
        **request_data,
        "session_id": session_id,
    }

    try:
        result = agent_graph.invoke(state)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Agent failed: {exc}",
        ) from exc

    answer = result.get("answer", "")
    sources = result.get("sources", [])
    tool_trace = result.get("tool_trace", [])

    append_message(
        session_id=session_id,
        role="assistant",
        content=answer,
        sources=sources,
        tool_trace=tool_trace,
        intent=result.get("intent", "rag_question"),
    )

    return AgentChatResponse(
        session_id=session_id,
        answer=answer,
        sources=sources,
        intent=result.get("intent", "rag_question"),
        topology=result.get("topology"),
        tool_trace=tool_trace,
    )


@router.get("/sessions")
def get_agent_sessions(limit: int = 50) -> Dict[str, Any]:
    return {
        "sessions": list_sessions(limit=limit),
    }


@router.post("/sessions")
def create_agent_session(request: AgentSessionCreateRequest) -> Dict[str, Any]:
    return create_session(
        title=request.title,
        cluster_id=request.cluster_id,
        document_source=request.document_source,
        context_mode=request.context_mode,
    )


@router.get("/sessions/{session_id}")
def get_agent_session(session_id: str) -> Dict[str, Any]:
    try:
        return get_session(session_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/sessions/{session_id}")
def remove_agent_session(session_id: str) -> Dict[str, str]:
    try:
        delete_session(session_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {"status": "deleted"}

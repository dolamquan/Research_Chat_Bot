import os
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from langsmith import traceable
from pydantic import BaseModel, Field

from app.agents import catalog
from app.agents.graph import agent_graph
from app.agents.runtime import run_agent
from app.rag.llm_provider import ProviderNotConfigured
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
    # What the user currently has open elsewhere in the app (selected paper,
    # cluster, library search...). Free-form so views can add to it freely.
    workspace: Dict[str, Any] = Field(default_factory=dict)


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


class AgentToolCallRequest(BaseModel):
    name: str = Field(..., min_length=1)
    arguments: Dict[str, Any] = Field(default_factory=dict)
    workspace: Dict[str, Any] = Field(default_factory=dict)


def _legacy_mode() -> bool:
    return os.getenv("AGENT_MODE", "tools").strip().lower() == "legacy"


@router.post("/chat", response_model=AgentChatResponse)
@traceable(name="agent_chat", run_type="chain")
def agent_chat(request: AgentChatRequest) -> AgentChatResponse:
    """Run one Agent-tab request through the tool-calling agent and persist the exchange."""
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
        result = agent_graph.invoke(state) if _legacy_mode() else run_agent(state)
    except ProviderNotConfigured as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Agent failed: {exc}",
        ) from exc

    answer = result.get("answer", "")
    sources = result.get("sources", [])
    tool_trace = result.get("tool_trace", [])
    intent = result.get("intent", "agent")

    append_message(
        session_id=session_id,
        role="assistant",
        content=answer,
        sources=sources,
        tool_trace=tool_trace,
        intent=intent,
    )

    return AgentChatResponse(
        session_id=session_id,
        answer=answer,
        sources=sources,
        intent=intent,
        topology=result.get("topology"),
        tool_trace=tool_trace,
    )


@router.get("/tools")
def get_agent_tools(query: str = "", category: str = "", offset: int = 0, limit: int = 200) -> Dict[str, Any]:
    """Discover the application tools the agent can call, filtered by keyword or category."""
    return catalog.discover_tools(query=query, category=category, offset=offset, limit=limit)


@router.get("/tools/{name}")
def get_agent_tool(name: str) -> Dict[str, Any]:
    """Full definition of one agent tool, including its input schema."""
    try:
        return catalog.describe_tool(name)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/tools/call")
@traceable(name="agent_tool_call", run_type="tool")
def call_agent_tool(request: AgentToolCallRequest) -> Dict[str, Any]:
    """Run one agent tool directly, exactly as the agent would."""
    try:
        result = catalog.execute_tool(request.name, request.arguments, request.workspace)
    except ValueError as exc:
        detail = str(exc)
        status = 404 if detail.startswith("Unknown application tool") else 400
        raise HTTPException(status_code=status, detail=detail) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"status": "success", "name": request.name, "result": result}


@router.get("/context")
def get_agent_context() -> Dict[str, Any]:
    """What the agent knows about the application: features, papers, tools and integrations."""
    return catalog.application_context()


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

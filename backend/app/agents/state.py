from typing import Any, Dict, List, Literal, TypedDict


AgentIntent = Literal[
    "small_talk",
    "rag_question",
    "search_papers",
    "search_arxiv",
    "search_library",
    "search_reddit",
    "ingest_paper",
    "save_note",
    "rebuild_topology",
    "export_notion",
    "create_github_issue",
    "search_github",
    "summarize_paper",
    "generate_visualization",
    "export_visualization_notion",
    "workflow_agent",
]


class AgentState(TypedDict, total=False):
    session_id: str
    question: str
    intent: AgentIntent

    retrieval_limit: int
    context_limit: int
    context_mode: str
    use_reranking: bool
    parallel_reranking: bool
    rerank_workers: int

    chat_history: List[Dict[str, str]]
    pinned_sources: List[Dict[str, Any]]
    cluster_id: int | None
    document_source: str | None
    domain: str | None
    category: str | None
    tags: List[str]

    answer: str
    sources: List[Dict[str, Any]]
    topology: Dict[str, Any]
    tool_trace: List[Dict[str, Any]]
    workflow_plan: List[Dict[str, Any]]
    error: str | None

    # What the user has open elsewhere in the app (free-form; see context_schema).
    workspace: Dict[str, Any]

    # Always-present assistant (websocket) additions. All optional.
    mode: str                          # "agent" (tab) | "assistant" (voice/dock)
    source: str                        # "voice" | "text"
    turn_id: str
    client_tools: List[Dict[str, Any]]  # browser-executed tool specs
    resume_action: Dict[str, Any] | None   # a confirmed pending action to run first
    declined_action: Dict[str, Any] | None  # a pending action the user refused
    spoken: str

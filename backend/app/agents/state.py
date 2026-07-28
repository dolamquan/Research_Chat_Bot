from typing import Any, Dict, List, Literal, TypedDict


AgentIntent = Literal[
    "rag_question",
    "search_arxiv",
    "search_library",
    "ingest_paper",
    "save_note",
    "rebuild_topology",
    "export_notion",
    "create_github_issue",
    "search_github",
    "summarize_paper",
    "generate_visualization",
    "export_visualization_notion",
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
    error: str | None

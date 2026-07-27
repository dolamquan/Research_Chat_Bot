from typing import Any, Dict, List, Literal, TypedDict


AgentIntent = Literal[
    "rag_question",
    "ingest_paper",
    "rebuild_topology",
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
    error: str | None

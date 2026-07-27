import re
from typing import Any, Dict

from langsmith import traceable

from app.agents.state import AgentState
from app.ingestion.url_ingester import ingest_article_url
from app.rag.clusterer import build_cluster_graph
from app.rag.generator import generate_answer


URL_PATTERN = re.compile(r"https?://[^\s)>\]]+")


def _extract_url(text: str) -> str | None:
    match = URL_PATTERN.search(text)
    if not match:
        return None

    return match.group(0).rstrip(".,;")


@traceable(name="agent_rag_tool", run_type="chain")
def rag_tool(state: AgentState) -> Dict[str, Any]:
    result = generate_answer(
        query=state["question"],
        retrieval_limit=state.get("retrieval_limit", 20),
        context_limit=state.get("context_limit", 5),
        context_mode=state.get("context_mode", "retrieval"),
        use_reranking=state.get("use_reranking", True),
        parallel_reranking=state.get("parallel_reranking", True),
        rerank_workers=state.get("rerank_workers", 3),
        chat_history=state.get("chat_history", []),
        pinned_sources=state.get("pinned_sources", []),
        cluster_id=state.get("cluster_id"),
        document_source=state.get("document_source"),
        domain=state.get("domain"),
        category=state.get("category"),
        tags=state.get("tags", []),
    )

    return {
        "answer": result["answer"],
        "sources": result["sources"],
    }


@traceable(name="agent_ingest_paper_tool", run_type="tool")
def ingest_paper_tool(state: AgentState) -> Dict[str, Any]:
    url = _extract_url(state["question"])

    if not url:
        return {
            "answer": "I can add a paper, but I need an arXiv or direct PDF URL.",
            "sources": [],
            "error": "missing_url",
        }

    result = ingest_article_url(
        url=url,
        domain=state.get("domain") or "research",
        category=state.get("category") or "uncategorized",
        tags=state.get("tags", []),
    )
    article = result["article"]

    return {
        "answer": (
            f"Indexed **{article['title']}** in the local database. "
            "Rebuild the topology map when you want it to appear in the visual cluster view."
        ),
        "sources": [],
    }


@traceable(name="agent_rebuild_topology_tool", run_type="tool")
def rebuild_topology_tool(state: AgentState) -> Dict[str, Any]:
    topology = build_cluster_graph(
        domain=state.get("domain"),
        category=state.get("category"),
    )

    scope_parts = [
        value
        for value in [state.get("domain"), state.get("category")]
        if value
    ]
    scope = " / ".join(scope_parts) if scope_parts else "all indexed papers"

    return {
        "answer": f"Rebuilt the topology map for {scope}.",
        "sources": [],
        "topology": topology,
    }

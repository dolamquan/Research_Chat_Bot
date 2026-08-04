import re
from typing import Any, Dict, List

from langsmith import traceable

from app.agents.state import AgentState
from app.agents.tools import (
    _keywords,
    _paper_identifier,
    _requested_paper_sources,
    _score_text,
    _trace,
)
from app.mcp.bridge import call_mcp_tool
from app.rag.generator import generate_answer


def is_workflow_request(question: str) -> bool:
    lowered = question.lower()
    workflow_markers = [
        "workflow",
        "autonomous",
        "multi-step",
        "multi step",
        "research agent",
        "research workflow",
        "agentic",
    ]
    if any(marker in lowered for marker in workflow_markers):
        return True

    action_groups = [
        ["search", "find", "discover"],
        ["rank", "compare", "prioritize", "score"],
        ["add", "ingest", "index", "save"],
        ["rebuild", "update", "refresh"],
        ["summarize", "brief", "report"],
        ["graph", "topology", "map"],
        ["notion", "github", "visualization", "diagram"],
    ]
    matched_groups = sum(
        1
        for group in action_groups
        if any(action in lowered for action in group)
    )
    has_connector = any(connector in lowered for connector in [" then ", " and then ", " after that ", " finally "])
    return matched_groups >= 3 and has_connector


def _requested_top_n(question: str, default: int = 3) -> int:
    lowered = question.lower()
    patterns = [
        r"\btop\s+(\d+)\b",
        r"\bbest\s+(\d+)\b",
        r"\bfirst\s+(\d+)\b",
        r"\b(\d+)\s+(?:papers|results|candidates)\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, lowered)
        if match:
            return max(1, min(int(match.group(1)), 8))
    return default


def _clean_workflow_query(question: str) -> str:
    cleaned = re.sub(r"^\s*/workflow\b", " ", question, flags=re.IGNORECASE)
    cleaned = re.sub(
        r"\b(run|start|execute|do)\s+(a\s+)?(multi-step\s+|multi step\s+)?research\s+workflow\s+(to|for)?\b",
        " ",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r"\b(search|find|discover|look for)\s+(papers?|research|studies)\s+(about|on|for)?\b",
        " ",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.split(
        r"\b(?:,?\s*(?:then|and then|after that|finally)\s+|,\s*(?:rank|add|ingest|index|rebuild|update|refresh|summarize)\b)",
        cleaned,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    cleaned = re.sub(
        r"\b(rank|score|prioritize|summarize|main themes|top\s+\d+|best\s+\d+)\b.*$",
        " ",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = " ".join(cleaned.replace("`", " ").split())
    return cleaned or question


def _wants_ingestion(question: str) -> bool:
    lowered = question.lower()
    return any(
        phrase in lowered
        for phrase in [
            "add the top",
            "ingest the top",
            "index the top",
            "save the top",
            "add top",
            "ingest top",
            "index top",
            "save top",
            "add them",
            "ingest them",
            "index them",
            "then add",
            "then ingest",
            "then index",
        ]
    )


def _wants_topology(question: str) -> bool:
    lowered = question.lower()
    return any(
        phrase in lowered
        for phrase in [
            "rebuild topology",
            "update topology",
            "refresh topology",
            "rebuild graph",
            "update graph",
            "refresh graph",
            "rebuild map",
            "update map",
            "refresh map",
        ]
    )


def _wants_graph_context(question: str) -> bool:
    lowered = question.lower()
    return any(
        token in lowered
        for token in ["graph rag", "graph-rag", "concept graph", "topology", "relationship", "connections"]
    )


def _paper_text(paper: Dict[str, Any]) -> str:
    return " ".join(
        str(value or "")
        for value in [
            paper.get("title"),
            paper.get("abstract"),
            paper.get("text"),
            paper.get("summary"),
            " ".join(paper.get("categories", []) or []),
            " ".join(paper.get("tags", []) or []),
        ]
    )


def _rank_papers(papers: List[Dict[str, Any]], question: str, limit: int) -> List[Dict[str, Any]]:
    terms = _keywords(question)
    ranked = []
    seen = set()
    for paper in papers:
        identifier = _paper_identifier(paper)
        if identifier in seen:
            continue
        seen.add(identifier)
        score = _score_text(_paper_text(paper), terms)
        ranked.append((score, paper))

    ranked.sort(key=lambda item: item[0], reverse=True)
    return [paper for _, paper in ranked[:limit]]


def _paper_url(paper: Dict[str, Any]) -> str:
    return str(paper.get("pdf_url") or paper.get("source") or paper.get("url") or "")


def _format_paper_line(index: int, paper: Dict[str, Any]) -> str:
    title = paper.get("title") or "Untitled paper"
    identifier = _paper_identifier(paper)
    provider = paper.get("source_provider") or paper.get("provider") or paper.get("topic") or "research"
    url = _paper_url(paper)
    return f"{index}. **{title}** ({identifier}) - {provider}" + (f"\n   {url}" if url else "")


def _workflow_plan(state: AgentState) -> List[Dict[str, Any]]:
    question = state["question"]
    wants_ingestion = _wants_ingestion(question)
    wants_topology = _wants_topology(question)
    plan = [
        {
            "tool": "plan_workflow",
            "message": "Plan a multi-step research workflow from the request.",
        },
        {
            "tool": "search_library",
            "message": "Check indexed papers before leaving the local library.",
        },
    ]

    if _wants_graph_context(question):
        plan.append(
            {
                "tool": "query_graph_rag",
                "message": "Use the concept graph to gather relationship context.",
            }
        )

    plan.extend(
        [
            {
                "tool": "search_papers",
                "message": "Search external academic sources for new candidates.",
            },
            {
                "tool": "rank_results",
                "message": "Rank local and external candidates against the goal.",
            },
        ]
    )

    if wants_ingestion:
        plan.append(
            {
                "tool": "add_paper",
                "message": "Index the top ranked external papers.",
            }
        )

    if wants_topology or wants_ingestion:
        plan.append(
            {
                "tool": "rebuild_topology",
                "message": "Refresh the topology map after library changes.",
            }
        )

    plan.append(
        {
            "tool": "summarize_workflow",
            "message": "Summarize what was searched, selected, and changed.",
        }
    )
    return plan


@traceable(name="agent_workflow_tool", run_type="chain")
def workflow_agent_tool(state: AgentState) -> Dict[str, Any]:
    question = state["question"]
    query = _clean_workflow_query(question)
    rank_limit = _requested_top_n(question)
    trace = state.get("tool_trace", []) + [
        _trace("plan_workflow", step["message"], "planned")
        for step in _workflow_plan(state)
    ]

    all_sources: List[Dict[str, Any]] = []
    ranked_sources: List[Dict[str, Any]] = []
    ingested_titles: List[str] = []
    topology: Dict[str, Any] | None = None
    graph_answer = ""
    notes: List[str] = []

    try:
        library = call_mcp_tool(
            "research.search_library",
            {
                "query": query,
                "domain": state.get("domain"),
                "category": state.get("category"),
                "limit": 10,
            },
        )
        local_papers = library.get("articles", [])
        all_sources.extend(local_papers)
        trace.append(_trace("search_library", f"Found {len(local_papers)} indexed candidates."))
    except Exception as exc:
        trace.append(_trace("search_library", str(exc), "error"))

    if _wants_graph_context(question):
        try:
            graph = call_mcp_tool(
                "research.query_graph_rag",
                {
                    "query": query,
                    "domain": state.get("domain"),
                    "category": state.get("category"),
                    "limit": 8,
                },
            )
            graph_answer = str(graph.get("answer") or "")
            graph_papers = graph.get("papers", [])
            all_sources.extend(graph_papers)
            trace.append(_trace("query_graph_rag", graph.get("summary") or f"Returned {len(graph_papers)} graph papers."))
        except Exception as exc:
            trace.append(_trace("query_graph_rag", str(exc), "error"))

    try:
        paper_result = call_mcp_tool(
            "research.search_papers",
            {
                "description": query,
                "category": state.get("category"),
                "max_results": min(state.get("retrieval_limit", 10), 25),
                "sort_by": "relevance",
                "sources": state.get("paper_sources") or _requested_paper_sources(question),
            },
        )
        external_papers = paper_result.get("papers", [])
        all_sources.extend(external_papers)
        trace.append(
            _trace(
                "search_papers",
                paper_result.get("summary") or f"Found {len(external_papers)} external candidates.",
            )
        )
        if paper_result.get("warning"):
            notes.append(str(paper_result["warning"]))
    except Exception as exc:
        trace.append(_trace("search_papers", str(exc), "error"))

    ranked_sources = _rank_papers(all_sources, question, rank_limit)
    trace.append(_trace("rank_results", f"Selected {len(ranked_sources)} top candidates from {len(all_sources)} total candidates."))

    if _wants_ingestion(question):
        for paper in ranked_sources:
            if paper.get("article_id"):
                trace.append(_trace("add_paper", f"Skipped {paper.get('title') or 'paper'} because it is already indexed.", "skipped"))
                continue
            url = _paper_url(paper)
            if not url or not url.lower().startswith("http"):
                trace.append(_trace("add_paper", f"Skipped {paper.get('title') or 'paper'} because it has no URL.", "skipped"))
                continue
            try:
                result = call_mcp_tool(
                    "research.add_paper",
                    {
                        "url": url,
                        "title": paper.get("title"),
                        "domain": state.get("domain") or "research",
                        "category": state.get("category") or "uncategorized",
                        "tags": state.get("tags", []),
                    },
                )
                article = result.get("article", {})
                ingested_titles.append(str(article.get("title") or paper.get("title") or url))
                trace.append(_trace("add_paper", result.get("summary") or f"Indexed {url}."))
            except Exception as exc:
                trace.append(_trace("add_paper", str(exc), "error"))

    if _wants_topology(question) or ingested_titles:
        try:
            topology_result = call_mcp_tool(
                "research.rebuild_topology",
                {
                    "domain": state.get("domain"),
                    "category": state.get("category"),
                },
            )
            topology = topology_result.get("topology")
            trace.append(_trace("rebuild_topology", topology_result.get("summary") or "Rebuilt topology."))
        except Exception as exc:
            trace.append(_trace("rebuild_topology", str(exc), "error"))

    if not ranked_sources:
        try:
            rag = generate_answer(
                query=question,
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
            ranked_sources = rag.get("sources", [])
            trace.append(_trace("retrieve_papers", f"Retrieved {len(ranked_sources)} fallback grounded sources."))
        except Exception as exc:
            trace.append(_trace("retrieve_papers", str(exc), "error"))

    lines = [
        "I ran a research workflow for:",
        f"`{query}`",
        "",
        "**Workflow plan**",
        *[f"- {step['tool']}: {step['message']}" for step in _workflow_plan(state)],
        "",
        "**Top candidates**",
    ]

    if ranked_sources:
        lines.extend(_format_paper_line(index, paper) for index, paper in enumerate(ranked_sources, start=1))
    else:
        lines.append("No ranked paper candidates were available.")

    if graph_answer:
        lines.extend(["", "**Graph context**", graph_answer])

    if ingested_titles:
        lines.extend(["", "**Indexed papers**", *[f"- {title}" for title in ingested_titles]])

    if topology is not None:
        lines.append("")
        lines.append("Rebuilt the topology map for the updated library scope.")

    if notes:
        lines.extend(["", "**Notes**", *[f"- {note}" for note in notes]])

    trace.append(_trace("summarize_workflow", "Returned workflow summary."))

    return {
        "answer": "\n".join(lines),
        "sources": ranked_sources[:8],
        "topology": topology,
        "intent": "workflow_agent",
        "workflow_plan": _workflow_plan(state),
        "tool_trace": trace,
    }

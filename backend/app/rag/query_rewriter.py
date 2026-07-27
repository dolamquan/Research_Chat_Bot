from typing import Any, Dict, List

from langsmith import traceable


MAX_HISTORY_TURNS = 6
MAX_PINNED_SOURCES = 3
MAX_PINNED_CHARS = 700
MAX_REWRITTEN_QUERY_CHARS = 500

FOLLOW_UP_MARKERS = {
    "this",
    "that",
    "these",
    "those",
    "it",
    "they",
    "them",
    "he",
    "she",
    "above",
    "previous",
    "earlier",
    "paper",
    "passage",
    "section",
    "source",
}


def _get_llm_text(response: Any) -> str:
    if hasattr(response, "content"):
        return str(response.content)
    return str(response)


def _normalize_query(query: str) -> str:
    return " ".join(query.strip().split())


def _format_chat_history(chat_history: List[Dict[str, str]]) -> str:
    if not chat_history:
        return "No recent conversation."

    lines = []
    for turn in chat_history[-MAX_HISTORY_TURNS:]:
        role = str(turn.get("role", "user")).strip().lower()
        content = _normalize_query(str(turn.get("content", "")))

        if not content:
            continue

        if role not in {"user", "assistant"}:
            role = "user"

        lines.append(f"{role.title()}: {content}")

    return "\n".join(lines) if lines else "No recent conversation."


def _format_pinned_sources(pinned_sources: List[Dict[str, Any]]) -> str:
    if not pinned_sources:
        return "No selected sources."

    formatted_sources = []
    for index, source in enumerate(pinned_sources[:MAX_PINNED_SOURCES], start=1):
        title = source.get("source") or source.get("topic") or "unknown source"
        text = _normalize_query(str(source.get("text", "")))[:MAX_PINNED_CHARS]

        if not text:
            continue

        formatted_sources.append(
            f"Selected source {index}: {title}\n{text}"
        )

    return "\n\n".join(formatted_sources) if formatted_sources else "No selected sources."


@traceable(name="should_rewrite_query", run_type="chain")
def should_rewrite_query(
    query: str,
    chat_history: List[Dict[str, str]] | None = None,
    pinned_sources: List[Dict[str, Any]] | None = None,
    document_source: str | None = None,
) -> bool:
    """
    Decide whether the user's question needs context to become a strong retrieval query.
    """
    normalized_query = _normalize_query(query)
    if not normalized_query:
        return False

    has_context = bool(chat_history or pinned_sources or document_source)
    if not has_context:
        return False

    words = {
        word.strip(".,?!:;()[]{}\"'").lower()
        for word in normalized_query.split()
    }

    has_follow_up_marker = bool(words & FOLLOW_UP_MARKERS)
    is_short = len(normalized_query.split()) <= 10

    return has_follow_up_marker or is_short


@traceable(name="rewrite_query_for_retrieval", run_type="chain")
def rewrite_query_for_retrieval(
    query: str,
    llm: Any,
    chat_history: List[Dict[str, str]] | None = None,
    pinned_sources: List[Dict[str, Any]] | None = None,
    cluster_id: int | None = None,
    document_source: str | None = None,
    context_mode: str = "retrieval",
) -> str:
    """
    Rewrite vague follow-up questions into standalone search queries.

    This query is only used for retrieval/reranking. The final answer prompt should
    still use the user's original question.
    """
    original_query = _normalize_query(query)
    if not should_rewrite_query(
        query=original_query,
        chat_history=chat_history or [],
        pinned_sources=pinned_sources or [],
        document_source=document_source,
    ):
        return original_query

    prompt = f"""
You rewrite user questions for a research-paper retrieval system.

Your task:
- Convert the user's latest question into one standalone search query.
- Resolve vague references using recent conversation, selected sources, and scope.
- Preserve the user's intent.
- Do not answer the question.
- Do not add facts that are not implied by the provided context.
- Return only the rewritten search query.

Scope:
- cluster_id: {cluster_id if cluster_id is not None else "all clusters"}
- document_source: {document_source or "no specific document"}
- context_mode: {context_mode}

Recent conversation:
{_format_chat_history(chat_history or [])}

Selected sources:
{_format_pinned_sources(pinned_sources or [])}

User question:
{original_query}

Standalone retrieval query:
""".strip()

    try:
        rewritten_query = _normalize_query(_get_llm_text(llm.invoke(prompt)))
    except Exception:
        return original_query

    if not rewritten_query:
        return original_query

    return rewritten_query[:MAX_REWRITTEN_QUERY_CHARS]

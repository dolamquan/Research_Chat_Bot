from typing import Any, List

from langsmith import traceable

from app.rag.prompt_cache import cached_llm_text


MAX_SUBQUERIES = 3
MAX_SUBQUERY_CHARS = 300

COMPLEX_QUERY_MARKERS = {
    "compare",
    "comparison",
    "contrast",
    "versus",
    "vs",
    "difference",
    "differences",
    "similarities",
    "relationship",
    "relate",
    "methodology",
    "methodologies",
    "methods",
    "results",
    "findings",
    "limitations",
    "contributions",
    "evaluate",
    "analysis",
    "survey",
    "overview",
}


def _get_llm_text(response: Any) -> str:
    if hasattr(response, "content"):
        return str(response.content)
    return str(response)


def _normalize_query(query: str) -> str:
    return " ".join(query.strip().split())


def _parse_subqueries(text: str) -> List[str]:
    subqueries = []

    for line in text.splitlines():
        cleaned = line.strip()
        cleaned = cleaned.lstrip("-*0123456789. )\t").strip()

        if not cleaned:
            continue

        if cleaned.lower().startswith("subqueries"):
            continue

        if cleaned not in subqueries:
            subqueries.append(cleaned[:MAX_SUBQUERY_CHARS])

        if len(subqueries) >= MAX_SUBQUERIES:
            break

    return subqueries


@traceable(name="should_decompose_query", run_type="chain")
def should_decompose_query(
    query: str,
    context_mode: str = "retrieval",
    cluster_id: int | None = None,
    document_source: str | None = None,
) -> bool:
    """
    Decide whether a query is broad enough to benefit from multiple retrieval searches.
    """
    normalized_query = _normalize_query(query)
    if not normalized_query:
        return False

    words = {
        word.strip(".,?!:;()[]{}\"'").lower()
        for word in normalized_query.split()
    }

    has_complex_marker = bool(words & COMPLEX_QUERY_MARKERS)
    has_multiple_parts = " and " in f" {normalized_query.lower()} "
    is_long = len(normalized_query.split()) >= 16
    scoped_to_many_documents = cluster_id is not None and document_source is None
    broad_document_question = context_mode == "retrieval" and document_source is not None

    return (
        has_complex_marker
        and (has_multiple_parts or is_long or scoped_to_many_documents or broad_document_question)
    )


@traceable(name="decompose_query_for_retrieval", run_type="chain")
def decompose_query_for_retrieval(
    query: str,
    llm: Any,
    context_mode: str = "retrieval",
    cluster_id: int | None = None,
    document_source: str | None = None,
    max_subqueries: int = MAX_SUBQUERIES,
) -> List[str]:
    """
    Split a broad research question into focused retrieval queries.

    The returned queries are only used for retrieval/reranking. The final answer
    prompt still uses the user's original question.
    """
    original_query = _normalize_query(query)
    if not should_decompose_query(
        query=original_query,
        context_mode=context_mode,
        cluster_id=cluster_id,
        document_source=document_source,
    ):
        return [original_query]

    prompt = f"""
You decompose broad research-paper questions for a retrieval system.

Return {max_subqueries} or fewer standalone search queries.
Each sub-query should target one evidence need.
Do not answer the question.
Do not include explanations.
Return one sub-query per line.

Scope:
- cluster_id: {cluster_id if cluster_id is not None else "all clusters"}
- document_source: {document_source or "no specific document"}
- context_mode: {context_mode}

Question:
{original_query}

Sub-queries:
""".strip()

    try:
        subqueries = _parse_subqueries(
            cached_llm_text(
                llm=llm,
                prompt=prompt,
                namespace="query_decomposer",
            )
        )
    except Exception:
        return [original_query]

    if not subqueries:
        return [original_query]

    if original_query not in subqueries:
        subqueries.insert(0, original_query)

    return subqueries[:max_subqueries]

from typing import Any, Dict, List

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langsmith import traceable

from app.rag.prompt import build_no_context_response, build_rag_prompt
from app.rag.graph_rag import query_graph_rag
from app.rag.query_decomposer import decompose_query_for_retrieval
from app.rag.query_rewriter import rewrite_query_for_retrieval
from app.rag.reranker import rerank_chunks, rerank_chunks_parallel
from app.rag.retriever import retrieve, retrieve_document_chunks


DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_RETRIEVAL_LIMIT = 8
DEFAULT_CONTEXT_LIMIT = 5
DEFAULT_RERANK_WORKERS = 3
MAX_WHOLE_DOCUMENT_CHUNKS = 500
MAX_WHOLE_DOCUMENT_CHARS = 100_000
GRAPH_PAPER_LIMIT = 8


def _source_key(source: Dict[str, Any]) -> str:
    return str(
        source.get("id")
        or f"{source.get('document_id', 'doc')}:{source.get('parent_id', 'parent')}:{source.get('child_index', 0)}"
    )


@traceable(name="merge_sources", run_type="chain")
def _merge_sources(
    selected_sources: List[Dict[str, Any]],
    retrieved_sources: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    seen: set[str] = set()

    for source in [*selected_sources, *retrieved_sources]:
        key = _source_key(source)

        if key in seen:
            continue

        merged.append(source)
        seen.add(key)

    return merged


@traceable(name="deduplicate_chunks", run_type="chain")
def _deduplicate_chunks(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Remove duplicate chunks after multi-query retrieval while preserving order.
    """
    unique_chunks: List[Dict[str, Any]] = []
    seen: set[str] = set()

    for chunk in chunks:
        key = _source_key(chunk)

        if key in seen:
            continue

        unique_chunks.append(chunk)
        seen.add(key)

    return unique_chunks


def _graph_paper_context(graph_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    context: List[Dict[str, Any]] = []
    concepts = [
        str(concept.get("label", ""))
        for concept in graph_result.get("concepts", [])
        if concept.get("label")
    ]

    for index, paper in enumerate(graph_result.get("papers", [])):
        title = str(paper.get("label") or paper.get("title") or "Untitled paper")
        abstract = str(paper.get("abstract") or "").strip()
        tags = paper.get("tags") or []
        text_parts = [
            f"Graph RAG matched this paper through connected concepts: {', '.join(concepts[:8]) or 'nearby graph nodes'}.",
            f"Title: {title}",
        ]
        if abstract:
            text_parts.append(f"Abstract: {abstract}")
        if tags:
            text_parts.append(f"Tags: {', '.join(str(tag) for tag in tags[:12])}")

        context.append(
            {
                "id": f"graph:{paper.get('id', index)}",
                "score": max(0.0, 1.0 - index * 0.05),
                "text": "\n".join(text_parts),
                "source": paper.get("source"),
                "article_id": paper.get("article_id"),
                "title": title,
                "url": paper.get("url"),
                "domain": paper.get("domain", "research"),
                "category": paper.get("category", "uncategorized"),
                "tags": tags,
                "topic": "graph_rag",
                "document_type": "graph_node",
                "section_type": "paper_metadata",
                "summary": graph_result.get("answer", ""),
                "retrieval_strategy": "graph",
            }
        )

    return context


@traceable(name="retrieve_graph_guided_chunks", run_type="retriever")
def _retrieve_graph_guided_chunks(
    query: str,
    limit: int,
    domain: str | None = None,
    category: str | None = None,
) -> List[Dict[str, Any]]:
    graph_result = query_graph_rag(
        query=query,
        domain=domain,
        category=category,
        limit=GRAPH_PAPER_LIMIT,
    )
    graph_context = _graph_paper_context(graph_result)
    paper_sources = [
        str(paper.get("source"))
        for paper in graph_result.get("papers", [])
        if paper.get("source")
    ]
    if not paper_sources:
        return graph_context

    per_paper_limit = max(1, min(4, limit // max(len(paper_sources), 1) + 1))
    chunks: List[Dict[str, Any]] = []
    for source in paper_sources[:GRAPH_PAPER_LIMIT]:
        chunks.extend(
            retrieve(
                query,
                limit=per_paper_limit,
                document_source=source,
                domain=domain,
                category=category,
            )
        )

    return [
        {**chunk, "retrieval_strategy": "graph"}
        for chunk in _deduplicate_chunks(chunks)
    ] + graph_context


@traceable(name="trim_whole_document_context", run_type="chain")
def _trim_whole_document_context(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    trimmed = []
    total_chars = 0

    for chunk in chunks:
        text = str(chunk.get("text") or "")
        if not text.strip():
            continue

        if total_chars + len(text) > MAX_WHOLE_DOCUMENT_CHARS:
            break

        trimmed.append(chunk)
        total_chars += len(text)

    return trimmed


def get_llm(model: str = DEFAULT_MODEL, temperature: float = 0) -> ChatOpenAI:
    load_dotenv()

    return ChatOpenAI(
        model=model,
        temperature=temperature,
    )


def _get_llm_text(response: Any) -> str:
    if hasattr(response, "content"):
        return response.content
    return str(response)


@traceable(name="call_answer_llm", run_type="llm")
def call_answer_llm(llm: Any, prompt: str) -> str:
    response = llm.invoke(prompt)
    return _get_llm_text(response).strip()


@traceable(name="generate_answer", run_type="chain")
def generate_answer(
    query: str,
    llm: Any = None,
    retrieval_limit: int = DEFAULT_RETRIEVAL_LIMIT,
    context_limit: int = DEFAULT_CONTEXT_LIMIT,
    context_mode: str = "retrieval",
    retrieval_strategy: str = "vector",
    use_reranking: bool = True,
    parallel_reranking: bool = True,
    rerank_workers: int = DEFAULT_RERANK_WORKERS,
    chat_history: List[Dict[str, str]] | None = None,
    pinned_sources: List[Dict[str, Any]] | None = None,
    cluster_id: int | None = None,
    document_source: str | None = None,
    domain: str | None = None,
    category: str | None = None,
    tags: List[str] | None = None,
) -> Dict[str, Any]:
    if llm is None:
        llm = get_llm()

    selected_sources = pinned_sources or []
    use_whole_document = context_mode == "whole_document" and bool(document_source)
    retrieval_query = query
    strategy = retrieval_strategy if retrieval_strategy in {"vector", "graph", "hybrid"} else "vector"

    if use_whole_document:
        retrieved_chunks = retrieve_document_chunks(
            document_source=str(document_source),
            limit=MAX_WHOLE_DOCUMENT_CHUNKS,
        )
    else:
        retrieval_query = rewrite_query_for_retrieval(
            query=query,
            llm=llm,
            chat_history=chat_history or [],
            pinned_sources=selected_sources,
            cluster_id=cluster_id,
            document_source=document_source,
            context_mode=context_mode,
        )
        retrieval_queries = decompose_query_for_retrieval(
            query=retrieval_query,
            llm=llm,
            context_mode=context_mode,
            cluster_id=cluster_id,
            document_source=document_source,
        )
        retrieved_chunks = []

        if strategy in {"vector", "hybrid"}:
            for current_query in retrieval_queries:
                retrieved_chunks.extend(
                    retrieve(
                        current_query,
                        limit=retrieval_limit,
                        cluster_id=cluster_id,
                        document_source=document_source,
                        domain=domain,
                        category=category,
                        tags=tags,
                    )
                )

        if strategy in {"graph", "hybrid"} and not document_source:
            for current_query in retrieval_queries:
                retrieved_chunks.extend(
                    _retrieve_graph_guided_chunks(
                        query=current_query,
                        limit=retrieval_limit,
                        domain=domain,
                        category=category,
                    )
                )

        retrieved_chunks = _deduplicate_chunks(retrieved_chunks)

    if not retrieved_chunks and not selected_sources:
        return {
            "answer": build_no_context_response(),
            "sources": [],
        }

    if use_whole_document:
        retrieved_context = _trim_whole_document_context(retrieved_chunks)
    elif use_reranking and retrieved_chunks:
        if parallel_reranking:
            retrieved_context = rerank_chunks_parallel(
                query=retrieval_query,
                chunks=retrieved_chunks,
                top_n=context_limit,
                max_workers=rerank_workers,
            )
        else:
            retrieved_context = rerank_chunks(
                query=retrieval_query,
                chunks=retrieved_chunks,
                top_n=context_limit,
            )
    else:
        retrieved_context = retrieved_chunks[:context_limit]

    final_sources = _merge_sources(
        selected_sources=selected_sources,
        retrieved_sources=retrieved_context,
    )

    prompt = build_rag_prompt(
        query=query,
        chunks=retrieved_context,
        chat_history=chat_history or [],
        pinned_sources=selected_sources,
        context_label=(
            "Whole paper chunk"
            if use_whole_document
            else "Graph or vector source"
            if strategy == "hybrid"
            else "Graph source"
            if strategy == "graph"
            else "Retrieved source"
        ),
    )

    answer = call_answer_llm(llm=llm, prompt=prompt)

    return {
        "answer": answer,
        "sources": final_sources,
        "retrieval_strategy": "whole_document" if use_whole_document else strategy,
    }


@traceable(name="generate_answer_text", run_type="chain")
def generate_answer_text(
    query: str,
    llm: Any = None,
    retrieval_limit: int = DEFAULT_RETRIEVAL_LIMIT,
    context_limit: int = DEFAULT_CONTEXT_LIMIT,
    context_mode: str = "retrieval",
    retrieval_strategy: str = "vector",
    use_reranking: bool = True,
    parallel_reranking: bool = True,
    rerank_workers: int = DEFAULT_RERANK_WORKERS,
    chat_history: List[Dict[str, str]] | None = None,
    pinned_sources: List[Dict[str, Any]] | None = None,
    cluster_id: int | None = None,
    document_source: str | None = None,
    domain: str | None = None,
    category: str | None = None,
    tags: List[str] | None = None,
) -> str:
    result = generate_answer(
        query=query,
        llm=llm,
        retrieval_limit=retrieval_limit,
        context_limit=context_limit,
        context_mode=context_mode,
        retrieval_strategy=retrieval_strategy,
        use_reranking=use_reranking,
        parallel_reranking=parallel_reranking,
        rerank_workers=rerank_workers,
        chat_history=chat_history or [],
        pinned_sources=pinned_sources or [],
        cluster_id=cluster_id,
        document_source=document_source,
        domain=domain,
        category=category,
        tags=tags,
    )

    return result["answer"]

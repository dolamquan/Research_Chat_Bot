import re
from pathlib import Path
from typing import Any, Dict, List

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI  # noqa: F401  (kept for type parity)
from langsmith import traceable

from app.rag.llm_provider import build_chat_model, resolve_provider

from app.rag.prompt import build_no_context_response, build_rag_prompt
from app.rag.formula_extractor import extract_document_formula_report
from app.rag.graph_rag import query_graph_rag
from app.rag.prompt_cache import cached_llm_text
from app.rag.query_decomposer import decompose_query_for_retrieval
from app.rag.query_rewriter import rewrite_query_for_retrieval
from app.rag.reranker import rerank_chunks, rerank_chunks_parallel
from app.rag.retriever import retrieve, retrieve_document_chunks
from app.rag.visual_analyzer import transcribe_formula_image


DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_RETRIEVAL_LIMIT = 8
DEFAULT_CONTEXT_LIMIT = 5
DEFAULT_RERANK_WORKERS = 3
MAX_WHOLE_DOCUMENT_CHUNKS = 500
MAX_WHOLE_DOCUMENT_CHARS = 100_000
GRAPH_PAPER_LIMIT = 8

GREETING_PATTERN = re.compile(
    r"^\s*(hi|hello|hey|yo|good\s+(morning|afternoon|evening)|thanks|thank\s+you)\s*[!.?]*\s*$",
    re.IGNORECASE,
)

PAPER_REQUEST_PATTERN = re.compile(
    r"\b(paper|papers|article|articles|study|studies|research)\b.*\b(about|on|related|relevant|similar|recommend|show|give|find|list)\b|\b(give|show|find|list|recommend)\b.*\b(paper|papers|article|articles|studies)\b",
    re.IGNORECASE,
)

FORMULA_REQUEST_PATTERN = re.compile(
    r"\b(formula|formulas|equation|equations|math|mathematical|notation|derive|derivation)\b",
    re.IGNORECASE,
)


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


def get_llm(
    model: str = DEFAULT_MODEL,
    temperature: float = 0,
    provider: str | None = None,
) -> Any:
    """Construct a chat model.

    Delegates to the provider adapter so OpenAI and Anthropic are selectable
    through one interface. The signature and default behaviour are unchanged:
    with no `provider` and no `LLM_PROVIDER` set, this returns the same
    `ChatOpenAI(model=DEFAULT_MODEL)` it always did, so the existing callers
    across the RAG package keep working untouched.
    """
    load_dotenv()
    resolved = resolve_provider(provider)

    # `model` carries an OpenAI default, so passing it verbatim to another
    # provider would request a model that does not exist there. Only forward it
    # when the caller actually meant this provider.
    requested_model = model if (resolved == "openai" or model != DEFAULT_MODEL) else None

    return build_chat_model(
        provider=resolved, model=requested_model, temperature=temperature
    )


def _get_llm_text(response: Any) -> str:
    if hasattr(response, "content"):
        return response.content
    return str(response)


def _is_simple_greeting(query: str) -> bool:
    return bool(GREETING_PATTERN.match(query))


def _is_paper_request(query: str) -> bool:
    return bool(PAPER_REQUEST_PATTERN.search(query))


def _is_formula_request(query: str) -> bool:
    return bool(FORMULA_REQUEST_PATTERN.search(query))


def _is_visual_source(source: Dict[str, Any]) -> bool:
    return bool(
        source.get("image_path")
        or source.get("image_url")
        or source.get("document_type") == "visual_asset"
    )


def _pinned_formula_visuals(sources: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [source for source in sources if _is_visual_source(source)]


def _render_formula_visual_answer(
    query: str,
    visual_sources: List[Dict[str, Any]],
    llm: Any,
) -> str | None:
    for source in visual_sources:
        image_path = source.get("image_path")
        if not image_path:
            continue

        answer = transcribe_formula_image(
            image_path=Path(str(image_path)),
            context=str(source.get("text") or source.get("title") or query),
            page=source.get("page") if isinstance(source.get("page"), int) else None,
        )
        if answer and "could not transcribe" not in answer.lower():
            return answer

    visual_text = "\n\n".join(
        str(source.get("text") or source.get("summary") or "")
        for source in visual_sources
        if str(source.get("text") or source.get("summary") or "").strip()
    ).strip()

    if not visual_text:
        return None

    prompt = f"""
You are helping render a selected mathematical formula from a research-paper figure.

Use only the selected visual context below. If the exact equation is present or can be directly transcribed from the context, return it as Markdown with a single display LaTeX block delimited by $$ ... $$.
If the context only describes the formula and does not contain enough exact notation, say that a tighter image crop or OCR transcription is needed.
Do not invent variables or terms not present in the selected context.

User request:
{query}

Selected visual context:
{visual_text}

Answer:
""".strip()
    return call_answer_llm(llm=llm, prompt=prompt)


def _title_from_source(source: str) -> str:
    title = re.sub(r"\.pdf$", "", source, flags=re.IGNORECASE)
    title = re.sub(r"^\d{4}\.\d+(?:v\d+)?_", "", title)
    return re.sub(r"[_-]+", " ", title).strip()


def _paper_list_answer(sources: List[Dict[str, Any]]) -> str:
    papers: List[Dict[str, Any]] = []
    seen: set[str] = set()

    for source in sources:
        source_name = str(source.get("source") or "").strip()
        if not source_name or source_name in seen:
            continue

        seen.add(source_name)
        papers.append(source)

        if len(papers) >= 5:
            break

    if not papers:
        return "I found relevant passages, but I could not identify distinct paper records from the retrieved sources."

    lines = ["Here are papers I found in your indexed library:"]
    for index, paper in enumerate(papers, start=1):
        source_name = str(paper.get("source") or "")
        title = str(paper.get("title") or "").strip() or _title_from_source(source_name)
        category = str(paper.get("category") or "uncategorized")
        domain = str(paper.get("domain") or "research")
        summary = str(paper.get("summary") or paper.get("text") or "").strip()
        if len(summary) > 220:
            summary = summary[:217].rstrip() + "..."

        lines.append(f"\n{index}. **{title}**")
        lines.append(f"   {category} - {domain}")
        if summary:
            lines.append(f"   {summary}")

    lines.append("\nUse the **Read PDF** button on any paper card to open it.")
    return "\n".join(lines)


@traceable(name="call_answer_llm", run_type="llm")
def call_answer_llm(llm: Any, prompt: str) -> str:
    return cached_llm_text(
        llm=llm,
        prompt=prompt,
        namespace="rag_answer",
    ).strip()


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

    if _is_simple_greeting(query):
        return {
            "answer": "Hello! Ask me about your indexed research papers, or ask me to find papers on a topic.",
            "sources": [],
            "retrieval_strategy": "none",
        }

    selected_sources = pinned_sources or []
    use_whole_document = context_mode == "whole_document" and bool(document_source)
    retrieval_query = query
    strategy = retrieval_strategy if retrieval_strategy in {"vector", "graph", "hybrid"} else "vector"

    if _is_formula_request(query):
        formula_visuals = _pinned_formula_visuals(selected_sources)
        if formula_visuals:
            visual_answer = _render_formula_visual_answer(
                query=query,
                visual_sources=formula_visuals,
                llm=llm,
            )
            if visual_answer:
                return {
                    "answer": visual_answer,
                    "sources": formula_visuals,
                    "retrieval_strategy": "formula_visual",
                }

    if document_source and _is_formula_request(query):
        formula_report = extract_document_formula_report(
            str(document_source),
            llm=llm,
        )
        return {
            "answer": formula_report["answer"],
            "sources": formula_report["sources"],
            "retrieval_strategy": "formula_extraction",
        }

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

        # A selected document should behave like article-only retrieval. Graph-guided
        # retrieval intentionally searches across the collection, so skip it here.
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

    if _is_paper_request(query) and final_sources and not document_source:
        return {
            "answer": _paper_list_answer(final_sources),
            "sources": final_sources,
            "retrieval_strategy": "whole_document" if use_whole_document else strategy,
        }

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

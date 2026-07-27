from typing import Any, Dict, List

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI

from app.rag.prompt import build_no_context_response, build_rag_prompt
from app.rag.reranker import rerank_chunks, rerank_chunks_parallel
from app.rag.retriever import retrieve, retrieve_document_chunks


DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_RETRIEVAL_LIMIT = 8
DEFAULT_CONTEXT_LIMIT = 5
DEFAULT_RERANK_WORKERS = 3
MAX_WHOLE_DOCUMENT_CHUNKS = 500
MAX_WHOLE_DOCUMENT_CHARS = 100_000


def _source_key(source: Dict[str, Any]) -> str:
    """
    Build a stable key so selected sources and retrieved chunks are not duplicated.
    """
    return str(
        source.get("id")
        or f"{source.get('document_id', 'doc')}:{source.get('parent_id', 'parent')}:{source.get('child_index', 0)}"
    )


def _merge_sources(
    selected_sources: List[Dict[str, Any]],
    retrieved_sources: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Put user-selected sources first, then append retrieved sources not already present.
    """
    merged: List[Dict[str, Any]] = []
    seen: set[str] = set()

    for source in [*selected_sources, *retrieved_sources]:
        key = _source_key(source)

        if key in seen:
            continue

        merged.append(source)
        seen.add(key)

    return merged


def _trim_whole_document_context(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Keep document-order chunks until the prompt budget is reached.
    """
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
    """
    Create the chat model used for reranking and final answer generation.
    """
    load_dotenv()

    return ChatOpenAI(
        model=model,
        temperature=temperature,
    )


def _get_llm_text(response: Any) -> str:
    """
    Supports LangChain AIMessage objects and plain string responses.
    """
    if hasattr(response, "content"):
        return response.content
    return str(response)


def generate_answer(
    query: str,
    llm: Any = None,
    retrieval_limit: int = DEFAULT_RETRIEVAL_LIMIT,
    context_limit: int = DEFAULT_CONTEXT_LIMIT,
    context_mode: str = "retrieval",
    use_reranking: bool = True,
    parallel_reranking: bool = True,
    rerank_workers: int = DEFAULT_RERANK_WORKERS,
    chat_history: List[Dict[str, str]] | None = None,
    pinned_sources: List[Dict[str, Any]] | None = None,
    cluster_id: int | None = None,
    document_source: str | None = None,
) -> Dict[str, Any]:
    """
    Run the full RAG answer flow for one user query.
    """
    if llm is None:
        llm = get_llm()

    selected_sources = pinned_sources or []
    use_whole_document = context_mode == "whole_document" and bool(document_source)

    if use_whole_document:
        retrieved_chunks = retrieve_document_chunks(
            document_source=str(document_source),
            limit=MAX_WHOLE_DOCUMENT_CHUNKS,
        )
    else:
        retrieved_chunks = retrieve(
            query,
            limit=retrieval_limit,
            cluster_id=cluster_id,
            document_source=document_source,
        )

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
                query=query,
                chunks=retrieved_chunks,
                top_n=context_limit,
                max_workers=rerank_workers,
            )
        else:
            retrieved_context = rerank_chunks(
                query=query,
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
        context_label="Whole paper chunk" if use_whole_document else "Retrieved source",
    )
    response = llm.invoke(prompt)
    answer = _get_llm_text(response).strip()

    return {
        "answer": answer,
        "sources": final_sources,
    }


def generate_answer_text(
    query: str,
    llm: Any = None,
    retrieval_limit: int = DEFAULT_RETRIEVAL_LIMIT,
    context_limit: int = DEFAULT_CONTEXT_LIMIT,
    context_mode: str = "retrieval",
    use_reranking: bool = True,
    parallel_reranking: bool = True,
    rerank_workers: int = DEFAULT_RERANK_WORKERS,
    chat_history: List[Dict[str, str]] | None = None,
    pinned_sources: List[Dict[str, Any]] | None = None,
    cluster_id: int | None = None,
    document_source: str | None = None,
) -> str:
    """
    Convenience wrapper when the caller only needs the answer string.
    """
    result = generate_answer(
        query=query,
        llm=llm,
        retrieval_limit=retrieval_limit,
        context_limit=context_limit,
        context_mode=context_mode,
        use_reranking=use_reranking,
        parallel_reranking=parallel_reranking,
        rerank_workers=rerank_workers,
        chat_history=chat_history or [],
        pinned_sources=pinned_sources or [],
        cluster_id=cluster_id,
        document_source=document_source,
    )

    return result["answer"]

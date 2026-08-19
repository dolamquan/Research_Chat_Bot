import re
from typing import Any, Dict, List

from langsmith import traceable

from app.rag.generator import DEFAULT_MODEL, call_answer_llm, get_llm
from app.rag.paper_visualizer import (
    DIAGRAM_KINDS,
    extract_diagram_ir,
    ir_to_mermaid,
    layout_ir,
)
from app.rag.retriever import retrieve, retrieve_document_chunks
from app.storage.article_store import get_article, list_articles
from app.storage.visualization_store import upsert_visualization


MAX_TOOL_CHUNKS = 80
MAX_TOOL_CONTEXT_CHARS = 45_000


def _string(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _find_article(
    article_id: str | None = None,
    document_source: str | None = None,
    title: str | None = None,
) -> Dict[str, Any] | None:
    if article_id:
        try:
            return get_article(article_id)
        except ValueError:
            pass

    articles = list_articles(limit=2000)
    if document_source:
        for article in articles:
            if article.get("source") == document_source:
                return article

    if title:
        target = title.strip().lower()
        for article in articles:
            if article.get("title", "").strip().lower() == target:
                return article
        for article in articles:
            if target in article.get("title", "").strip().lower():
                return article

    return None


def _resolve_document_source(args: Dict[str, Any]) -> str | None:
    document_source = _string(args.get("document_source") or args.get("source")).strip()
    if document_source:
        return document_source

    article = _find_article(
        article_id=_string(args.get("article_id") or "").strip() or None,
        title=_string(args.get("title") or "").strip() or None,
    )
    if article:
        return article.get("source")

    return None


def _format_context(chunks: List[Dict[str, Any]], max_chars: int = MAX_TOOL_CONTEXT_CHARS) -> str:
    parts = []
    total = 0
    for index, chunk in enumerate(chunks, start=1):
        text = _string(chunk.get("text")).strip()
        if not text:
            continue
        title = chunk.get("title") or chunk.get("source") or "Unknown source"
        page = chunk.get("page")
        label = f"[{index}] {title}"
        if page:
            label += f", p.{page}"
        item = f"{label}\n{text}"
        if total + len(item) > max_chars:
            break
        parts.append(item)
        total += len(item)
    return "\n\n".join(parts)


def _article_header(article: Dict[str, Any] | None) -> str:
    if not article:
        return ""
    fields = [
        f"Title: {article.get('title', '')}",
        f"Authors: {', '.join(article.get('authors', [])[:12])}",
        f"Published: {article.get('published_at', '')}",
        f"Domain: {article.get('domain', '')}",
        f"Category: {article.get('category', '')}",
        f"Tags: {', '.join(article.get('tags', []))}",
        f"URL: {article.get('url') or article.get('pdf_url') or ''}",
    ]
    abstract = article.get("abstract")
    if abstract:
        fields.append(f"Abstract: {abstract}")
    return "\n".join(field for field in fields if not field.endswith(": "))


def _strip_code_fence(text: str) -> str:
    match = re.search(r"```(?:mermaid)?\s*(.*?)```", text, flags=re.IGNORECASE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()


def _load_tool_chunks(args: Dict[str, Any]) -> tuple[Dict[str, Any] | None, List[Dict[str, Any]], str]:
    document_source = _resolve_document_source(args)
    article = _find_article(
        article_id=_string(args.get("article_id") or "").strip() or None,
        document_source=document_source,
        title=_string(args.get("title") or "").strip() or None,
    )

    if document_source:
        chunks = retrieve_document_chunks(
            document_source=document_source,
            limit=int(args.get("chunk_limit") or MAX_TOOL_CHUNKS),
        )
        return article, chunks, document_source

    query = _string(args.get("query") or args.get("topic") or args.get("title")).strip()
    if not query:
        raise ValueError("Provide document_source, article_id, title, query, or topic")

    chunks = retrieve(
        query=query,
        limit=int(args.get("chunk_limit") or 20),
        domain=_string(args.get("domain") or "").strip() or None,
        category=_string(args.get("category") or "").strip() or None,
    )
    return article, chunks, ""


@traceable(name="summarize_paper_tool_logic", run_type="chain")
def summarize_paper(args: Dict[str, Any]) -> Dict[str, Any]:
    article, chunks, document_source = _load_tool_chunks(args)
    if not chunks and not article:
        raise ValueError("No paper context found to summarize")

    style = _string(args.get("style"), "structured").strip() or "structured"
    context = _format_context(chunks)
    header = _article_header(article)
    title = (
        _string(args.get("title")).strip()
        or (article or {}).get("title")
        or document_source
        or "Selected research context"
    )

    prompt = f"""
You are a careful research assistant. Summarize the research paper/context below.

Return a concise but useful Markdown summary with these sections:
- One-sentence takeaway
- Problem
- Proposed method
- Key contributions
- Experiments or evidence
- Limitations
- Useful follow-up questions

Style preference: {style}

Metadata:
{header}

Context:
{context}
"""
    summary = call_answer_llm(get_llm(temperature=0), prompt)

    return {
        "title": title,
        "document_source": document_source,
        "summary_text": summary,
        "source_count": len(chunks),
        "sources": chunks[:8],
    }


@traceable(name="generate_visualization_tool_logic", run_type="chain")
def generate_visualization(args: Dict[str, Any]) -> Dict[str, Any]:
    article, chunks, document_source = _load_tool_chunks(args)
    if not chunks and not article:
        raise ValueError("No paper context found to visualize")

    visualization_type = _string(args.get("visualization_type"), "method_flow").strip()
    title = (
        _string(args.get("title")).strip()
        or (article or {}).get("title")
        or document_source
        or "Research visualization"
    )

    # Constrained IR pipeline for structural diagrams; legacy raw-mermaid path
    # for the free-form kinds (concept_map, timeline, comparison).
    if visualization_type not in ("concept_map", "timeline", "comparison"):
        requested_kind = (
            visualization_type if visualization_type in DIAGRAM_KINDS else "auto"
        )
        ir = extract_diagram_ir(article, chunks, diagram_kind=requested_kind)
        diagram = layout_ir(ir)

        article_id = _string((article or {}).get("article_id")).strip()
        if article_id and document_source:
            upsert_visualization(
                article_id=article_id,
                document_source=document_source,
                diagram_kind=ir.diagram_kind,
                title=ir.title or title,
                algorithm_name=ir.algorithm_name,
                diagram=diagram,
                summary=ir.summary,
                key_insight=ir.key_insight,
                model=DEFAULT_MODEL,
                source_count=len(chunks),
            )

        return {
            "title": ir.title or title,
            "document_source": document_source,
            "visualization_type": ir.diagram_kind,
            "diagram_format": "mermaid",
            "mermaid": ir_to_mermaid(ir),
            "explanation": f"{ir.summary}\n\nKey insight: {ir.key_insight}",
            "ir": {
                "algorithm_name": ir.algorithm_name,
                "diagram_kind": ir.diagram_kind,
                "summary": ir.summary,
                "key_insight": ir.key_insight,
                "diagram": diagram,
            },
            "source_count": len(chunks),
            "sources": chunks[:8],
        }

    context = _format_context(chunks)
    header = _article_header(article)

    prompt = f"""
Create a Mermaid diagram for this research paper/context.

Visualization type requested: {visualization_type}

Rules:
- Return ONLY Mermaid syntax, without markdown fences.
- Prefer flowchart TD unless another Mermaid type is clearly better.
- Keep node labels short.
- Do not invent claims not supported by the context.
- Use quoted labels when labels contain punctuation.

Metadata:
{header}

Context:
{context}
"""
    mermaid = _strip_code_fence(call_answer_llm(get_llm(temperature=0), prompt))

    explanation_prompt = f"""
Briefly explain how this diagram represents the research paper.
Use 3-5 bullets.

Title: {title}
Diagram:
{mermaid}
"""
    explanation = call_answer_llm(get_llm(temperature=0), explanation_prompt)

    return {
        "title": title,
        "document_source": document_source,
        "visualization_type": visualization_type,
        "diagram_format": "mermaid",
        "mermaid": mermaid,
        "explanation": explanation,
        "source_count": len(chunks),
        "sources": chunks[:8],
    }

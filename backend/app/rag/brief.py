from typing import Any, Dict, List

from langsmith import traceable

from app.rag.generator import call_answer_llm, get_llm
from app.rag.graph_rag import build_graph_rag, load_graph_rag, query_graph_rag
from app.rag.retriever import retrieve
from app.storage.article_store import list_articles


DEFAULT_BRIEF_LIMIT = 8
CHUNKS_PER_PAPER = 2
MAX_BRIEF_CONTEXT_CHARS = 14000


def _paper_source(paper: Dict[str, Any]) -> str:
    return str(paper.get("source") or "")


def _paper_title(paper: Dict[str, Any]) -> str:
    return str(paper.get("label") or paper.get("title") or paper.get("source") or "Untitled paper")


def _article_to_paper_node(article: Dict[str, Any]) -> Dict[str, Any]:
    article_id = str(article.get("article_id") or article.get("source") or "")
    return {
        "id": f"paper:{article_id}",
        "type": "paper",
        "label": article.get("title") or article.get("source") or article_id,
        "article_id": article_id,
        "source": article.get("source"),
        "url": article.get("url") or article.get("pdf_url"),
        "domain": article.get("domain"),
        "category": article.get("category"),
        "tags": article.get("tags", []),
        "abstract": article.get("abstract") or "",
        "weight": 1,
        "x": 0,
        "y": 0,
    }


def _paper_metadata_source(paper: Dict[str, Any], index: int) -> Dict[str, Any]:
    title = _paper_title(paper)
    tags = paper.get("tags") or []
    text = "\n".join(
        part
        for part in [
            f"Title: {title}",
            f"Domain: {paper.get('domain') or 'research'}",
            f"Category: {paper.get('category') or 'uncategorized'}",
            f"Tags: {', '.join(str(tag) for tag in tags[:12])}" if tags else "",
            f"Abstract: {paper.get('abstract')}" if paper.get("abstract") else "",
        ]
        if part
    )
    return {
        "id": f"brief:paper:{paper.get('id') or index}",
        "score": max(0.0, 1.0 - index * 0.04),
        "text": text,
        "source": paper.get("source"),
        "article_id": paper.get("article_id"),
        "title": title,
        "url": paper.get("url"),
        "domain": paper.get("domain", "research"),
        "category": paper.get("category", "uncategorized"),
        "tags": tags,
        "document_type": "graph_node",
        "section_type": "paper_metadata",
        "topic": "research_brief",
    }


def _dedupe_sources(sources: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    deduped: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for source in sources:
        key = str(
            source.get("id")
            or f"{source.get('source')}:{source.get('parent_index')}:{source.get('child_index')}"
        )
        if key in seen:
            continue
        deduped.append(source)
        seen.add(key)
    return deduped


def _candidate_papers(
    topic: str,
    domain: str | None,
    category: str | None,
    article_ids: List[str] | None,
    limit: int,
) -> List[Dict[str, Any]]:
    selected_ids = {str(article_id) for article_id in article_ids or [] if str(article_id).strip()}

    if topic.strip():
        graph_result = query_graph_rag(
            query=topic,
            domain=domain,
            category=category,
            article_ids=article_ids,
            limit=limit,
        )
        papers = graph_result.get("papers") or []
        if papers:
            return papers[:limit]

    graph = load_graph_rag(domain=domain, category=category, article_ids=article_ids)
    if graph.get("stale"):
        graph = build_graph_rag(domain=domain, category=category, article_ids=article_ids)

    graph_papers = [node for node in graph.get("nodes", []) if node.get("type") == "paper"]
    if graph_papers:
        return graph_papers[:limit]

    articles = [
        article
        for article in list_articles(domain=domain, category=category, limit=5000)
        if article.get("status") == "indexed"
        and (
            not selected_ids
            or str(article.get("article_id")) in selected_ids
            or str(article.get("source")) in selected_ids
        )
    ]
    return [_article_to_paper_node(article) for article in articles[:limit]]


def _collect_brief_sources(
    topic: str,
    papers: List[Dict[str, Any]],
    domain: str | None,
    category: str | None,
) -> List[Dict[str, Any]]:
    sources: List[Dict[str, Any]] = []
    for index, paper in enumerate(papers):
        sources.append(_paper_metadata_source(paper, index))

        source = _paper_source(paper)
        if not source:
            continue

        query = topic.strip() or _paper_title(paper)
        try:
            sources.extend(
                retrieve(
                    query=query,
                    limit=CHUNKS_PER_PAPER,
                    document_source=source,
                    domain=domain,
                    category=category,
                )
            )
        except Exception:
            continue

    return _dedupe_sources(sources)


def _build_brief_prompt(topic: str, papers: List[Dict[str, Any]], sources: List[Dict[str, Any]]) -> str:
    paper_lines = []
    for index, paper in enumerate(papers, start=1):
        paper_lines.append(
            f"{index}. {_paper_title(paper)}"
            f" | category={paper.get('category') or 'uncategorized'}"
            f" | domain={paper.get('domain') or 'research'}"
        )

    context_lines: List[str] = []
    total_chars = 0
    for index, source in enumerate(sources, start=1):
        text = str(source.get("text") or "").strip()
        if not text:
            continue
        if total_chars + len(text) > MAX_BRIEF_CONTEXT_CHARS:
            break
        context_lines.append(
            f"[Source {index}] {source.get('title') or source.get('source') or 'Untitled'}\n{text}"
        )
        total_chars += len(text)

    return f"""
You are a research assistant creating a compact literature brief from indexed research papers.

Topic or scope:
{topic.strip() or "Current selected paper graph scope"}

Candidate papers:
{chr(10).join(paper_lines) or "No paper metadata available."}

Evidence:
{chr(10).join(context_lines) or "No retrieved text evidence available."}

Write a useful research brief with these sections:
1. Overview
2. Key papers
3. Shared themes and trends
4. Open problems or gaps
5. Recommended next reading order

Use only the provided evidence. If evidence is thin, say what is missing.
Keep it concise but specific.
""".strip()


def _fallback_brief(topic: str, papers: List[Dict[str, Any]]) -> str:
    title = topic.strip() or "the selected paper set"
    lines = [
        f"## Overview\nThis brief covers {title}. The current scope includes {len(papers)} indexed paper(s).",
        "## Key papers",
    ]
    for index, paper in enumerate(papers[:DEFAULT_BRIEF_LIMIT], start=1):
        abstract = str(paper.get("abstract") or "").strip()
        summary = f" - {abstract[:220]}..." if abstract else ""
        lines.append(f"{index}. **{_paper_title(paper)}**{summary}")
    lines.extend(
        [
            "## Shared themes and trends",
            "Use the graph concepts and paper links to inspect shared terminology, domains, and similar papers.",
            "## Open problems or gaps",
            "The deterministic fallback cannot judge research gaps without an LLM response.",
            "## Recommended next reading order",
            "Start with the highest-ranked papers above, then inspect connected concept nodes in the graph.",
        ]
    )
    return "\n\n".join(lines)


@traceable(name="generate_research_brief", run_type="chain")
def generate_research_brief(
    topic: str = "",
    domain: str | None = None,
    category: str | None = None,
    article_ids: List[str] | None = None,
    limit: int = DEFAULT_BRIEF_LIMIT,
    llm: Any = None,
) -> Dict[str, Any]:
    papers = _candidate_papers(
        topic=topic,
        domain=domain,
        category=category,
        article_ids=article_ids,
        limit=limit,
    )
    sources = _collect_brief_sources(
        topic=topic,
        papers=papers,
        domain=domain,
        category=category,
    )

    if not papers:
        return {
            "topic": topic,
            "brief": "No indexed papers were found for this topic or graph scope.",
            "papers": [],
            "sources": sources,
        }

    try:
        if llm is None:
            llm = get_llm()
        brief = call_answer_llm(llm=llm, prompt=_build_brief_prompt(topic, papers, sources))
    except Exception:
        brief = _fallback_brief(topic, papers)

    return {
        "topic": topic,
        "brief": brief,
        "papers": papers,
        "sources": sources[:20],
    }

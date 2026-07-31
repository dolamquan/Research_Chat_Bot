import re
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import HTTPException
from langsmith import traceable

from app.agents.state import AgentState
from app.mcp.bridge import call_mcp_tool
from app.rag.generator import generate_answer


URL_PATTERN = re.compile(r"https?://[^\s)>\]]+")
WORD_PATTERN = re.compile(r"[a-zA-Z][a-zA-Z0-9-]{2,}")


def _trace(tool: str, message: str, status: str = "success") -> Dict[str, Any]:
    return {
        "tool": tool,
        "status": status,
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@traceable(name="agent_small_talk_tool", run_type="tool")
def small_talk_tool(state: AgentState) -> Dict[str, Any]:
    return {
        "answer": (
            "Hi. I can search your indexed research library, discover new papers, "
            "add papers to the database, summarize papers, generate visualizations, "
            "save notes, export to Notion, or rebuild the topology graph. Type `/help` "
            "to see the available commands."
        ),
        "sources": [],
        "tool_trace": state.get("tool_trace", [])
        + [_trace("small_talk", "Answered without running a retrieval or crawler tool.")],
    }


def _extract_url(text: str) -> str | None:
    match = URL_PATTERN.search(text)
    if not match:
        return None

    return match.group(0).rstrip(".,;")


def _keywords(text: str) -> List[str]:
    stopwords = {
        "about",
        "add",
        "agent",
        "and",
        "are",
        "can",
        "compare",
        "database",
        "find",
        "for",
        "from",
        "give",
        "indexed",
        "into",
        "library",
        "paper",
        "papers",
        "research",
        "search",
        "show",
        "the",
        "this",
        "with",
    }
    terms = []
    for word in WORD_PATTERN.findall(text.lower()):
        if word in stopwords or word in terms:
            continue
        terms.append(word)
    return terms


def _clean_search_query(question: str) -> str:
    cleaned = re.sub(
        r"\b(search|find|discover|look for|papers?|recent|latest|about|related to|from|pubmed|arxiv|biorxiv|medrxiv|semantic scholar|crossref|openalex)\b",
        " ",
        question,
        flags=re.IGNORECASE,
    )
    cleaned = " ".join(cleaned.split())
    return cleaned or question


def _clean_reddit_query(question: str) -> str:
    cleaned = re.sub(
        r"\b(search|find|discover|look for|reddit|subreddit|posts?|threads?|discussions?|about|related to|from)\b",
        " ",
        question,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\br/[A-Za-z0-9_]+\b", " ", cleaned)
    cleaned = " ".join(cleaned.split())
    return cleaned or question


def _requested_subreddit(question: str) -> str | None:
    match = re.search(r"\br/([A-Za-z0-9_]+)\b", question)
    if match:
        return match.group(1)

    match = re.search(r"\bsubreddit\s+([A-Za-z0-9_]+)\b", question, flags=re.IGNORECASE)
    if match:
        return match.group(1)

    return None


def _requested_paper_sources(question: str) -> List[str]:
    lowered = question.lower()
    source_aliases = [
        ("arxiv", ["arxiv", "arxiv.org"]),
        ("pubmed", ["pubmed"]),
        ("biorxiv", ["biorxiv", "bio rxiv"]),
        ("medrxiv", ["medrxiv", "med rxiv"]),
        ("semantic_scholar", ["semantic scholar", "semanticscholar"]),
        ("crossref", ["crossref"]),
        ("openalex", ["openalex", "open alex"]),
    ]
    requested = [
        source
        for source, aliases in source_aliases
        if any(alias in lowered for alias in aliases)
    ]
    return requested or ["arxiv", "pubmed", "biorxiv", "medrxiv", "semantic_scholar"]


def _paper_identifier(paper: Dict[str, Any]) -> str:
    return str(
        paper.get("paper_id")
        or paper.get("arxiv_id")
        or paper.get("doi")
        or paper.get("url")
        or paper.get("title")
        or "paper"
    )


def _score_text(text: str, terms: List[str]) -> int:
    lowered = text.lower()
    return sum(1 for term in terms if term in lowered)


def _last_assistant_message(state: AgentState) -> str:
    for message in reversed(state.get("chat_history", [])):
        if message.get("role") == "assistant" and message.get("content"):
            return str(message["content"])
    return ""


def _context_title(state: AgentState, fallback: str) -> str:
    pinned_sources = state.get("pinned_sources", [])
    pinned = pinned_sources[0] if pinned_sources else {}
    title = pinned.get("title") or state.get("document_source") or fallback
    return str(title).strip()[:180] or fallback


def _context_body(state: AgentState) -> str:
    pinned_sources = state.get("pinned_sources", [])
    body_parts = []
    for source in pinned_sources[:3]:
        title = source.get("title") or source.get("source") or "Pinned context"
        text = source.get("text") or source.get("selected_text") or ""
        if text:
            body_parts.append(f"### {title}\n\n{text}")

    previous_answer = _last_assistant_message(state)
    if previous_answer:
        body_parts.append(f"### Recent assistant answer\n\n{previous_answer}")

    if not body_parts:
        body_parts.append(state["question"])

    return "\n\n".join(body_parts)


def _selected_document_source(state: AgentState) -> str:
    pinned_sources = state.get("pinned_sources", [])
    pinned = pinned_sources[0] if pinned_sources else {}
    return str(
        pinned.get("source")
        or state.get("document_source")
        or ""
    )


def _selected_article_id(state: AgentState) -> str:
    pinned_sources = state.get("pinned_sources", [])
    pinned = pinned_sources[0] if pinned_sources else {}
    return str(pinned.get("article_id") or "")


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
        "tool_trace": state.get("tool_trace", [])
        + [_trace("retrieve_papers", f"Retrieved {len(result['sources'])} grounded sources.")],
    }


@traceable(name="agent_search_arxiv_tool", run_type="tool")
def search_arxiv_tool(state: AgentState) -> Dict[str, Any]:
    return search_papers_tool({**state, "paper_sources": ["arxiv"]})


@traceable(name="agent_search_papers_tool", run_type="tool")
def search_papers_tool(state: AgentState) -> Dict[str, Any]:
    description = _clean_search_query(state["question"])
    sources = state.get("paper_sources") or _requested_paper_sources(state["question"])

    try:
        result = call_mcp_tool(
            "research.search_papers",
            {
                "description": description,
                "category": state.get("category"),
                "max_results": min(state.get("retrieval_limit", 10), 25),
                "sort_by": "relevance",
                "sources": sources,
            },
        )
    except HTTPException as exc:
        return {
            "answer": (
                "I tried to search external paper sources, but the paper search service did not respond. "
                "Please try again in a moment, or narrow the query with a source like arXiv or PubMed."
            ),
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("search_papers", str(exc.detail), "error")],
            "error": "paper_search_failed",
        }
    except Exception as exc:
        return {
            "answer": (
                "I tried to search external paper sources, but the paper search tool failed. "
                "Please try again with a shorter query or only select arXiv."
            ),
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("search_papers", str(exc), "error")],
            "error": "paper_search_failed",
        }

    papers = result["papers"]
    provider = result.get("provider") or "paper search"
    source_label = ", ".join(result.get("sources") or sources)

    lines = [
        f"I searched {source_label} for `{description}` and found {len(papers)} papers.",
    ]
    if result.get("warning"):
        lines.append(str(result["warning"]))

    for index, paper in enumerate(papers[:5], start=1):
        categories = ", ".join(paper.get("categories", [])[:3])
        identifier = _paper_identifier(paper)
        provider_label = paper.get("source_provider") or provider
        lines.append(
            f"{index}. **{paper['title']}** ({identifier})"
            + f" - {provider_label}"
            + (f" - {categories}" if categories else "")
            + f"\n   {paper.get('url') or paper.get('pdf_url') or ''}"
        )

    if papers:
        lines.append("\nAsk me to add a specific paper URL if you want it indexed.")

    sources = [
        {
            "id": _paper_identifier(paper),
            "title": paper["title"],
            "text": paper.get("abstract", ""),
            "source": paper.get("pdf_url", ""),
            "url": paper.get("url", ""),
            "topic": "paper_search",
            "provider": paper.get("source_provider") or provider,
            "categories": paper.get("categories", []),
        }
        for paper in papers[:8]
    ]

    return {
        "answer": "\n\n".join(lines),
        "sources": sources,
        "tool_trace": state.get("tool_trace", [])
        + [_trace("search_papers", f"Found {len(papers)} paper candidates via {provider}.")],
    }


@traceable(name="agent_search_library_tool", run_type="tool")
def search_library_tool(state: AgentState) -> Dict[str, Any]:
    result = call_mcp_tool(
        "research.search_library",
        {
            "query": state["question"],
            "domain": state.get("domain"),
            "category": state.get("category"),
            "limit": 8,
        },
    )
    matches = result["articles"]

    if not matches:
        return {
            "answer": "I could not find matching papers in your indexed library.",
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("search_library", "No indexed library matches found.")],
        }

    lines = [f"I found {len(matches)} relevant indexed papers in your library:"]
    for index, article in enumerate(matches[:5], start=1):
        label = article.get("category") or article.get("domain") or "indexed"
        lines.append(f"{index}. **{article['title']}** - {label}")

    sources = [
        {
            "id": article.get("article_id"),
            "article_id": article.get("article_id"),
            "title": article.get("title"),
            "text": article.get("abstract") or article.get("title"),
            "source": article.get("source"),
            "url": article.get("url"),
            "domain": article.get("domain"),
            "category": article.get("category"),
            "tags": article.get("tags", []),
        }
        for article in matches
    ]

    return {
        "answer": "\n\n".join(lines),
        "sources": sources,
        "tool_trace": state.get("tool_trace", [])
        + [_trace("search_library", f"Returned {len(matches)} indexed papers.")],
    }


@traceable(name="agent_search_reddit_tool", run_type="tool")
def search_reddit_tool(state: AgentState) -> Dict[str, Any]:
    query = _clean_reddit_query(state["question"])
    subreddit = _requested_subreddit(state["question"])

    try:
        result = call_mcp_tool(
            "reddit.search_posts",
            {
                "query": query,
                "subreddit": subreddit,
                "limit": min(state.get("retrieval_limit", 10), 10),
            },
        )
    except Exception as exc:
        return {
            "answer": (
                "I tried to search Reddit, but the Reddit MCP server is not ready yet. "
                "Make sure the Reddit Docker MCP image is available and your Reddit API "
                "credentials are configured in the backend `.env`."
            ),
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("search_reddit", str(exc), "error")],
            "error": "reddit_search_failed",
        }

    posts = result.get("posts", [])
    scope = f" in r/{subreddit}" if subreddit else ""
    lines = [f"I searched Reddit{scope} for `{query}` and found {len(posts)} posts."]

    for index, post in enumerate(posts[:5], start=1):
        subreddit_label = post.get("subreddit") or subreddit or "reddit"
        score = post.get("score")
        comments = post.get("num_comments")
        stats = []
        if score is not None:
            stats.append(f"score {score}")
        if comments is not None:
            stats.append(f"{comments} comments")
        stat_text = f" - {', '.join(stats)}" if stats else ""
        lines.append(
            f"{index}. **{post.get('title', 'Reddit post')}** - {subreddit_label}{stat_text}"
            + f"\n   {post.get('url', '')}"
        )

    sources = [
        {
            "id": post.get("id") or post.get("url"),
            "title": post.get("title"),
            "text": post.get("text") or post.get("title"),
            "source": post.get("url"),
            "url": post.get("url"),
            "topic": "reddit_search",
            "provider": "reddit",
            "subreddit": post.get("subreddit") or subreddit,
            "score": post.get("score"),
            "num_comments": post.get("num_comments"),
        }
        for post in posts[:8]
    ]

    return {
        "answer": "\n\n".join(lines),
        "sources": sources,
        "tool_trace": state.get("tool_trace", [])
        + [_trace("search_reddit", f"Found {len(posts)} Reddit posts.")],
    }


@traceable(name="agent_ingest_paper_tool", run_type="tool")
def ingest_paper_tool(state: AgentState) -> Dict[str, Any]:
    url = _extract_url(state["question"])

    if not url:
        return {
            "answer": "I can add a paper, but I need an arXiv or direct PDF URL.",
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("add_paper", "Missing arXiv or PDF URL.", "error")],
            "error": "missing_url",
        }

    result = call_mcp_tool(
        "research.add_paper",
        {
            "url": url,
            "domain": state.get("domain") or "research",
            "category": state.get("category") or "uncategorized",
            "tags": state.get("tags", []),
        },
    )
    article = result["article"]

    return {
        "answer": (
            f"Indexed **{article['title']}** in the local database. "
            "Rebuild the topology map when you want it to appear in the visual cluster view."
        ),
        "sources": [],
        "tool_trace": state.get("tool_trace", [])
        + [_trace("add_paper", f"Indexed {article['title']}.")],
    }


@traceable(name="agent_save_note_tool", run_type="tool")
def save_note_tool(state: AgentState) -> Dict[str, Any]:
    pinned_sources = state.get("pinned_sources", [])
    pinned = pinned_sources[0] if pinned_sources else {}
    source = pinned.get("source") or state.get("document_source")

    if not source:
        return {
            "answer": (
                "I can save notes, but I need a selected PDF passage or an open paper first. "
                "Use a PDF selection in chat, then ask me to save the note."
            ),
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("save_note", "No selected source was available.", "error")],
            "error": "missing_note_source",
        }

    selected_text = str(pinned.get("text") or pinned.get("selected_text") or state["question"])
    note_text = re.sub(
        r"^\s*(save|store|remember|create)\s+(this\s+)?(as\s+a\s+)?note[:\s-]*",
        "",
        state["question"],
        flags=re.IGNORECASE,
    ).strip()
    if not note_text:
        note_text = state["question"]

    result = call_mcp_tool(
        "research.save_note",
        {
            "source": str(source),
            "page": int(pinned.get("page") or 1),
            "selected_text": selected_text[:4000],
            "note": note_text,
            "article_id": str(pinned.get("article_id") or ""),
            "title": str(pinned.get("title") or ""),
        },
    )
    annotation = result["annotation"]

    return {
        "answer": f"Saved the note for **{annotation.get('title') or annotation['source']}**.",
        "sources": [
            {
                "id": f"annotation:{annotation['annotation_id']}",
                "source": annotation["source"],
                "page": annotation["page"],
                "text": annotation["selected_text"],
                "title": annotation.get("title") or annotation["source"],
                "selection": True,
            }
        ],
        "tool_trace": state.get("tool_trace", [])
        + [_trace("save_note", f"Saved note {annotation['annotation_id']}.")],
    }


@traceable(name="agent_rebuild_topology_tool", run_type="tool")
def rebuild_topology_tool(state: AgentState) -> Dict[str, Any]:
    result = call_mcp_tool(
        "research.rebuild_topology",
        {
            "domain": state.get("domain"),
            "category": state.get("category"),
        },
    )
    topology = result["topology"]

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
        "tool_trace": state.get("tool_trace", [])
        + [_trace("rebuild_topology", f"Rebuilt topology for {scope}.")],
    }


@traceable(name="agent_export_notion_tool", run_type="tool")
def export_notion_tool(state: AgentState) -> Dict[str, Any]:
    title = _context_title(state, "ResearchMind export")
    body = _context_body(state)
    pinned_sources = state.get("pinned_sources", [])
    source_url = ""
    if pinned_sources:
        source_url = str(pinned_sources[0].get("url") or pinned_sources[0].get("source") or "")

    try:
        result = call_mcp_tool(
            "notion.create_research_page",
            {
                "title": title,
                "summary": body,
                "source_url": source_url,
                "tags": ["researchmind", "research"],
            },
        )
    except Exception as exc:
        return {
            "answer": (
                "I could not export to Notion yet. Make sure `NOTION_API_KEY` "
                "and `NOTION_DATABASE_ID` are set in `backend/.env`, then restart the backend."
            ),
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("notion.create_research_page", str(exc), "error")],
            "error": "notion_export_failed",
        }

    return {
        "answer": f"Exported **{title}** to Notion: {result.get('url') or result.get('page_id')}",
        "sources": [],
        "tool_trace": state.get("tool_trace", [])
        + [_trace("notion.create_research_page", result.get("summary", "Created Notion page."))],
    }


@traceable(name="agent_create_github_issue_tool", run_type="tool")
def create_github_issue_tool(state: AgentState) -> Dict[str, Any]:
    title = re.sub(
        r"^\s*(create|open|make)\s+(a\s+)?(github\s+)?issue\s*(for|about)?\s*",
        "",
        state["question"],
        flags=re.IGNORECASE,
    ).strip()
    if not title:
        title = _context_title(state, "ResearchMind follow-up")

    body = _context_body(state)
    try:
        result = call_mcp_tool(
            "github.create_issue",
            {
                "title": title[:250],
                "body": body,
                "labels": ["researchmind"],
            },
        )
    except Exception as exc:
        return {
            "answer": (
                "I could not create the GitHub issue yet. Make sure `GITHUB_TOKEN` "
                "and `GITHUB_REPOSITORY` are set in `backend/.env`, then restart the backend."
            ),
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("github.create_issue", str(exc), "error")],
            "error": "github_issue_failed",
        }

    return {
        "answer": f"Created GitHub issue **#{result.get('issue_number')}**: {result.get('url')}",
        "sources": [],
        "tool_trace": state.get("tool_trace", [])
        + [_trace("github.create_issue", result.get("summary", "Created GitHub issue."))],
    }


@traceable(name="agent_search_github_tool", run_type="tool")
def search_github_tool(state: AgentState) -> Dict[str, Any]:
    query = re.sub(
        r"\b(search|find|github|repositories|repos|code|implementation|for|about)\b",
        " ",
        state["question"],
        flags=re.IGNORECASE,
    )
    query = " ".join(query.split()) or state["question"]
    try:
        result = call_mcp_tool(
            "github.search_repositories",
            {
                "query": query,
                "limit": 5,
            },
        )
    except Exception as exc:
        return {
            "answer": "I could not search GitHub right now. Please try again in a moment.",
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("github.search_repositories", str(exc), "error")],
            "error": "github_search_failed",
        }
    repositories = result["repositories"]

    lines = [f"I found {len(repositories)} GitHub repositories for `{query}`:"]
    for index, repo in enumerate(repositories, start=1):
        language = f" - {repo['language']}" if repo.get("language") else ""
        stars = f" - {repo['stars']} stars" if repo.get("stars") is not None else ""
        lines.append(
            f"{index}. **{repo['full_name']}**{language}{stars}\n"
            f"   {repo.get('description') or 'No description'}\n"
            f"   {repo['url']}"
        )

    return {
        "answer": "\n\n".join(lines),
        "sources": [
            {
                "id": repo["full_name"],
                "title": repo["full_name"],
                "text": repo.get("description") or "",
                "url": repo["url"],
                "topic": "github_repository",
            }
            for repo in repositories
        ],
        "tool_trace": state.get("tool_trace", [])
        + [_trace("github.search_repositories", result.get("summary", "Searched GitHub."))],
    }


@traceable(name="agent_summarize_paper_tool", run_type="tool")
def summarize_paper_tool(state: AgentState) -> Dict[str, Any]:
    try:
        result = call_mcp_tool(
            "research.summarize_paper",
            {
                "document_source": _selected_document_source(state),
                "article_id": _selected_article_id(state),
                "title": _context_title(state, ""),
                "query": state["question"],
                "domain": state.get("domain"),
                "category": state.get("category"),
                "chunk_limit": 80,
                "style": "structured",
            },
        )
    except Exception as exc:
        return {
            "answer": "I could not summarize the paper context yet. Select a paper, then try again.",
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("research.summarize_paper", str(exc), "error")],
            "error": "summarize_paper_failed",
        }

    return {
        "answer": result["summary_text"],
        "sources": result.get("sources", []),
        "tool_trace": state.get("tool_trace", [])
        + [_trace("research.summarize_paper", result.get("summary", "Summarized paper."))],
    }


@traceable(name="agent_generate_visualization_tool", run_type="tool")
def generate_visualization_tool(state: AgentState) -> Dict[str, Any]:
    lowered = state["question"].lower()
    visualization_type = "method_flow"
    if "concept" in lowered or "map" in lowered:
        visualization_type = "concept_map"
    elif "architecture" in lowered:
        visualization_type = "architecture"
    elif "timeline" in lowered:
        visualization_type = "timeline"
    elif "compare" in lowered or "comparison" in lowered:
        visualization_type = "comparison"

    try:
        result = call_mcp_tool(
            "research.generate_visualization",
            {
                "document_source": _selected_document_source(state),
                "article_id": _selected_article_id(state),
                "title": _context_title(state, ""),
                "query": state["question"],
                "domain": state.get("domain"),
                "category": state.get("category"),
                "chunk_limit": 80,
                "visualization_type": visualization_type,
            },
        )
    except Exception as exc:
        return {
            "answer": "I could not generate a visualization yet. Select a paper or provide a clearer topic.",
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("research.generate_visualization", str(exc), "error")],
            "error": "generate_visualization_failed",
        }

    answer = "\n\n".join(
        [
            f"Generated a Mermaid `{result['visualization_type']}` diagram for **{result['title']}**.",
            "```mermaid",
            result["mermaid"],
            "```",
            result["explanation"],
        ]
    )

    return {
        "answer": answer,
        "sources": result.get("sources", []),
        "tool_trace": state.get("tool_trace", [])
        + [_trace("research.generate_visualization", result.get("summary", "Generated visualization."))],
    }


@traceable(name="agent_export_visualization_notion_tool", run_type="tool")
def export_visualization_notion_tool(state: AgentState) -> Dict[str, Any]:
    lowered = state["question"].lower()
    visualization_type = "method_flow"
    if "concept" in lowered or "map" in lowered:
        visualization_type = "concept_map"
    elif "architecture" in lowered:
        visualization_type = "architecture"
    elif "timeline" in lowered:
        visualization_type = "timeline"
    elif "compare" in lowered or "comparison" in lowered:
        visualization_type = "comparison"

    try:
        visual = call_mcp_tool(
            "research.generate_visualization",
            {
                "document_source": _selected_document_source(state),
                "article_id": _selected_article_id(state),
                "title": _context_title(state, ""),
                "query": state["question"],
                "domain": state.get("domain"),
                "category": state.get("category"),
                "chunk_limit": 80,
                "visualization_type": visualization_type,
            },
        )
        source_url = ""
        sources = visual.get("sources", [])
        if sources:
            first_source = sources[0]
            source_url = str(first_source.get("url") or first_source.get("source") or "")

        notion = call_mcp_tool(
            "notion.create_visualization_page",
            {
                "title": f"Visualization: {visual['title']}",
                "mermaid": visual["mermaid"],
                "explanation": visual.get("explanation", ""),
                "source_url": source_url,
                "visualization_type": visual.get("visualization_type", visualization_type),
                "tags": ["researchmind", "visualization"],
            },
        )
    except Exception as exc:
        return {
            "answer": (
                "I could not export the visualization to Notion yet. Make sure your Notion "
                "API key, database ID, and database connection are configured, then try again."
            ),
            "sources": [],
            "tool_trace": state.get("tool_trace", [])
            + [_trace("notion.create_visualization_page", str(exc), "error")],
            "error": "notion_visualization_export_failed",
        }

    answer = "\n\n".join(
        [
            f"Exported a Mermaid `{visual['visualization_type']}` diagram for **{visual['title']}** to Notion:",
            str(notion.get("url") or notion.get("page_id")),
            "```mermaid",
            visual["mermaid"],
            "```",
            visual.get("explanation", ""),
        ]
    )

    return {
        "answer": answer,
        "sources": visual.get("sources", []),
        "tool_trace": state.get("tool_trace", [])
        + [
            _trace("research.generate_visualization", visual.get("summary", "Generated visualization.")),
            _trace("notion.create_visualization_page", notion.get("summary", "Created Notion visualization page.")),
        ],
    }

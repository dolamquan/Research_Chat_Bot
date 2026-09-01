import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List

from fastapi import HTTPException
import requests

from app.ingestion.url_ingester import ingest_article_url
from app.integrations import notion as notion_api
from app.integrations.reddit_mcp import list_reddit_tools, search_reddit_posts
from app.rag import notes_index
from app.rag.clusterer import build_cluster_graph
from app.rag.graph_rag import build_graph_rag, query_graph_rag
from app.rag.research_tools import generate_visualization, summarize_paper
from app.routes.crawler import ArxivSearchRequest, PaperSearchRequest, search_arxiv, search_multi_source
from app.storage import notes as notes_store
from app.storage.article_store import list_articles


MCP_SERVER_NAME = "zoetrope.internal"


@dataclass(frozen=True)
class McpTool:
    name: str
    description: str
    input_schema: Dict[str, Any]
    handler: Callable[[Dict[str, Any]], Dict[str, Any]]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _string(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _string_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [
        item.strip()
        for item in str(value).split(",")
        if item.strip()
    ]


def _tool_result(tool: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "server": MCP_SERVER_NAME,
        "tool": tool,
        "called_at": _now(),
        **payload,
    }


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def _require_env(name: str) -> str:
    value = _env(name)
    if not value:
        raise ValueError(f"{name} is not configured")
    return value


def _request_json(
    method: str,
    url: str,
    *,
    headers: Dict[str, str] | None = None,
    json_body: Dict[str, Any] | None = None,
    timeout: int = 30,
) -> Dict[str, Any]:
    response = requests.request(
        method,
        url,
        headers=headers,
        json=json_body,
        timeout=timeout,
    )
    if response.status_code >= 400:
        detail = response.text[:800]
        raise RuntimeError(f"{response.status_code} response from {url}: {detail}")
    if not response.content:
        return {}
    return response.json()


def _notion_create_research_page(args: Dict[str, Any]) -> Dict[str, Any]:
    result = notion_api.create_research_page(args)
    verb = "Updated" if result.get("updated") else "Created"
    return _tool_result(
        "notion.create_research_page",
        {
            "page_id": result.get("page_id"),
            "url": result.get("url"),
            "title": result.get("title"),
            "warnings": result.get("warnings", []),
            "summary": f"{verb} Notion page for {result.get('title')}.",
        },
    )


def _notion_create_visualization_page(args: Dict[str, Any]) -> Dict[str, Any]:
    result = notion_api.create_visualization_page(args)
    verb = "Updated" if result.get("updated") else "Created"
    return _tool_result(
        "notion.create_visualization_page",
        {
            "page_id": result.get("page_id"),
            "url": result.get("url"),
            "title": result.get("title"),
            "diagram_format": "mermaid",
            "summary": f"{verb} Notion visualization page for {result.get('title')}.",
        },
    )


def _github_headers() -> Dict[str, str]:
    token = _require_env("GITHUB_TOKEN")
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _github_repo(args: Dict[str, Any]) -> str:
    repo = _string(args.get("repo") or _env("GITHUB_REPOSITORY")).strip()
    if not repo:
        raise ValueError("repo is required or GITHUB_REPOSITORY must be configured")
    if "/" not in repo:
        raise ValueError("repo must look like owner/repository")
    return repo


def _github_create_issue(args: Dict[str, Any]) -> Dict[str, Any]:
    repo = _github_repo(args)
    title = _string(args.get("title")).strip()
    body = _string(args.get("body") or args.get("summary")).strip()
    labels = _string_list(args.get("labels"))
    if not title:
        raise ValueError("title is required")

    issue = _request_json(
        "POST",
        f"https://api.github.com/repos/{repo}/issues",
        headers=_github_headers(),
        json_body={
            "title": title,
            "body": body or "Created from Zoetrope.",
            "labels": labels,
        },
    )

    return _tool_result(
        "github.create_issue",
        {
            "repo": repo,
            "issue_number": issue.get("number"),
            "url": issue.get("html_url"),
            "title": issue.get("title", title),
            "summary": f"Created GitHub issue #{issue.get('number')} in {repo}.",
        },
    )


def _github_search_repositories(args: Dict[str, Any]) -> Dict[str, Any]:
    query = _string(args.get("query")).strip()
    if not query:
        raise ValueError("query is required")
    limit = min(int(args.get("limit") or 5), 10)

    headers = {"Accept": "application/vnd.github+json"}
    if _env("GITHUB_TOKEN"):
        headers = _github_headers()

    result = requests.get(
        "https://api.github.com/search/repositories",
        headers=headers,
        params={"q": query, "per_page": limit},
        timeout=30,
    )
    if result.status_code >= 400:
        raise RuntimeError(f"{result.status_code} response from GitHub: {result.text[:800]}")
    data = result.json()
    repositories = [
        {
            "full_name": item.get("full_name"),
            "description": item.get("description"),
            "url": item.get("html_url"),
            "stars": item.get("stargazers_count"),
            "language": item.get("language"),
        }
        for item in data.get("items", [])[:limit]
    ]

    return _tool_result(
        "github.search_repositories",
        {
            "repositories": repositories,
            "summary": f"Found {len(repositories)} GitHub repositories.",
        },
    )


def _search_arxiv(args: Dict[str, Any]) -> Dict[str, Any]:
    description = _string(args.get("description") or args.get("query")).strip()
    if not description:
        raise ValueError("description is required")

    result = search_arxiv(
        ArxivSearchRequest(
            description=description,
            category=_string(args.get("category") or "").strip() or None,
            sort_by=_string(args.get("sort_by"), "relevance"),
            max_results=int(args.get("max_results") or 10),
        )
    )
    return _tool_result(
        "research.search_arxiv",
        {
            "query": result["query"],
            "papers": result["papers"],
            "summary": f"Found {len(result['papers'])} arXiv papers.",
        },
    )


def _search_papers(args: Dict[str, Any]) -> Dict[str, Any]:
    description = _string(args.get("description") or args.get("query")).strip()
    if not description:
        raise ValueError("description is required")

    result = search_multi_source(
        PaperSearchRequest(
            description=description,
            category=_string(args.get("category") or "").strip() or None,
            sort_by=_string(args.get("sort_by"), "relevance"),
            max_results=int(args.get("max_results") or 10),
            sources=_string_list(args.get("sources")) or ["arxiv", "pubmed", "biorxiv", "medrxiv", "semantic_scholar"],
        )
    )
    return _tool_result(
        "research.search_papers",
        {
            "provider": result.get("provider"),
            "query": result["query"],
            "sources": result.get("sources", []),
            "papers": result["papers"],
            "warning": result.get("warning", ""),
            "summary": f"Found {len(result['papers'])} papers from {result.get('provider', 'paper search')}.",
        },
    )


def _search_library(args: Dict[str, Any]) -> Dict[str, Any]:
    query = _string(args.get("query") or "").lower()
    articles = list_articles(
        domain=_string(args.get("domain") or "").strip() or None,
        category=_string(args.get("category") or "").strip() or None,
        limit=int(args.get("limit") or 25),
    )

    if query:
        terms = [term for term in query.split() if len(term) > 2]
        scored = []
        for article in articles:
            text = " ".join(
                [
                    article.get("title", ""),
                    article.get("abstract", "") or "",
                    article.get("domain", ""),
                    article.get("category", ""),
                    " ".join(article.get("tags", [])),
                ]
            ).lower()
            score = sum(1 for term in terms if term in text)
            if score:
                scored.append((score, article))
        scored.sort(key=lambda item: item[0], reverse=True)
        articles = [article for _, article in scored]

    return _tool_result(
        "research.search_library",
        {
            "articles": articles,
            "summary": f"Returned {len(articles)} indexed papers.",
        },
    )


def _reddit_list_tools(args: Dict[str, Any]) -> Dict[str, Any]:
    tools = list_reddit_tools()
    return _tool_result(
        "reddit.list_tools",
        {
            "tools": tools,
            "summary": f"Loaded {len(tools)} Reddit MCP tools.",
        },
    )


def _reddit_search_posts(args: Dict[str, Any]) -> Dict[str, Any]:
    query = _string(args.get("query") or args.get("description")).strip()
    if not query:
        raise ValueError("query is required")

    result = search_reddit_posts(
        query=query,
        subreddit=_string(args.get("subreddit") or "").strip() or None,
        limit=int(args.get("limit") or 10),
    )
    return _tool_result(
        "reddit.search_posts",
        {
            **result,
            "summary": f"Found {len(result['posts'])} Reddit posts.",
        },
    )


def _add_paper(args: Dict[str, Any]) -> Dict[str, Any]:
    url = _string(args.get("url")).strip()
    if not url:
        raise ValueError("url is required")

    result = ingest_article_url(
        url=url,
        title=_string(args.get("title") or "").strip() or None,
        domain=_string(args.get("domain"), "research").strip() or "research",
        category=_string(args.get("category"), "uncategorized").strip()
        or "uncategorized",
        tags=_string_list(args.get("tags")),
    )
    article = result["article"]
    return _tool_result(
        "research.add_paper",
        {
            "article": article,
            "pdf_url": result.get("pdf_url"),
            "summary": f"Indexed {article['title']}.",
        },
    )


def _save_note(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _string(args.get("source")).strip()
    selected_text = _string(args.get("selected_text")).strip()
    note = _string(args.get("note")).strip()
    if not source:
        raise ValueError("source is required")
    if not selected_text:
        raise ValueError("selected_text is required")

    note_type = _string(args.get("note_type"), "highlight").strip() or "highlight"
    source_type = "pdf" if source.lower().endswith(".pdf") else _string(
        args.get("source_type"), "chat_session"
    )
    saved = notes_store.create_note(
        note_type=note_type if note_type in notes_store.NOTE_TYPES else "highlight",
        source_type=source_type,
        source_ref=source,
        source_title=_string(args.get("title")),
        article_id=_string(args.get("article_id")),
        page=int(args.get("page") or 1),
        selected_text=selected_text,
        title=_string(args.get("title")),
        body_md=note,
        tags=_string_list(args.get("tags")),
    )
    notes_index.index_note_safe(saved)

    # Historic annotation shape, kept for existing agent/console consumers.
    annotation = {
        "annotation_id": saved["note_id"],
        "source": saved["source_ref"],
        "article_id": saved.get("article_id") or "",
        "title": saved.get("source_title") or "",
        "page": saved.get("page") or 1,
        "selected_text": saved.get("selected_text", ""),
        "note": saved.get("body_md", ""),
        "created_at": saved["created_at"],
        "updated_at": saved["updated_at"],
    }
    return _tool_result(
        "research.save_note",
        {
            "annotation": annotation,
            "note": saved,
            "summary": f"Saved note {saved['note_id']}.",
        },
    )


def _search_notes(args: Dict[str, Any]) -> Dict[str, Any]:
    query = _string(args.get("query")).strip()
    if not query:
        raise ValueError("query is required")

    hits = notes_index.search_notes(query, limit=int(args.get("limit") or 8))
    return _tool_result(
        "research.search_notes",
        {
            "results": hits,
            "summary": f"Found {len(hits)} matching notes.",
        },
    )


def _rebuild_topology(args: Dict[str, Any]) -> Dict[str, Any]:
    topology = build_cluster_graph(
        domain=_string(args.get("domain") or "").strip() or None,
        category=_string(args.get("category") or "").strip() or None,
        cluster_count=args.get("cluster_count"),
    )
    return _tool_result(
        "research.rebuild_topology",
        {
            "topology": topology,
            "summary": "Rebuilt topology.",
        },
    )


def _build_graph_rag(args: Dict[str, Any]) -> Dict[str, Any]:
    graph = build_graph_rag(
        domain=_string(args.get("domain") or "").strip() or None,
        category=_string(args.get("category") or "").strip() or None,
        concept_limit=int(args.get("concept_limit") or 12),
        similarity_threshold=int(args.get("similarity_threshold") or 2),
    )
    return _tool_result(
        "research.build_graph_rag",
        {
            "graph": graph,
            "summary": (
                f"Built Graph RAG with {graph['stats']['paper_count']} papers, "
                f"{graph['stats']['concept_count']} concepts, and "
                f"{graph['stats']['edge_count']} edges."
            ),
        },
    )


def _query_graph_rag(args: Dict[str, Any]) -> Dict[str, Any]:
    query = _string(args.get("query")).strip()
    if not query:
        raise ValueError("query is required")
    result = query_graph_rag(
        query=query,
        domain=_string(args.get("domain") or "").strip() or None,
        category=_string(args.get("category") or "").strip() or None,
        limit=int(args.get("limit") or 8),
    )
    return _tool_result(
        "research.query_graph_rag",
        {
            **result,
            "summary": result["answer"],
        },
    )


def _summarize_paper(args: Dict[str, Any]) -> Dict[str, Any]:
    result = summarize_paper(args)
    return _tool_result(
        "research.summarize_paper",
        {
            **result,
            "summary": f"Summarized {result['title']}.",
        },
    )


def _generate_visualization(args: Dict[str, Any]) -> Dict[str, Any]:
    result = generate_visualization(args)
    return _tool_result(
        "research.generate_visualization",
        {
            **result,
            "summary": f"Generated {result['diagram_format']} visualization for {result['title']}.",
        },
    )


TOOLS: Dict[str, McpTool] = {
    "research.search_papers": McpTool(
        name="research.search_papers",
        description="Search multiple external academic sources through Paper Search MCP/CLI.",
        input_schema={
            "type": "object",
            "required": ["description"],
            "properties": {
                "description": {"type": "string"},
                "sources": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Sources such as arxiv, pubmed, biorxiv, medrxiv, semantic_scholar, crossref, openalex.",
                },
                "category": {"type": "string", "description": "Optional source category/filter."},
                "sort_by": {"type": "string", "enum": ["relevance", "newest", "last_updated"]},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 25},
            },
        },
        handler=_search_papers,
    ),
    "research.search_arxiv": McpTool(
        name="research.search_arxiv",
        description="Search arXiv for new external research papers.",
        input_schema={
            "type": "object",
            "required": ["description"],
            "properties": {
                "description": {"type": "string"},
                "category": {"type": "string", "description": "Optional arXiv category, e.g. cs.CL."},
                "sort_by": {"type": "string", "enum": ["relevance", "newest", "last_updated"]},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 25},
            },
        },
        handler=_search_arxiv,
    ),
    "research.search_library": McpTool(
        name="research.search_library",
        description="Search papers already indexed in the local research library.",
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "domain": {"type": "string"},
                "category": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 250},
            },
        },
        handler=_search_library,
    ),
    "reddit.list_tools": McpTool(
        name="reddit.list_tools",
        description="List read-only tools exposed by the configured Reddit MCP Docker server.",
        input_schema={
            "type": "object",
            "properties": {},
        },
        handler=_reddit_list_tools,
    ),
    "reddit.search_posts": McpTool(
        name="reddit.search_posts",
        description="Search Reddit posts/discussions for external practitioner context.",
        input_schema={
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "subreddit": {"type": "string", "description": "Optional subreddit name, with or without r/."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            },
        },
        handler=_reddit_search_posts,
    ),
    "research.add_paper": McpTool(
        name="research.add_paper",
        description="Index an arXiv or PDF URL into the local database.",
        input_schema={
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": {"type": "string"},
                "title": {"type": "string"},
                "domain": {"type": "string"},
                "category": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
        },
        handler=_add_paper,
    ),
    "research.save_note": McpTool(
        name="research.save_note",
        description="Save a note attached to a PDF passage, chat answer, or research context.",
        input_schema={
            "type": "object",
            "required": ["source", "selected_text"],
            "properties": {
                "source": {"type": "string"},
                "page": {"type": "integer", "minimum": 1},
                "selected_text": {"type": "string"},
                "note": {"type": "string"},
                "article_id": {"type": "string"},
                "title": {"type": "string"},
                "note_type": {
                    "type": "string",
                    "enum": ["highlight", "freeform", "chat_capture", "visualization"],
                },
                "tags": {"type": "array", "items": {"type": "string"}},
            },
        },
        handler=_save_note,
    ),
    "research.search_notes": McpTool(
        name="research.search_notes",
        description="Semantically search the user's own saved notes and highlights.",
        input_schema={
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            },
        },
        handler=_search_notes,
    ),
    "research.rebuild_topology": McpTool(
        name="research.rebuild_topology",
        description="Rebuild the paper topology map from indexed papers.",
        input_schema={
            "type": "object",
            "properties": {
                "domain": {"type": "string"},
                "category": {"type": "string"},
                "cluster_count": {"type": "integer", "minimum": 1, "maximum": 50},
            },
        },
        handler=_rebuild_topology,
    ),
    "research.build_graph_rag": McpTool(
        name="research.build_graph_rag",
        description="Build a local concept graph over indexed papers for Graph RAG.",
        input_schema={
            "type": "object",
            "properties": {
                "domain": {"type": "string"},
                "category": {"type": "string"},
                "concept_limit": {"type": "integer", "minimum": 4, "maximum": 24},
                "similarity_threshold": {"type": "integer", "minimum": 1, "maximum": 8},
            },
        },
        handler=_build_graph_rag,
    ),
    "research.query_graph_rag": McpTool(
        name="research.query_graph_rag",
        description="Query the local paper/concept graph and return connected papers and concepts.",
        input_schema={
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "domain": {"type": "string"},
                "category": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            },
        },
        handler=_query_graph_rag,
    ),
    "research.summarize_paper": McpTool(
        name="research.summarize_paper",
        description="Summarize a selected/indexed paper using its retrieved document chunks.",
        input_schema={
            "type": "object",
            "properties": {
                "document_source": {"type": "string"},
                "article_id": {"type": "string"},
                "title": {"type": "string"},
                "query": {"type": "string", "description": "Fallback topic query if no paper is selected."},
                "domain": {"type": "string"},
                "category": {"type": "string"},
                "chunk_limit": {"type": "integer", "minimum": 1, "maximum": 120},
                "style": {"type": "string", "description": "structured, short, detailed, literature-review, etc."},
            },
        },
        handler=_summarize_paper,
    ),
    "research.generate_visualization": McpTool(
        name="research.generate_visualization",
        description="Generate a Mermaid diagram from a selected paper or research topic.",
        input_schema={
            "type": "object",
            "properties": {
                "document_source": {"type": "string"},
                "article_id": {"type": "string"},
                "title": {"type": "string"},
                "query": {"type": "string", "description": "Fallback topic query if no paper is selected."},
                "domain": {"type": "string"},
                "category": {"type": "string"},
                "chunk_limit": {"type": "integer", "minimum": 1, "maximum": 120},
                "visualization_type": {
                    "type": "string",
                    "description": "method_flow, concept_map, comparison, architecture, timeline, etc.",
                },
            },
        },
        handler=_generate_visualization,
    ),
    "notion.create_research_page": McpTool(
        name="notion.create_research_page",
        description="Create a Notion database page from a paper, note, or agent summary.",
        input_schema={
            "type": "object",
            "required": ["title"],
            "properties": {
                "database_id": {"type": "string", "description": "Optional override for NOTION_DATABASE_ID."},
                "title": {"type": "string"},
                "summary": {"type": "string"},
                "source_url": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
        },
        handler=_notion_create_research_page,
    ),
    "notion.create_visualization_page": McpTool(
        name="notion.create_visualization_page",
        description="Create a Notion database page containing a Mermaid visualization and explanation.",
        input_schema={
            "type": "object",
            "required": ["title", "mermaid"],
            "properties": {
                "database_id": {"type": "string", "description": "Optional override for NOTION_DATABASE_ID."},
                "title": {"type": "string"},
                "mermaid": {"type": "string"},
                "explanation": {"type": "string"},
                "source_url": {"type": "string"},
                "visualization_type": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
        },
        handler=_notion_create_visualization_page,
    ),
    "github.create_issue": McpTool(
        name="github.create_issue",
        description="Create a GitHub issue for a research task, bug, or follow-up idea.",
        input_schema={
            "type": "object",
            "required": ["title"],
            "properties": {
                "repo": {"type": "string", "description": "owner/repo, optional if GITHUB_REPOSITORY is configured."},
                "title": {"type": "string"},
                "body": {"type": "string"},
                "labels": {"type": "array", "items": {"type": "string"}},
            },
        },
        handler=_github_create_issue,
    ),
    "github.search_repositories": McpTool(
        name="github.search_repositories",
        description="Search public GitHub repositories related to a research implementation topic.",
        input_schema={
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 10},
            },
        },
        handler=_github_search_repositories,
    ),
}


def list_mcp_tools() -> List[Dict[str, Any]]:
    return [
        {
            "server": MCP_SERVER_NAME,
            "name": tool.name,
            "description": tool.description,
            "input_schema": tool.input_schema,
        }
        for tool in TOOLS.values()
    ]


def call_mcp_tool(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    tool = TOOLS.get(tool_name)
    if tool is None:
        raise KeyError(f"Unknown MCP tool: {tool_name}")

    try:
        return tool.handler(arguments)
    except HTTPException:
        raise
    except Exception as exc:
        raise RuntimeError(f"MCP tool {tool_name} failed: {exc}") from exc

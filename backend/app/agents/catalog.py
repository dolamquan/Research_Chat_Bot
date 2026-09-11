"""The Agent's catalog is derived from the running app, not a second API list.

Every FastAPI route, every MCP bridge tool and a few agent-only helpers become
one uniformly shaped tool record. Calls go through the same ASGI routes,
Pydantic validation and services as the UI, so a feature added anywhere in the
application is available to the agent without touching this module.

Discovery is cheap; full schemas and results are fetched only when requested.
"""
import asyncio
import base64
import json
import os
import re
from collections import Counter
from typing import Any
from urllib.parse import quote, urlencode

import httpx
from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.routing import APIRoute
from jsonschema import Draft202012Validator

from app.auth.context import request_token

_application: FastAPI | None = None
_api_tools_cache: list[dict] | None = None

# These endpoints are plumbing, not separate application capabilities. Their
# replacements are explicit so a newly added feature cannot silently disappear.
EXCLUDED = {
    ("POST", "/agent/chat"): "The agent itself; recursive agent calls are disabled.",
    ("GET", "/agent/tools"): "Available through discover_tools and describe_tool.",
    ("GET", "/agent/tools/{name}"): "Available through describe_tool.",
    ("POST", "/agent/tools/call"): "Available through execute_tool.",
    ("GET", "/agent/context"): "Available through app.context.",
    ("GET", "/mcp/tools"): "Every MCP tool is included individually in this catalog.",
    ("POST", "/mcp/call"): "Every MCP tool is callable individually through execute_tool.",
    ("GET", "/auth/config"): "Sign-in plumbing; the agent already runs as the signed-in user.",
    ("GET", "/auth/me"): "Sign-in plumbing; the current user is part of app.context's workspace.",
    ("PUT", "/integrations/{provider}"): "Credentials never pass through the model; users add them in the Notes view.",
    ("DELETE", "/integrations/{provider}"): "Credentials are managed by the user in the Notes view.",
    ("GET", "/integrations/notion/authorize"): "Browser-only sign-in step; the user connects Notion from the Notes view.",
    ("GET", "/integrations/notion/callback"): "Notion's OAuth redirect target; not callable as a tool.",
}

APP_GUIDE = {
    "Chat": "Grounded paper Q&A over the indexed library, retrieval modes, pinned passages and saved chat sessions.",
    "Paper Library": "Indexed papers, metadata, full document text, PDFs, highlights and extracted figures.",
    "Notes": "Saved notes, Markdown, highlights, LaTeX, folders, image/sketch attachments and Notion targets/export. Editable sketches render to PNG in the browser.",
    "Crawler": "Discover academic papers across arXiv, PubMed, bioRxiv, medRxiv, Semantic Scholar, Crossref and OpenAlex; ingest URLs and inspect ingestion jobs.",
    "Topology": "Paper clusters, cluster documents and topology rebuilding.",
    "Graph RAG": "Concept graph retrieval, neighbors, paths and graph rebuilding.",
    "Visualizer": "Saved 2D/3D paper diagrams, node explanations, dynamic scenes, stage scenes, scene verification and providers. Prepare all means preparing every node explanation and stage scene; inspect readiness first and reuse saved scenes.",
    "Variants": "Propose/apply modifications to a paper's method diagram, saved variants, verification findings and discussion history.",
    "Evaluation": "Single, batch and RAGAS evaluation plus saved runs and metrics.",
    "Integrations": "MCP bridge tools, Notion publishing, GitHub issues/search and Reddit search. Configuration status is not a connectivity guarantee.",
}

# Words in an MCP tool name that mark it as changing application state.
_MCP_WRITE_WORDS = ("save", "ingest", "build", "add", "create", "rebuild", "update", "delete")


def configure_application_tools(application: FastAPI) -> None:
    global _application, _api_tools_cache
    _application = application
    _api_tools_cache = None


def _app() -> FastAPI:
    if _application is None:
        raise RuntimeError("Application tools have not been initialized")
    return _application


def _effect(method: str, path: str) -> str:
    if method == "DELETE":
        return "destructive"
    if "export-notion" in path:
        return "external_write"
    if method == "GET" or path.endswith(("/search", "/query", "/neighbors", "/path")):
        return "read"
    return "write"


def _humanize(name: str) -> str:
    words = name.replace("_endpoint", "").replace("_", " ").strip()
    return words[:1].upper() + words[1:]


def _with_definitions(schema: dict, definitions: dict) -> dict:
    """Attach only transitive schema references used by this operation."""
    used = {}

    def visit(value):
        if isinstance(value, dict):
            ref = value.get("$ref", "")
            if ref.startswith("#/components/schemas/"):
                name = ref.rsplit("/", 1)[-1]
                if name not in used:
                    used[name] = definitions[name]
                    visit(used[name])
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(schema)
    return {**schema, **({"components": {"schemas": used}} if used else {})}


def _operation_schema(operation: dict, definitions: dict) -> dict:
    groups, required = {}, []
    for location in ("path", "query"):
        params = [p for p in operation.get("parameters", []) if p["in"] == location]
        if params:
            fields = {p["name"]: p["schema"] for p in params}
            mandatory = [p["name"] for p in params if p.get("required")]
            groups[location] = {"type": "object", "properties": fields, "additionalProperties": False}
            if mandatory:
                groups[location]["required"] = mandatory
                required.append(location)
    content = operation.get("requestBody", {}).get("content", {})
    if content:
        if "multipart/form-data" in content:
            # Bytes never go into model context. A browser upload action
            # supplies a user-selected file; direct clients may use base64.
            groups["form"] = {"type": "object", "additionalProperties": {"type": "string"}}
            groups["file"] = {"type": "object", "properties": {
                "name": {"type": "string"}, "mime_type": {"type": "string"}, "data_base64": {"type": "string"},
            }, "required": ["name", "mime_type", "data_base64"], "additionalProperties": False}
            required.append("file")
        else:
            groups["body"] = content.get("application/json", next(iter(content.values()))).get("schema", {})
            if operation["requestBody"].get("required"):
                required.append("body")
    schema = {"type": "object", "properties": groups, "additionalProperties": False, "required": required}
    return _with_definitions(schema, definitions)


def _api_tools() -> list[dict]:
    """One tool per route, named api.<area>.<function> so a model can read it."""
    global _api_tools_cache
    if _api_tools_cache is not None:
        return _api_tools_cache
    application = _app()
    spec = get_openapi(title=application.title, version=application.version, routes=application.routes)
    definitions = spec.get("components", {}).get("schemas", {})
    tools, names = [], set()
    for route in application.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(route.methods or []):
            if method not in {"GET", "POST", "PATCH", "PUT", "DELETE"} or (method, route.path) in EXCLUDED:
                continue
            operation = spec["paths"].get(route.path_format, {}).get(method.lower())
            if operation is None:
                continue
            area = route.tags[0] if route.tags else (route.path.strip("/").split("/")[0] or "root")
            name = f"api.{area}.{route.name}"
            if name in names:
                name = f"{name}_{method.lower()}"
            names.add(name)
            summary = (route.summary or route.description or "").strip().splitlines()
            description = summary[0].strip() if summary else _humanize(route.name)
            tools.append({
                "name": name, "category": str(area),
                "description": f"{description} [{method} {route.path}]",
                "method": method, "path": route.path, "effect": _effect(method, route.path),
                "execution": "api", "available": route.path != "/upload",
                "unavailable_reason": "PDF upload is disabled by the application; use URL ingestion." if route.path == "/upload" else "",
                "input_schema": _operation_schema(operation, definitions),
            })
    _api_tools_cache = tools
    return tools


def _mcp_effect(name: str) -> str:
    if name.startswith("notion.") or name == "github.create_issue":
        return "external_write"
    if any(word in name for word in _MCP_WRITE_WORDS):
        return "write"
    return "read"


def tool_catalog() -> list[dict]:
    from app.mcp.bridge import list_mcp_tools
    from app.storage.integrations import get_secret
    tools = list(_api_tools())
    for tool in list_mcp_tools():
        name = tool["name"]
        configured = True
        if name.startswith("notion."):
            configured = bool(get_secret("notion"))
        elif name == "github.create_issue":
            configured = bool(get_secret("github"))
        tools.append({**tool, "category": name.split(".")[0], "execution": "mcp",
                      "effect": _mcp_effect(name),
                      "available": configured, "unavailable_reason": "Integration credentials are not configured." if not configured else ""})
    tools.extend([
        {"name": "app.context", "category": "application", "description": "Live application guide, tool counts, integration configuration, paper counts and selected workspace context.", "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
        {"name": "app.papers", "category": "application", "description": "Search or page through ALL library papers, including imported manifest papers. Returns actual IDs and sources. An empty query lists papers; total and next_offset indicate remaining results.", "input_schema": {"type": "object", "properties": {
            "query": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            "domain": {"type": "string"}, "category": {"type": "string"},
        }, "additionalProperties": False}},
    ])
    for tool in tools:
        tool.setdefault("execution", "builtin")
        tool.setdefault("effect", "read")
        tool.setdefault("available", True)
        tool.setdefault("unavailable_reason", "")
    return tools


def catalog_index(tools: list[dict] | None = None) -> str:
    """A compact, category-grouped listing for a model's system prompt."""
    tools = tools if tools is not None else tool_catalog()
    grouped: dict[str, list[dict]] = {}
    for tool in tools:
        grouped.setdefault(tool["category"], []).append(tool)
    lines = []
    for category in sorted(grouped):
        lines.append(f"## {category}")
        for tool in grouped[category]:
            flags = [tool["effect"]] if tool["effect"] != "read" else []
            if not tool["available"]:
                flags.append("unavailable")
            suffix = f" ({', '.join(flags)})" if flags else ""
            lines.append(f"- {tool['name']}{suffix}: {tool['description']}")
    return "\n".join(lines)


def discover_tools(query: str = "", category: str = "", offset: int = 0, limit: int = 30) -> dict:
    all_tools = tool_catalog()
    terms = re.findall(r"[\w-]+", query.lower())
    matches = [t for t in all_tools if (not category or t["category"] == category)
               and (not terms or any(term in (t["name"] + " " + t["description"] + " " + t["category"]).lower() for term in terms))]
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    return {"total": len(matches), "categories": dict(Counter(t["category"] for t in all_tools)),
            "tools": [{k: v for k, v in t.items() if k != "input_schema"} for t in matches[offset:offset + limit]],
            "next_offset": offset + limit if offset + limit < len(matches) else None}


def describe_tool(name: str) -> dict:
    for tool in tool_catalog():
        if tool["name"] == name:
            return tool
    raise ValueError(f"Unknown application tool: {name}. Use discover_tools first.")


def library_papers(query: str = "", offset: int = 0, limit: int = 30, domain: str = "", category: str = "") -> dict:
    from app.storage.article_store import list_articles
    # SQLite LIMIT -1 is unbounded. The store explicitly supports it so the
    # combined database/manifest list is not silently truncated.
    papers = list_articles(domain=domain or None, category=category or None, limit=-1)
    terms = query.lower().split()
    matches = [p for p in papers if all(term in " ".join(str(p.get(k) or "") for k in ("title", "source", "article_id", "abstract", "tags")).lower() for term in terms)]
    return {"total": len(matches), "offset": offset,
            "papers": [{k: p.get(k) for k in ("article_id", "title", "source", "url", "domain", "category", "status", "tags")} for p in matches[offset:offset + limit]],
            "next_offset": offset + limit if offset + limit < len(matches) else None}


def application_context(workspace: dict | None = None) -> dict:
    from app.storage.article_store import list_domains
    from app.storage.notes import list_notion_targets
    domains = list_domains()
    tools = tool_catalog()
    return {"application": "Zoetrope", "guide": APP_GUIDE,
            "paper_count": sum(d["article_count"] for d in domains), "domains": domains,
            "tool_count": len(tools), "tool_categories": dict(Counter(t["category"] for t in tools)),
            "notion_targets": [{k: t.get(k) for k in ("target_id", "name", "database_id")} for t in list_notion_targets()],
            "unavailable_tools": [{"name": t["name"], "reason": t.get("unavailable_reason")} for t in tools if not t["available"]],
            "workspace": workspace or {}, "paper_lookup": "Use app.papers for current titles, identifiers and pagination. Counts above cover the whole app; workspace scope is separate."}


async def _call_api(tool: dict, arguments: dict) -> Any:
    path = tool["path"]
    for key, value in arguments.get("path", {}).items():
        value = str(value)
        if value in (".", "..") or any(c in value for c in ("/", "\\", "?", "#", "%")):
            raise ValueError("Path identifiers cannot contain URL control characters")
        path = path.replace("{" + key + "}", quote(value, safe=""))
    kwargs = {"params": arguments.get("query", {})}
    # The agent acts as the signed-in user: internal calls carry their session
    # token, so every route applies the same ownership rules as the UI.
    token = request_token()
    if token:
        kwargs["headers"] = {"Authorization": f"Bearer {token}"}
    if "body" in arguments:
        kwargs["json"] = arguments["body"]
    if "file" in arguments:
        file = arguments["file"]
        kwargs["files"] = {"file": (file["name"], base64.b64decode(file["data_base64"], validate=True), file["mime_type"])}
        kwargs["data"] = arguments.get("form", {})
    # Scene and evaluation routes can legitimately run for minutes.
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app(), raise_app_exceptions=False), base_url="http://zoetrope.internal", timeout=600) as client:
        response = await client.request(tool["method"], path, **kwargs)
    if response.status_code >= 400:
        try:
            detail = response.json().get("detail", response.text)
        except ValueError:
            detail = response.text[:1000]
        raise ValueError(f"{tool['name']} returned {response.status_code}: {detail}")
    if "application/json" in response.headers.get("content-type", ""):
        return response.json()
    return {"resource_url": path + ("?" + urlencode(arguments["query"]) if arguments.get("query") else ""),
            "mime_type": response.headers.get("content-type"), "bytes": len(response.content)}


def validate_arguments(tool: dict, arguments: dict) -> None:
    """Raise ValueError carrying the schema when arguments do not fit, so a model can retry."""
    errors = sorted(Draft202012Validator(tool["input_schema"]).iter_errors(arguments), key=lambda e: list(e.path))
    if errors:
        where = "/".join(str(p) for p in errors[0].absolute_path) or "(root)"
        raise ValueError(
            f"Invalid arguments for {tool['name']} at {where}: {errors[0].message}. "
            f"Expected input_schema: {json.dumps(tool['input_schema'])[:4000]}"
        )


def _prepare_execution(name: str, arguments: dict) -> dict:
    """Resolve and validate a call; shared by the sync and async executors."""
    tool = describe_tool(name)
    validate_arguments(tool, arguments)
    if not tool["available"]:
        raise ValueError(tool.get("unavailable_reason", "Tool is not available"))
    return tool


def execute_tool(name: str, arguments: dict, workspace: dict | None = None) -> Any:
    tool = _prepare_execution(name, arguments)
    if name == "app.context":
        return application_context(workspace)
    if name == "app.papers":
        return library_papers(**arguments)
    if tool["execution"] == "mcp":
        from app.mcp.bridge import call_mcp_tool
        return call_mcp_tool(name, arguments)
    return asyncio.run(_call_api(tool, arguments))


async def aexecute_tool(name: str, arguments: dict, workspace: dict | None = None) -> Any:
    """`execute_tool` for callers already inside the event loop (the assistant websocket).

    `asyncio.run` cannot be nested, so api.* calls await the ASGI transport
    directly and blocking work (sqlite, MCP subprocesses) moves to the threadpool.
    """
    from fastapi.concurrency import run_in_threadpool

    tool = _prepare_execution(name, arguments)
    if name == "app.context":
        return await run_in_threadpool(application_context, workspace)
    if name == "app.papers":
        return await run_in_threadpool(lambda: library_papers(**arguments))
    if tool["execution"] == "mcp":
        from app.mcp.bridge import call_mcp_tool
        return await run_in_threadpool(call_mcp_tool, name, arguments)
    return await _call_api(tool, arguments)

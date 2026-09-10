"""The agent runtime: one model, one loop, every application tool.

The model is given a live overview of the application (features, paper
counts, the user's current selection and every tool by name) plus six meta
tools. Everything else it reaches through `execute_tool`, which routes into
the same catalog the UI and the MCP bridge use, so nothing here has to change
when a feature is added elsewhere in the app.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langsmith import traceable

from app.agents import catalog
from app.agents.state import AgentState
from app.rag.generator import generate_answer, get_llm

DEFAULT_MAX_STEPS = 8
DEFAULT_TOOL_OUTPUT_CHARS = 12000
HISTORY_LIMIT = 12
MAX_SOURCES = 24

# A state-changing tool only runs when the user's own words in the current
# turn asked for that kind of action. The model is told to ask otherwise.
CONFIRMATION_WORDS = {
    "destructive": ("delete", "remove", "clear", "erase", "drop", "wipe", "discard"),
    "external_write": ("notion", "github", "export", "publish", "issue", "sync", "push", "send"),
}

# Keys under which tool results carry paper-like records worth citing.
SOURCE_KEYS = ("sources", "papers", "articles", "results", "posts", "notes", "repositories", "hits")

TOOLS: List[Dict[str, Any]] = [
    {"type": "function", "function": {
        "name": "discover_tools",
        "description": "Search the application's tool catalog by keyword and/or category. Returns names, descriptions, effects and availability without schemas. Use when the tool index in your instructions is not enough.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}, "category": {"type": "string"},
            "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 200},
        }},
    }},
    {"type": "function", "function": {
        "name": "describe_tool",
        "description": "Full definition of one catalog tool including its exact input_schema. Call this before the first execute_tool of an api.* tool.",
        "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    }},
    {"type": "function", "function": {
        "name": "execute_tool",
        "description": "Run any catalog tool by name. api.* tools take grouped arguments {path, query, body}; research.*, notion.*, github.*, reddit.* and app.* tools take their own flat arguments. Invalid arguments return the schema so you can retry.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"},
            "arguments": {"type": "object", "description": "Arguments matching the tool's input_schema.", "additionalProperties": True},
        }, "required": ["name", "arguments"]},
    }},
    {"type": "function", "function": {
        "name": "app_context",
        "description": "Live application overview: features, paper counts by domain/category, tool counts, integration status, Notion targets and the user's current workspace selection.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "app_papers",
        "description": "Search or page through every paper in the library and get real article_id and source values. An empty query lists papers.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}, "offset": {"type": "integer", "minimum": 0},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            "domain": {"type": "string"}, "category": {"type": "string"},
        }},
    }},
    {"type": "function", "function": {
        "name": "answer_from_papers",
        "description": "Grounded, retrieval-augmented answer from the indexed papers (the app's Chat feature), scoped to the user's current selection. Returns an answer plus cited sources. Use for any question about research content.",
        "parameters": {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]},
    }},
]


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, "") or default))
    except ValueError:
        return default


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _trace(tool: str, message: str, status: str = "success", **extra: Any) -> Dict[str, Any]:
    return {"tool": tool, "status": status, "message": message, "timestamp": _now(), **extra}


def _text(response: Any) -> str:
    content = getattr(response, "content", response)
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type", "text") == "text":
                parts.append(str(block.get("text", "")))
        return "\n".join(part for part in parts if part).strip()
    return str(content or "").strip()


def _compact(value: Any, limit: int = 300) -> str:
    text = json.dumps(value, default=str, ensure_ascii=False)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _for_model(result: Any) -> str:
    limit = _int_env("AGENT_TOOL_OUTPUT_CHARS", DEFAULT_TOOL_OUTPUT_CHARS)
    text = json.dumps(result, default=str, ensure_ascii=False)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [truncated {len(text) - limit} characters; narrow the request or page with offset]"


def _summarize(result: Any) -> str:
    if isinstance(result, dict):
        if result.get("error"):
            return str(result["error"])[:200]
        if isinstance(result.get("summary"), str) and result["summary"].strip():
            return result["summary"].strip()[:200]
        counts = [f"{len(value)} {key}" for key, value in result.items() if isinstance(value, list)]
        if counts:
            return ", ".join(counts[:4])
        if "status" in result:
            return f"status {result['status']}"
        if "resource_url" in result:
            return f"{result.get('mime_type') or 'binary'} resource, {result.get('bytes', 0)} bytes"
        return f"Returned {len(result)} fields"
    if isinstance(result, list):
        return f"Returned {len(result)} items"
    return str(result)[:200]


def _pick(args: Dict[str, Any], keys: tuple, integers: tuple = ()) -> Dict[str, Any]:
    picked = {}
    for key in keys:
        value = args.get(key)
        if value in (None, ""):
            continue
        if key in integers:
            try:
                value = int(value)
            except (TypeError, ValueError):
                continue
        picked[key] = value
    return picked


def _as_source(item: Dict[str, Any], key: str) -> Dict[str, Any] | None:
    if key == "sources":
        return item
    title = item.get("title") or item.get("full_name") or item.get("source_title")
    text = (item.get("abstract") or item.get("text") or item.get("selected_text")
            or item.get("body_md") or item.get("description") or "")
    if not title and not text:
        return None
    return {
        "id": item.get("id") or item.get("article_id") or item.get("note_id") or item.get("paper_id")
        or item.get("arxiv_id") or item.get("doi") or item.get("full_name") or item.get("url") or title,
        "article_id": item.get("article_id"),
        "title": title,
        "text": str(text),
        "source": item.get("source") or item.get("pdf_url") or item.get("source_ref") or item.get("url") or "",
        "url": item.get("url") or item.get("pdf_url") or "",
        "topic": key,
        "page": item.get("page"),
        "domain": item.get("domain"),
        "category": item.get("category"),
        "tags": item.get("tags") or [],
    }


def _workspace(state: AgentState) -> Dict[str, Any]:
    workspace = dict(state.get("workspace") or {})
    pinned = state.get("pinned_sources") or []
    if pinned:
        workspace["pinned_sources"] = [
            {**{k: p.get(k) for k in ("id", "title", "source", "article_id", "page", "url")},
             "text": str(p.get("text") or p.get("selected_text") or "")[:300]}
            for p in pinned[:5]
        ]
    for key in ("document_source", "cluster_id", "domain", "category", "context_mode"):
        if state.get(key) not in (None, "", []):
            workspace.setdefault(key, state[key])
    return workspace


def _permitted(tool: Dict[str, Any], question: str) -> bool:
    words = CONFIRMATION_WORDS.get(tool.get("effect", "read"))
    if not words:
        return True
    lowered = question.lower()
    return any(word in lowered for word in words)


def build_system_prompt(state: AgentState, max_steps: int) -> str:
    tools = catalog.tool_catalog()
    context = catalog.application_context(_workspace(state))
    domains = ", ".join(
        f"{d.get('domain')}/{d.get('category')} ({d.get('article_count')})" for d in context["domains"]
    ) or "none indexed yet"
    features = "\n".join(f"- {name}: {text}" for name, text in context["guide"].items())
    unavailable = "\n".join(f"- {t['name']}: {t['reason']}" for t in context["unavailable_tools"]) or "- none"
    targets = ", ".join(str(t.get("name") or t.get("target_id")) for t in context["notion_targets"]) or "none configured"
    workspace = context["workspace"]
    workspace_text = json.dumps(workspace, default=str, ensure_ascii=False, indent=1) if workspace else "Nothing is selected; the whole library is in scope."

    return f"""You are the Zoetrope research agent. Zoetrope is a research workspace for finding, indexing, reading, questioning and visualizing scientific papers. You run inside the app's Agent tab and can operate every part of the application through tools. The user may ask about anything the app contains or can do.

# Application overview
- Papers indexed: {context['paper_count']} across domain/category: {domains}
- Features:
{features}
- Tools: {context['tool_count']} across {len(context['tool_categories'])} areas ({', '.join(f"{k}: {v}" for k, v in sorted(context['tool_categories'].items()))})
- Notion targets: {targets}
- Not available right now:
{unavailable}

# Current workspace selection
{workspace_text}

# Tool index
{catalog.catalog_index(tools)}

# How to work
1. Questions about research content go through answer_from_papers, which retrieves from the indexed papers with the user's current scope.
2. Resolve paper titles to real article_id/source values with app_papers before calling paper-specific tools. Never invent article_id, viz_id, note_id or any other identifier; read them from tool results.
3. Before the first execute_tool of an api.* tool, call describe_tool for its input_schema. api.* arguments are grouped as {{"path": {{...}}, "query": {{...}}, "body": {{...}}}}. research.*, notion.*, github.*, reddit.* and app.* tools take flat arguments.
4. Tools marked destructive or external_write only run when the user's current message explicitly asks for that action. If a call is refused for that reason, say what you would do and ask the user to confirm in their own words.
5. Chain tools when a task needs several steps (find a paper, read its visualizations, generate a scene, save a note). Stop as soon as you can answer. You have at most {max_steps} model turns per request.
6. When a tool fails, report it plainly and suggest the next step. Never present a failed action as done.
7. Questions about what the app or you can do are answered from this overview without tools, unless live details are needed.

# Answer style
Markdown, concise and specific. Name papers by title and include URLs or resource links returned by tools. Put Mermaid diagrams in ```mermaid fences. Mention internal tool names only when the user asks about tools."""


def _history(state: AgentState) -> List[Any]:
    messages = []
    for item in (state.get("chat_history") or [])[-HISTORY_LIMIT:]:
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        messages.append(HumanMessage(content=content) if item.get("role") == "user" else AIMessage(content=content))
    return messages


class _Run:
    """Per-request bookkeeping: the trace, cited sources and side outputs."""

    def __init__(self, state: AgentState) -> None:
        self.state = state
        self.trace: List[Dict[str, Any]] = list(state.get("tool_trace") or [])
        self.sources: List[Dict[str, Any]] = []
        self.topology: Dict[str, Any] | None = None
        self.seen: set = set()
        self.acted = False

    def dispatch(self, call: Dict[str, Any]) -> Any:
        name = str(call.get("name") or "")
        args = call.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        label = name
        if name == "execute_tool":
            label = str(args.get("name") or "execute_tool")
        elif name == "describe_tool":
            label = f"describe_tool: {args.get('name', '')}"
        try:
            result = self._invoke(name, args)
        except Exception as exc:  # the model gets the error and decides what to do next
            detail = str(exc)
            self.trace.append(_trace(label, detail[:500], "error", arguments=_compact(args)))
            return {"error": detail[:3000]}
        if isinstance(result, dict) and result.get("requires_confirmation"):
            self.trace.append(_trace(label, str(result.get("error", ""))[:300], "skipped", arguments=_compact(args)))
            return result
        self._collect(result)
        effect = result.pop("_effect", "read") if isinstance(result, dict) else "read"
        self.trace.append(_trace(label, _summarize(result), "success", arguments=_compact(args), effect=effect))
        return result

    def _invoke(self, name: str, args: Dict[str, Any]) -> Any:
        if name == "discover_tools":
            return catalog.discover_tools(**_pick(args, ("query", "category", "offset", "limit"), integers=("offset", "limit")))
        if name == "describe_tool":
            return catalog.describe_tool(str(args.get("name") or ""))
        if name == "execute_tool":
            return self._execute(str(args.get("name") or ""), args.get("arguments") or {})
        if name == "app_context":
            return catalog.application_context(_workspace(self.state))
        if name == "app_papers":
            return catalog.library_papers(**_pick(args, ("query", "offset", "limit", "domain", "category"), integers=("offset", "limit")))
        if name == "answer_from_papers":
            return self._answer(str(args.get("question") or self.state["question"]))
        raise ValueError(f"Unknown tool {name}")

    def _execute(self, target: str, arguments: Any) -> Any:
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be a JSON object matching the tool's input_schema")
        tool = catalog.describe_tool(target)
        if not _permitted(tool, self.state["question"]):
            return {
                "requires_confirmation": True,
                "error": (
                    f"{target} is marked {tool['effect']} and the user's current message did not explicitly ask for that. "
                    "Explain what it would do and ask the user to confirm in their own words."
                ),
            }
        self.acted = True
        result = catalog.execute_tool(target, arguments, _workspace(self.state))
        if isinstance(result, dict):
            result = {**result, "_effect": tool["effect"]}
        return result

    def _answer(self, question: str) -> Dict[str, Any]:
        state = self.state
        self.acted = True
        result = generate_answer(
            query=question,
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
        return {"answer": result.get("answer", ""), "sources": result.get("sources", [])}

    def _collect(self, result: Any) -> None:
        if not isinstance(result, dict):
            return
        if isinstance(result.get("topology"), dict):
            self.topology = result["topology"]
        for key in SOURCE_KEYS:
            items = result.get(key)
            if not isinstance(items, list):
                continue
            for item in items[:8]:
                if not isinstance(item, dict):
                    continue
                source = _as_source(item, key)
                if source is None:
                    continue
                marker = (str(source.get("id") or ""), str(source.get("title") or ""))
                if marker in self.seen or len(self.sources) >= MAX_SOURCES:
                    continue
                self.seen.add(marker)
                self.sources.append(source)


@traceable(name="agent_tool_loop", run_type="chain")
def run_agent(state: AgentState) -> Dict[str, Any]:
    """Answer one Agent-tab request with the tool-calling loop."""
    question = state["question"]
    max_steps = _int_env("AGENT_MAX_STEPS", DEFAULT_MAX_STEPS)
    model = os.getenv("AGENT_MODEL", "").strip()
    llm = get_llm(model=model, temperature=0) if model else get_llm(temperature=0)
    bound = llm.bind_tools(TOOLS)

    messages: List[Any] = [
        SystemMessage(content=build_system_prompt(state, max_steps)),
        *_history(state),
        HumanMessage(content=question),
    ]
    run = _Run(state)
    answer = ""

    for _ in range(max_steps):
        response = bound.invoke(messages)
        messages.append(response)
        calls = list(getattr(response, "tool_calls", None) or [])
        if not calls:
            answer = _text(response)
            break
        for call in calls:
            result = run.dispatch(call)
            messages.append(ToolMessage(content=_for_model(result), tool_call_id=str(call.get("id") or call.get("name"))))
    else:
        run.trace.append(_trace("agent", f"Reached the {max_steps}-step limit; answering with what was gathered.", "skipped"))
        messages.append(HumanMessage(content="You have used every tool step for this request. Give the user your final answer now from what you already gathered; do not call tools."))
        answer = _text(bound.invoke(messages))

    if not answer:
        done = [step["tool"] for step in run.trace if step.get("status") == "success"]
        answer = "I finished the steps I could run" + (f" ({', '.join(done)})" if done else "") + " but did not produce a summary. Ask me to describe the results."

    return {
        "answer": answer,
        "sources": run.sources[:MAX_SOURCES],
        "topology": run.topology,
        "tool_trace": run.trace,
        "intent": "agent" if run.acted else "chat",
    }

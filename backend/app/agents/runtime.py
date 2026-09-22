"""The agent runtime: one model, one loop, every application tool.

The model is given a live overview of the application (features, paper
counts, the user's current selection and every tool by name) plus eight meta
tools. Everything else it reaches through `execute_tool`, which routes into
the same catalog the UI and the MCP bridge use, so nothing here has to change
when a feature is added elsewhere in the app.

Two entry points share the loop:

- `run_agent` — the Agent tab's synchronous request/response call.
- `arun_agent` — the always-present assistant: async, streams typed events
  (thinking, tokens, tool start/result, client tool calls, confirmation
  requests, the spoken line) through an `emit` callback, and can call tools
  the browser lends it (`ui_*`), waiting for their results mid-loop.

Three things make the loop more than a chatbot with tools:

- Parallel tool calls. Every tool call the model issues in one turn runs
  concurrently (bounded by AGENT_PARALLEL_TOOLS); browser tools run in order
  because they change the screen.
- Delegation. `delegate` fans independent sub-tasks out to workers: each is a
  fresh, bounded copy of this loop on the faster worker model, with the same
  catalog but no browser tools and no destructive/external-write actions.
  Only their reports come back into the main context.
- Playbooks. `run_playbook` executes a named procedure from
  `app/agents/playbook_defs` (see `playbooks.py`): deterministic tool steps
  and worker steps, grouped for concurrency, with the confirmation rules
  intact. The main agent then writes the answer from the step results.
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langsmith import traceable

from app.agents import catalog, playbooks
from app.agents.activity import render_activity
from app.agents.assistant.client_tools import (
    ClientToolExecutor,
    bind_client_tools,
    client_label,
    client_name,
    is_client_tool,
)
from app.agents.assistant.speech import SpeakGate, speakable, split_spoken
from app.agents.context_schema import render_workspace
from app.agents.models import agent_model_name, model_kwargs, worker_model_name
from app.agents.state import AgentState
from app.rag.generator import generate_answer, get_llm

DEFAULT_MAX_STEPS = 8
DEFAULT_TOOL_OUTPUT_CHARS = 12000
HISTORY_LIMIT = 12
MAX_SOURCES = 24

# Concurrency: tool calls within one model turn, and workers per delegation.
DEFAULT_PARALLEL_TOOLS = 4
DEFAULT_MAX_WORKERS = 4
DEFAULT_WORKER_MAX_STEPS = 6
MAX_DELEGATE_TASKS = 8
WORKER_REPORT_CHARS = 6000

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
    {"type": "function", "function": {
        "name": "delegate",
        "description": (
            "Run independent sub-tasks in parallel, each handled by a worker agent with its own tool loop and fresh context; "
            "only their reports come back. Use it for several chunks of independent work (read or summarize several papers, "
            "run several searches and compare them, check several things at once). Give each worker complete, self-contained "
            "instructions including titles and identifiers. Workers can search, read and write inside the app (notes, ingestion) "
            "but never delete or publish externally; do those yourself. Ask for format 'json' when you need structured data back."
        ),
        "parameters": {"type": "object", "properties": {
            "tasks": {"type": "array", "minItems": 1, "maxItems": MAX_DELEGATE_TASKS, "items": {"type": "object", "properties": {
                "task": {"type": "string", "description": "Complete instructions for one worker."},
                "label": {"type": "string", "description": "Short name shown to the user while the worker runs."},
                "format": {"type": "string", "enum": ["text", "json"], "description": "json: the worker ends its report with a JSON block, returned parsed as `data`."},
            }, "required": ["task"]}},
        }, "required": ["tasks"]},
    }},
    {"type": "function", "function": {
        "name": "run_playbook",
        "description": (
            "Run a named playbook: a reusable multi-step procedure listed under Playbooks in your instructions. It executes the "
            "steps for you (in parallel where possible, with workers where needed) and returns each step's result plus "
            "instructions for your final answer. Prefer a matching playbook over improvising the same steps. Invalid params "
            "return the schema so you can retry."
        ),
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"},
            "params": {"type": "object", "description": "Arguments matching the playbook's parameters.", "additionalProperties": True},
        }, "required": ["name"]},
    }},
]

META_TOOL_NAMES = {t["function"]["name"] for t in TOOLS}
# The two meta tools that start further model loops. Workers do not get them,
# so delegation is one level deep and cannot recurse.
ORCHESTRATION_TOOLS = {"delegate", "run_playbook"}
WORKER_TOOLS = [t for t in TOOLS if t["function"]["name"] not in ORCHESTRATION_TOOLS]

# A guard looks at a catalog tool and its arguments and either lets the call
# through (None) or returns the payload the model receives instead.
Guard = Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any] | None]
Emit = Callable[[Dict[str, Any]], Awaitable[None]]


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, "") or default))
    except ValueError:
        return default


def _parallel_limit() -> int:
    return _int_env("AGENT_PARALLEL_TOOLS", DEFAULT_PARALLEL_TOOLS)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _trace(tool: str, message: str, status: str = "success", **extra: Any) -> Dict[str, Any]:
    return {"tool": tool, "status": status, "message": message, "timestamp": _now(), **extra}


def _text(response: Any) -> str:
    return _raw_text(response).strip()


def _raw_text(response: Any) -> str:
    content = getattr(response, "content", response)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type", "text") == "text":
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return str(content or "")


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


def keyword_guard(question: str) -> Guard:
    """The Agent tab's rule: a risky tool runs only if the user's words asked for it."""

    def guard(tool: Dict[str, Any], _arguments: Dict[str, Any]) -> Dict[str, Any] | None:
        if _permitted(tool, question):
            return None
        return {
            "requires_confirmation": True,
            "error": (
                f"{tool['name']} is marked {tool['effect']} and the user's current message did not explicitly ask for that. "
                "Explain what it would do and ask the user to confirm in their own words."
            ),
        }

    return guard


def worker_guard(tool: Dict[str, Any], _arguments: Dict[str, Any]) -> Dict[str, Any] | None:
    """Workers never delete or publish: the main agent owns anything that needs the user's yes."""
    effect = str(tool.get("effect") or "read")
    if effect not in ("destructive", "external_write"):
        return None
    return {
        "requires_confirmation": True,
        "error": (
            f"{tool['name']} is marked {effect} and workers cannot run it. It has NOT run. "
            "State in your report exactly what should be done (tool and arguments) so the main agent can ask the user."
        ),
    }


def _client_tools_text(client_tools: List[Dict[str, Any]] | None) -> str:
    if not client_tools:
        return "- none lent by the browser this session"
    lines = []
    for spec in client_tools:
        props = list((spec.get("input_schema") or {}).get("properties", {}).keys())
        args = f" ({', '.join(props)})" if props else ""
        flag = f" [{spec['effect']}]" if spec.get("effect", "read") != "read" else ""
        lines.append(f"- ui_{spec['name']}{args}{flag}: {spec.get('description', '')}")
    return "\n".join(lines)


_ORCHESTRATION_RULES = """- Independent tool calls can be issued together in one turn; they run concurrently. Only chain calls that need each other's results.
- For several independent chunks of work (read or summarize several papers, run several searches and compare them), call delegate: workers run them in parallel with their own tool loops on the whole catalog and return only their reports, which keeps your own steps free. Give each worker complete, self-contained instructions with titles and identifiers; ask for format json when you need structured data back.
- When a playbook below matches the request, call run_playbook instead of improvising the same steps; it runs the procedure (in parallel where possible) and returns each step's result plus instructions for your final answer. Confirmation rules still apply inside playbooks, and workers never delete or publish."""


def build_system_prompt(
    state: AgentState,
    max_steps: int,
    *,
    mode: str = "agent",
    client_tools: List[Dict[str, Any]] | None = None,
    activity: Dict[str, Any] | None = None,
) -> str:
    tools = catalog.tool_catalog()
    context = catalog.application_context(_workspace(state))
    domains = ", ".join(
        f"{d.get('domain')}/{d.get('category')} ({d.get('article_count')})" for d in context["domains"]
    ) or "none indexed yet"
    features = "\n".join(f"- {name}: {text}" for name, text in context["guide"].items())
    unavailable = "\n".join(f"- {t['name']}: {t['reason']}" for t in context["unavailable_tools"]) or "- none"
    targets = ", ".join(str(t.get("name") or t.get("target_id")) for t in context["notion_targets"]) or "none configured"
    workspace = context["workspace"]

    if mode == "assistant":
        return _assistant_prompt(context, domains, features, unavailable, targets, workspace, tools, max_steps,
                                 client_tools or [], activity)

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

# Playbooks (run with run_playbook)
{playbooks.playbook_index()}

# How to work
1. Questions about research content go through answer_from_papers, which retrieves from the indexed papers with the user's current scope.
2. Resolve paper titles to real article_id/source values with app_papers before calling paper-specific tools. Never invent article_id, viz_id, note_id or any other identifier; read them from tool results.
3. Before the first execute_tool of an api.* tool, call describe_tool for its input_schema. api.* arguments are grouped as {{"path": {{...}}, "query": {{...}}, "body": {{...}}}}. research.*, notion.*, github.*, reddit.* and app.* tools take flat arguments.
4. Tools marked destructive or external_write only run when the user's current message explicitly asks for that action. If a call is refused for that reason, say what you would do and ask the user to confirm in their own words.
5. Chain tools when a task needs several steps (find a paper, read its visualizations, generate a scene, save a note). Stop as soon as you can answer. You have at most {max_steps} model turns per request.
6. When a tool fails, report it plainly and suggest the next step. Never present a failed action as done.
7. Questions about what the app or you can do are answered from this overview without tools, unless live details are needed.
8. Working in parallel and delegating:
{_ORCHESTRATION_RULES}

# Answer style
Markdown, concise and specific. Name papers by title and include URLs or resource links returned by tools. Put Mermaid diagrams in ```mermaid fences. Mention internal tool names only when the user asks about tools."""


def _assistant_prompt(context, domains, features, unavailable, targets, workspace, tools, max_steps,
                      client_tools, activity) -> str:
    return f"""You are Zoe, Zoetrope's assistant: a spoken, always-present helper that lives in a small dock on every screen of the Zoetrope research workspace (finding, indexing, reading, questioning and visualizing scientific papers). The user talks to you by voice or types to you while working. You see what they are looking at, you can operate every part of the application through tools, and you can change what is on their screen through the browser controls below. Behave like a capable, calm research assistant: act on requests, narrate what you are doing in plain words, and keep replies short unless the user asks for depth.

# Application overview
- Papers indexed: {context['paper_count']} across domain/category: {domains}
- Features:
{features}
- Tools: {context['tool_count']} across {len(context['tool_categories'])} areas ({', '.join(f"{k}: {v}" for k, v in sorted(context['tool_categories'].items()))})
- Notion targets: {targets}
- Not available right now:
{unavailable}

# What the user is looking at right now
{render_workspace(workspace)}

# Recent activity
{render_activity(activity)}

# Screen controls (run in the user's browser)
These are ordinary tools you call directly by name. They change the user's screen immediately and return what happened. Prefer them whenever the user asks to open, show, go to, navigate, jump, pin, filter or start something visible. Use ui_read_screen when you need to know what is on screen beyond the summary above.
{_client_tools_text(client_tools)}

# Tool index (application tools, called through execute_tool)
{catalog.catalog_index(tools)}

# Playbooks (run with run_playbook)
{playbooks.playbook_index()}

# How to work
1. Questions about research content go through answer_from_papers, which retrieves from the indexed papers with the user's current scope.
2. Resolve paper titles to real article_id/source values with app_papers before calling paper-specific tools or ui_open_paper. Never invent article_id, viz_id, note_id or any other identifier; read them from tool results. When a title is ambiguous, ask which one.
3. Before the first execute_tool of an api.* tool, call describe_tool for its input_schema. api.* arguments are grouped as {{"path": {{...}}, "query": {{...}}, "body": {{...}}}}. research.*, notion.*, github.*, reddit.* and app.* tools take flat arguments.
4. Chain tools when a task needs several steps (find a paper, open it, jump to a page, save a note). Stop as soon as you can answer. You have at most {max_steps} model turns per request.
5. When a tool fails, say so plainly and suggest the next step. Never present a failed action as done.
6. When the user asks what you can do or which tools you have, answer from this overview in everyday words grouped by what they accomplish (search papers, read and answer, notes, visualize, navigate the app, integrations, playbooks); mention internal tool names only if asked for them.
7. Spoken requests are transcribed and may contain recognition errors; interpret them charitably and confirm only when the intent is genuinely unclear.
8. Working in parallel and delegating (the dock shows workers and playbook steps to the user as they run, so a bigger task is fine):
{_ORCHESTRATION_RULES}

# Confirmations
Destructive and external-write tools (deleting anything, publishing to Notion or GitHub) do not run immediately. When you call one, it is parked and you receive a note saying so. Then tell the user in one short sentence exactly what would happen and ask them to answer yes or no. Do not call it again in the same turn. The user's yes or no arrives as their next message. A playbook that reaches such a step stops there and tells you what is left.

# Answer style
Markdown, brief and specific: usually one to four sentences, or a short list. Name papers by title. Put Mermaid diagrams in ```mermaid fences only when asked for a diagram. After a playbook or delegation, follow the returned report instructions but keep the spoken line short.

# Speaking
Your answer is also read aloud. End EVERY reply with a final line that starts with `SPEAK:` followed by one or two plain, natural sentences summarising the reply for speech: no Markdown, no lists, no URLs, no identifiers, and never the words "Zoetrope" or "Zoe" (they are the wake word). Example:

I opened **Graph RAG for Science** in the reader at page 4.
SPEAK: I opened Graph RAG for Science at page four."""


def build_worker_prompt(state: AgentState, max_steps: int, fmt: str = "text") -> str:
    """A worker's instructions: the same app and tools, one task, a report instead of an answer."""
    tools = catalog.tool_catalog()
    context = catalog.application_context(_workspace(state))
    domains = ", ".join(
        f"{d.get('domain')}/{d.get('category')} ({d.get('article_count')})" for d in context["domains"]
    ) or "none indexed yet"
    features = "\n".join(f"- {name}: {text}" for name, text in context["guide"].items())
    unavailable = "\n".join(f"- {t['name']}: {t['reason']}" for t in context["unavailable_tools"]) or "- none"
    json_rule = (
        "\n- The task asks for structured data: end your report with exactly one ```json fenced block containing it."
        if fmt == "json" else ""
    )
    return f"""You are a worker for the Zoetrope research agent. Zoetrope is a research workspace for finding, indexing, reading, questioning and visualizing scientific papers. The main agent has delegated ONE task to you (the user message below). Complete it with the tools available and report back. Your report is read by the main agent, not the user: be factual and specific, name papers by title, include the identifiers you used or found (article_id, source, note_id, URLs), and state plainly anything you could not do.

# Application overview
- Papers indexed: {context['paper_count']} across domain/category: {domains}
- Features:
{features}
- Not available right now:
{unavailable}

# The user's current workspace (for scope; the task text takes precedence)
{render_workspace(context['workspace'])}

# Tool index (application tools, called through execute_tool)
{catalog.catalog_index(tools)}

# How to work
1. Questions about research content go through answer_from_papers (scoped to the user's current selection) or research.summarize_paper for a specific paper.
2. Resolve paper titles to real article_id/source values with app_papers before calling paper-specific tools. Never invent identifiers; read them from tool results.
3. Before the first execute_tool of an api.* tool, call describe_tool for its input_schema. api.* arguments are grouped as {{"path": {{...}}, "query": {{...}}, "body": {{...}}}}. research.*, notion.*, github.*, reddit.* and app.* tools take flat arguments.
4. Independent tool calls can be issued together in one turn; they run concurrently.
5. Destructive and external-write tools are refused for workers. If the task needs one, say exactly what should be done instead.
6. You have at most {max_steps} tool turns. Stop as soon as you can report. Never present a failed action as done.

# Report
- Plain Markdown, no greeting, no SPEAK line. Lead with the result, then the evidence and identifiers.{json_rule}"""


def _history(state: AgentState) -> List[Any]:
    messages = []
    for item in (state.get("chat_history") or [])[-HISTORY_LIMIT:]:
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        messages.append(HumanMessage(content=content) if item.get("role") == "user" else AIMessage(content=content))
    return messages


def _call_id(call: Dict[str, Any], label: str, index: int) -> str:
    return str(call.get("id") or f"{label}-{index}")


class _Run:
    """Per-request bookkeeping: the trace, cited sources and side outputs.

    `emit`, `turn_id`, `parent_call_id` and `label` are set for the async
    assistant run and for child runs (workers, playbooks); the synchronous
    Agent-tab run leaves them empty and its children simply do not stream.
    """

    def __init__(
        self,
        state: AgentState,
        guard: Guard | None = None,
        *,
        emit: Emit | None = None,
        turn_id: str = "",
        parent_call_id: str = "",
        label: str = "",
    ) -> None:
        self.state = state
        self.guard: Guard = guard or keyword_guard(str(state.get("question") or ""))
        self.emit = emit
        self.turn_id = turn_id
        self.parent_call_id = parent_call_id
        self.label = label
        self.trace: List[Dict[str, Any]] = list(state.get("tool_trace") or [])
        self.sources: List[Dict[str, Any]] = []
        self.topology: Dict[str, Any] | None = None
        self.seen: set = set()
        self.acted = False

    # -- shared bookkeeping -------------------------------------------------

    @staticmethod
    def _describe_call(call: Dict[str, Any]) -> tuple[str, Dict[str, Any], str]:
        name = str(call.get("name") or "")
        args = call.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        label = name
        if name == "execute_tool":
            label = str(args.get("name") or "execute_tool")
        elif name == "describe_tool":
            label = f"describe_tool: {args.get('name', '')}"
        elif name == "run_playbook":
            label = f"playbook: {args.get('name', '')}"
        elif is_client_tool(name):
            label = client_label(name)
        return name, args, label

    def _nested(self, extra: Dict[str, Any]) -> Dict[str, Any]:
        if self.label:
            extra.setdefault("parent", self.label)
        return extra

    def _record_error(self, label: str, args: Dict[str, Any], exc: Exception, **extra: Any) -> tuple[Dict[str, Any], Dict[str, Any]]:
        detail = str(exc)
        entry = _trace(label, detail[:500], "error", arguments=_compact(args), **self._nested(extra))
        self.trace.append(entry)
        return {"error": detail[:3000]}, entry

    def _record(self, label: str, args: Dict[str, Any], result: Any, effect: str | None = None, **extra: Any) -> tuple[Any, Dict[str, Any]]:
        extra = self._nested(extra)
        if isinstance(result, dict) and result.get("requires_confirmation"):
            entry = _trace(label, str(result.get("error", ""))[:300], "skipped", arguments=_compact(args), **extra)
            self.trace.append(entry)
            return result, entry
        self._collect(result)
        popped = result.pop("_effect", None) if isinstance(result, dict) else None
        entry = _trace(label, _summarize(result), "success", arguments=_compact(args), effect=effect or popped or "read", **extra)
        self.trace.append(entry)
        return result, entry

    def _absorb(self, child: "_Run") -> None:
        """Fold a child run's trace, sources and side effects into this run."""
        self.trace.extend(child.trace)
        for source in child.sources:
            marker = (str(source.get("id") or ""), str(source.get("title") or ""))
            if marker in self.seen or len(self.sources) >= MAX_SOURCES:
                continue
            self.seen.add(marker)
            self.sources.append(source)
        if child.topology is not None:
            self.topology = child.topology
        self.acted = self.acted or child.acted

    # -- synchronous path (Agent tab) -----------------------------------------

    def dispatch(self, call: Dict[str, Any]) -> Any:
        name, args, label = self._describe_call(call)
        call_id = _call_id(call, label, len(self.trace))
        try:
            result = self._invoke(name, args, call_id)
        except Exception as exc:  # the model gets the error and decides what to do next
            return self._record_error(label, args, exc)[0]
        return self._record(label, args, result)[0]

    def dispatch_all(self, calls: List[Dict[str, Any]]) -> List[Any]:
        """Every tool call of one model turn, concurrently, results in call order."""
        limit = _parallel_limit()
        if len(calls) <= 1 or limit <= 1:
            return [self.dispatch(call) for call in calls]
        with ThreadPoolExecutor(max_workers=min(len(calls), limit)) as pool:
            # Plain threads do not inherit context variables (the signed-in user).
            futures = [pool.submit(contextvars.copy_context().run, self.dispatch, call) for call in calls]
            return [future.result() for future in futures]

    def _invoke(self, name: str, args: Dict[str, Any], call_id: str = "") -> Any:
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
        if name == "delegate":
            return asyncio.run(self._adelegate(args, call_id))
        if name == "run_playbook":
            return asyncio.run(self._arun_playbook(args, call_id))
        raise ValueError(f"Unknown tool {name}")

    @staticmethod
    def _check_arguments(arguments: Any) -> Dict[str, Any]:
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be a JSON object matching the tool's input_schema")
        return arguments

    def _execute(self, target: str, arguments: Any) -> Any:
        arguments = self._check_arguments(arguments)
        tool = catalog.describe_tool(target)
        refused = self.guard(tool, arguments)
        if refused:
            return refused
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

    # -- delegation and playbooks (async; the sync path wraps them in asyncio.run) ------

    def _child(self, call_id: str, label: str, guard: Guard) -> "_AsyncRun":
        return _AsyncRun(self.state, emit=self.emit, guard=guard, turn_id=self.turn_id, parent_call_id=call_id, label=label)

    async def _adelegate(self, args: Dict[str, Any], call_id: str) -> Dict[str, Any]:
        tasks = args.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            raise ValueError("delegate needs a non-empty 'tasks' list of {task, label?, format?} objects")
        if len(tasks) > MAX_DELEGATE_TASKS:
            raise ValueError(f"delegate accepts at most {MAX_DELEGATE_TASKS} tasks per call; split the work or narrow it")
        specs = []
        for index, item in enumerate(tasks):
            if isinstance(item, str):
                item = {"task": item}
            if not isinstance(item, dict) or not str(item.get("task") or "").strip():
                raise ValueError(f"tasks[{index}] needs a non-empty 'task' string")
            fmt = str(item.get("format") or "text").lower()
            specs.append((str(item["task"]).strip(), str(item.get("label") or f"worker {index + 1}").strip()[:60], "json" if fmt == "json" else "text"))
        semaphore = asyncio.Semaphore(_int_env("AGENT_MAX_WORKERS", DEFAULT_MAX_WORKERS))

        async def one(task: str, label: str, fmt: str) -> Dict[str, Any]:
            async with semaphore:
                return await self._run_worker(task, label, call_id, fmt)

        reports = await asyncio.gather(*(one(*spec) for spec in specs))
        finished = sum(1 for r in reports if r.get("status") == "ok")
        merged: List[Dict[str, Any]] = []
        seen: set = set()
        for report in reports:
            for source in report.pop("_sources", []):
                marker = (str(source.get("id") or ""), str(source.get("title") or ""))
                if marker not in seen:
                    seen.add(marker)
                    merged.append(source)
        return {
            "summary": f"{finished} of {len(reports)} workers finished",
            "reports": reports,
            "sources": merged[:MAX_SOURCES],
        }

    async def _run_worker(self, task: str, label: str, call_id: str, fmt: str = "text") -> Dict[str, Any]:
        """One worker: a bounded copy of the loop on the worker model, reporting back."""
        child = self._child(call_id, label, worker_guard)
        max_steps = _int_env("AGENT_WORKER_MAX_STEPS", DEFAULT_WORKER_MAX_STEPS)
        started = time.monotonic()
        try:
            bound = _worker_model().bind_tools(WORKER_TOOLS)
            system = await asyncio.get_running_loop().run_in_executor(
                None, lambda: build_worker_prompt(self.state, max_steps, fmt)
            )
            messages: List[Any] = [SystemMessage(content=system), HumanMessage(content=task)]
            answer = ""
            steps_used = 0
            for step in range(max_steps):
                steps_used = step + 1
                response = await _ainvoke_model(bound, messages)
                messages.append(response)
                calls = list(getattr(response, "tool_calls", None) or [])
                invalid = list(getattr(response, "invalid_tool_calls", None) or [])
                if not calls and not invalid:
                    answer = _text(response)
                    break
                for bad in invalid:
                    messages.append(ToolMessage(
                        content=json.dumps({"error": f"Malformed tool call: {bad.get('error') or 'invalid arguments'}"}),
                        tool_call_id=str(bad.get("id") or "invalid"),
                    ))
                results = await child.adispatch_all(calls)
                for call, result in zip(calls, results):
                    messages.append(ToolMessage(content=_for_model(result), tool_call_id=str(call.get("id") or call.get("name"))))
            else:
                hint = " End with the ```json block the task asked for." if fmt == "json" else ""
                messages.append(HumanMessage(content=f"You have used every tool step. Report what you found now from what you already gathered; do not call tools.{hint}"))
                answer = _text(await _ainvoke_model(bound, messages))
            status = "ok" if answer else "incomplete"
            report = answer or _fallback_answer(child)
        except Exception as exc:  # the main agent reads the failure instead of the turn dying
            status, report, steps_used = "error", f"Worker failed: {exc}", 0
        self._absorb(child)
        data = playbooks.extract_json(report) if fmt == "json" and status == "ok" else None
        if len(report) > WORKER_REPORT_CHARS:
            report = report[:WORKER_REPORT_CHARS] + "\n... [report truncated]"
        return {
            "label": label,
            "task": task[:200],
            "status": status,
            "report": report,
            "data": data,
            "steps_used": steps_used,
            "tools": [entry["tool"] for entry in child.trace],
            "duration_ms": int((time.monotonic() - started) * 1000),
            "_sources": child.sources[:8],
        }

    async def _arun_playbook(self, args: Dict[str, Any], call_id: str) -> Dict[str, Any]:
        name = str(args.get("name") or "")
        try:
            playbook = playbooks.get_playbook(name)
            params = playbooks.prepare_params(playbook, args.get("params"))
        except playbooks.PlaybookError as exc:
            raise ValueError(str(exc)) from exc
        # Same guard as the parent: a destructive step parks for confirmation exactly as a direct call would.
        child = self._child(call_id, playbook.name, self.guard)
        counter = {"n": 0}

        async def call_tool(tool: str, arguments: Dict[str, Any]) -> Any:
            counter["n"] += 1
            step_id = f"{call_id}.{counter['n']}"
            if tool in META_TOOL_NAMES and tool not in ORCHESTRATION_TOOLS:
                call = {"id": step_id, "name": tool, "args": arguments}
            else:
                call = {"id": step_id, "name": "execute_tool", "args": {"name": tool, "arguments": arguments}}
            return await child.adispatch(call)

        async def run_task(task: str, label: str, fmt: str) -> Dict[str, Any]:
            return await self._run_worker(task, f"{playbook.name}: {label}", call_id, fmt)

        try:
            result = await playbooks.run_playbook(
                playbook, params, call_tool=call_tool, run_task=run_task,
                workspace=_workspace(self.state), concurrency=_parallel_limit(),
            )
        finally:
            self._absorb(child)
        return result


def _narrate(name: str, args: Dict[str, Any], tool: Dict[str, Any] | None, spec: Dict[str, Any] | None) -> str:
    """One short present-tense phrase for the dock caption while a tool runs."""
    if name == "discover_tools":
        return f"Looking through my tools for '{args.get('query')}'" if args.get("query") else "Looking through my tools"
    if name == "describe_tool":
        return f"Checking how {args.get('name', 'that tool')} works"
    if name == "app_context":
        return "Checking the application state"
    if name == "app_papers":
        return f"Searching your library for '{args.get('query')}'" if args.get("query") else "Listing your papers"
    if name == "answer_from_papers":
        return "Reading the papers to answer that"
    if name == "delegate":
        count = len(args.get("tasks") or []) if isinstance(args.get("tasks"), list) else 0
        return f"Handing {count} tasks to workers" if count > 1 else "Handing a task to a worker"
    if name == "run_playbook":
        return f"Running the {str(args.get('name') or 'requested').replace('_', ' ')} playbook"
    if spec is not None:
        first = str(spec.get("description") or "").split(". ")[0].rstrip(".")
        return first or f"Updating the screen ({spec.get('name')})"
    if tool is not None:
        description = str(tool.get("description") or "").split(" [", 1)[0].rstrip(".")
        return description[:120] if description else f"Running {tool.get('name')}"
    return f"Running {args.get('name') or name}"


class _AsyncRun(_Run):
    """The assistant's run: async dispatch, streamed tool events, browser tools."""

    def __init__(
        self,
        state: AgentState,
        *,
        emit: Emit | None,
        guard: Guard | None = None,
        client_tools: Dict[str, Dict[str, Any]] | None = None,
        client_executor: ClientToolExecutor | None = None,
        turn_id: str = "",
        parent_call_id: str = "",
        label: str = "",
    ) -> None:
        super().__init__(state, guard=guard, emit=emit, turn_id=turn_id, parent_call_id=parent_call_id, label=label)
        self.client_tools = client_tools or {}
        self.client_executor = client_executor

    async def _send(self, event: Dict[str, Any]) -> None:
        if self.emit is None:
            return
        if self.parent_call_id:
            event = {**event, "parent_call_id": self.parent_call_id, "worker": self.label}
        await self.emit({**event, "turn_id": self.turn_id})

    async def adispatch(self, call: Dict[str, Any]) -> Any:
        name, args, label = self._describe_call(call)
        call_id = _call_id(call, label, len(self.trace))
        spec = self.client_tools.get(client_name(name)) if is_client_tool(name) else None
        tool: Dict[str, Any] | None = None
        execution, effect = "builtin", "read"
        if spec is not None:
            execution, effect = "client", spec.get("effect", "read")
        elif name == "execute_tool":
            try:
                tool = await asyncio.get_running_loop().run_in_executor(None, catalog.describe_tool, str(args.get("name") or ""))
                execution, effect = tool.get("execution", "api"), tool.get("effect", "read")
            except Exception:
                tool = None
        elif name in ORCHESTRATION_TOOLS:
            execution = "orchestration"
        await self._send({
            "type": "tool_start", "call_id": call_id, "tool": label, "execution": execution, "effect": effect,
            "arguments": _compact(args.get("arguments") if name == "execute_tool" else args),
            "say": _narrate(name, args, tool, spec),
        })
        started = time.monotonic()
        try:
            result = await self._ainvoke(name, args, call_id)
        except Exception as exc:
            result, entry = self._record_error(label, args, exc, execution=execution)
        else:
            result, entry = self._record(label, args, result, effect=effect if spec else None, execution=execution)
        await self._send({
            "type": "tool_result", "call_id": call_id, "tool": label, "status": entry["status"],
            "message": entry["message"], "effect": entry.get("effect", effect), "execution": execution,
            "duration_ms": int((time.monotonic() - started) * 1000),
        })
        return result

    async def adispatch_all(self, calls: List[Dict[str, Any]]) -> List[Any]:
        """Every tool call of one model turn, concurrently, results in call order.

        Browser tools change what the user sees, so they run one after another
        (alongside the server-side calls); everything else shares a semaphore.
        """
        limit = _parallel_limit()
        if len(calls) <= 1 or limit <= 1:
            return [await self.adispatch(call) for call in calls]
        results: List[Any] = [None] * len(calls)
        semaphore = asyncio.Semaphore(limit)
        browser = [(i, c) for i, c in enumerate(calls) if is_client_tool(str(c.get("name") or ""))]
        server = [(i, c) for i, c in enumerate(calls) if not is_client_tool(str(c.get("name") or ""))]

        async def one(index: int, call: Dict[str, Any]) -> None:
            async with semaphore:
                results[index] = await self.adispatch(call)

        async def in_order() -> None:
            for index, call in browser:
                results[index] = await self.adispatch(call)

        await asyncio.gather(*(one(i, c) for i, c in server), in_order())
        return results

    async def _ainvoke(self, name: str, args: Dict[str, Any], call_id: str) -> Any:
        if is_client_tool(name):
            return await self._aclient(name, args, call_id)
        if name == "execute_tool":
            return await self._aexecute(str(args.get("name") or ""), args.get("arguments") or {})
        if name == "delegate":
            return await self._adelegate(args, call_id)
        if name == "run_playbook":
            return await self._arun_playbook(args, call_id)
        # The remaining meta tools touch sqlite or the RAG stack: keep them off the loop.
        return await asyncio.get_running_loop().run_in_executor(None, lambda: self._invoke(name, args, call_id))

    async def _aexecute(self, target: str, arguments: Any) -> Any:
        arguments = self._check_arguments(arguments)
        loop = asyncio.get_running_loop()
        tool = await loop.run_in_executor(None, catalog.describe_tool, target)
        refused = self.guard(tool, arguments)
        if refused:
            await self._announce_confirmation(refused)
            return refused
        self.acted = True
        result = await catalog.aexecute_tool(target, arguments, _workspace(self.state))
        if isinstance(result, dict):
            result = {**result, "_effect": tool["effect"]}
        return result

    async def aexecute_confirmed(self, action: Dict[str, Any]) -> Any:
        """Run a parked action the user has approved, bypassing the guard, with events."""
        call = {"id": f"confirmed-{action.get('id', 'action')}", "name": "execute_tool",
                "args": {"name": action["tool"], "arguments": action.get("arguments") or {}}}
        original_guard = self.guard
        self.guard = lambda _tool, _arguments: None
        try:
            return await self.adispatch(call)
        finally:
            self.guard = original_guard

    async def _announce_confirmation(self, refused: Dict[str, Any]) -> None:
        pending = refused.get("pending_action")
        if isinstance(pending, dict):
            await self._send({
                "type": "confirmation_required", "action_id": pending.get("id"), "tool": pending.get("tool"),
                "effect": pending.get("effect"), "arguments": pending.get("arguments") or {},
                "summary": pending.get("summary") or pending.get("tool"), "expires_in": pending.get("expires_in"),
            })

    async def _aclient(self, name: str, args: Dict[str, Any], call_id: str) -> Any:
        spec = self.client_tools.get(client_name(name))
        if spec is None:
            raise ValueError(f"The browser did not lend a tool named {client_name(name)}")
        if self.client_executor is None:
            raise ValueError("Browser tools are not available on this connection")
        pseudo_tool = {"name": client_label(name), "effect": spec.get("effect", "read"), "description": spec.get("description", "")}
        refused = self.guard(pseudo_tool, args)
        if refused:
            await self._announce_confirmation(refused)
            return refused
        self.client_executor.register(call_id)
        await self._send({"type": "client_tool_call", "call_id": call_id, "tool": client_name(name), "arguments": args})
        result = await self.client_executor.wait(call_id)
        self.acted = True
        return result


def _plain_message(merged: Any) -> AIMessage:
    """Turn an aggregated stream chunk into a plain AIMessage for the transcript."""
    return AIMessage(
        content=merged.content,
        tool_calls=list(getattr(merged, "tool_calls", None) or []),
        invalid_tool_calls=list(getattr(merged, "invalid_tool_calls", None) or []),
        id=getattr(merged, "id", None),
    )


async def _ainvoke_model(bound: Any, messages: List[Any]) -> Any:
    """One model call without token streaming (workers report, they do not talk)."""
    if hasattr(bound, "ainvoke"):
        return await bound.ainvoke(messages)
    return await asyncio.get_running_loop().run_in_executor(None, bound.invoke, messages)


async def _astep(bound: Any, messages: List[Any], emit: Emit, gate: SpeakGate, turn_id: str) -> Any:
    """One model call. Streams text deltas as `token` events when the model can stream."""

    async def token(text: str) -> None:
        if text:
            await emit({"type": "token", "text": text, "turn_id": turn_id})

    if hasattr(bound, "astream"):
        merged = None
        try:
            async for chunk in bound.astream(messages):
                merged = chunk if merged is None else merged + chunk
                await token(gate.feed(_raw_text(chunk)))
        except NotImplementedError:
            merged = None
        if merged is not None:
            await token(gate.flush())
            return _plain_message(merged)

    if hasattr(bound, "ainvoke"):
        response = await bound.ainvoke(messages)
    else:
        response = await asyncio.get_running_loop().run_in_executor(None, bound.invoke, messages)
    if not getattr(response, "tool_calls", None):
        await token(gate.feed(_raw_text(response)) + gate.flush())
    return response


def _max_steps(mode: str) -> int:
    default = _int_env("AGENT_MAX_STEPS", DEFAULT_MAX_STEPS)
    return _int_env("ASSISTANT_MAX_STEPS", default) if mode == "assistant" else default


def _model() -> Any:
    """The main loop's model: gpt-5 by default, with a bounded reasoning effort."""
    name = agent_model_name()
    kwargs = model_kwargs(name, "AGENT_REASONING_EFFORT")
    return get_llm(model=name, temperature=0, **kwargs) if name else get_llm(temperature=0)


def _worker_model() -> Any:
    """A worker's model: gpt-5-mini by default; inherits the agent's reasoning effort unless overridden."""
    name = worker_model_name()
    kwargs = model_kwargs(name, "AGENT_WORKER_REASONING_EFFORT", fallback_env="AGENT_REASONING_EFFORT")
    return get_llm(model=name, temperature=0, **kwargs) if name else get_llm(temperature=0)


def _fallback_answer(run: _Run) -> str:
    done = [step["tool"] for step in run.trace if step.get("status") == "success"]
    return "I finished the steps I could run" + (f" ({', '.join(done)})" if done else "") + " but did not produce a summary. Ask me to describe the results."


@traceable(name="agent_tool_loop", run_type="chain")
def run_agent(state: AgentState) -> Dict[str, Any]:
    """Answer one Agent-tab request with the tool-calling loop."""
    question = state["question"]
    max_steps = _max_steps("agent")
    bound = _model().bind_tools(TOOLS)

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
        results = run.dispatch_all(calls)
        for call, result in zip(calls, results):
            messages.append(ToolMessage(content=_for_model(result), tool_call_id=str(call.get("id") or call.get("name"))))
    else:
        run.trace.append(_trace("agent", f"Reached the {max_steps}-step limit; answering with what was gathered.", "skipped"))
        messages.append(HumanMessage(content="You have used every tool step for this request. Give the user your final answer now from what you already gathered; do not call tools."))
        answer = _text(bound.invoke(messages))

    if not answer:
        answer = _fallback_answer(run)

    return {
        "answer": answer,
        "sources": run.sources[:MAX_SOURCES],
        "topology": run.topology,
        "tool_trace": run.trace,
        "intent": "agent" if run.acted else "chat",
    }


@traceable(name="assistant_tool_loop", run_type="chain")
async def arun_agent(
    state: AgentState,
    *,
    emit: Emit,
    mode: str = "assistant",
    client_tools: Dict[str, Dict[str, Any]] | None = None,
    client_executor: ClientToolExecutor | None = None,
    guard: Guard | None = None,
    turn_id: str = "",
    activity: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """The assistant's turn: same loop as `run_agent`, async, streaming events through `emit`."""
    question = str(state["question"])
    max_steps = _max_steps(mode)
    specs = client_tools or {}
    loop = asyncio.get_running_loop()
    bound = _model().bind_tools(TOOLS + bind_client_tools(specs))
    system = await loop.run_in_executor(
        None, lambda: build_system_prompt(state, max_steps, mode=mode, client_tools=list(specs.values()), activity=activity)
    )
    run = _AsyncRun(state, emit=emit, guard=guard, client_tools=specs, client_executor=client_executor, turn_id=turn_id)

    user_turn = question
    resume = state.get("resume_action")
    declined = state.get("declined_action")
    if resume:
        result = await run.aexecute_confirmed(resume)
        user_turn = (f"{question}\n\n[The user confirmed. {resume['tool']} has now run; result: {_compact(result, 1500)}. "
                     "Report the outcome in one or two sentences.]")
    elif declined:
        user_turn = (f"{question}\n\n[The user declined {declined['tool']}; it did not run and must not be retried. "
                     "Acknowledge briefly and handle anything else they asked.]")

    messages: List[Any] = [SystemMessage(content=system), *_history(state), HumanMessage(content=user_turn)]
    answer = ""

    for step in range(max_steps):
        await emit({"type": "thinking", "step": step + 1, "turn_id": turn_id})
        response = await _astep(bound, messages, emit, SpeakGate(), turn_id)
        messages.append(response)
        calls = list(getattr(response, "tool_calls", None) or [])
        invalid = list(getattr(response, "invalid_tool_calls", None) or [])
        if not calls and not invalid:
            answer = _text(response)
            break
        for bad in invalid:
            messages.append(ToolMessage(
                content=json.dumps({"error": f"Malformed tool call: {bad.get('error') or 'invalid arguments'}"}),
                tool_call_id=str(bad.get("id") or "invalid"),
            ))
        results = await run.adispatch_all(calls)
        for call, result in zip(calls, results):
            messages.append(ToolMessage(content=_for_model(result), tool_call_id=str(call.get("id") or call.get("name"))))
    else:
        run.trace.append(_trace("agent", f"Reached the {max_steps}-step limit; answering with what was gathered.", "skipped"))
        messages.append(HumanMessage(content="You have used every tool step for this request. Give the user your final answer now from what you already gathered; do not call tools. End with the SPEAK: line."))
        await emit({"type": "thinking", "step": max_steps + 1, "turn_id": turn_id})
        answer = _text(await _astep(bound, messages, emit, SpeakGate(), turn_id))

    markdown, spoken = split_spoken(answer)
    if not markdown.strip():
        markdown = spoken or _fallback_answer(run)
    if not spoken:
        spoken = speakable(markdown)
    if spoken:
        await emit({"type": "speak", "text": spoken, "turn_id": turn_id})

    result = {
        "answer": markdown,
        "spoken": spoken,
        "sources": run.sources[:MAX_SOURCES],
        "topology": run.topology,
        "tool_trace": run.trace,
        "intent": "agent" if run.acted else "chat",
    }
    await emit({"type": "answer", "turn_id": turn_id, **result})
    return result


async def astream_agent(state: AgentState, **kwargs: Any):
    """`arun_agent` as an async iterator of events; the last event is the answer."""
    queue: asyncio.Queue = asyncio.Queue()
    done = object()

    async def emit(event: Dict[str, Any]) -> None:
        await queue.put(event)

    async def runner() -> None:
        try:
            await arun_agent(state, emit=emit, **kwargs)
        except Exception as exc:  # surfaced to the consumer as an event
            await queue.put({"type": "error", "message": str(exc)})
        finally:
            await queue.put(done)

    task = asyncio.create_task(runner())
    try:
        while True:
            event = await queue.get()
            if event is done:
                break
            yield event
    finally:
        if not task.done():
            task.cancel()

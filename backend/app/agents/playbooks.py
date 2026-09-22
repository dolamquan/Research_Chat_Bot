"""Playbooks: named, reusable multi-step procedures the agent runs as one tool call.

A playbook is data, not code. Each YAML file under `app/agents/playbook_defs/`
(and any directory named in AGENT_PLAYBOOKS_DIR) describes one procedure:

    name: literature_review
    title: Literature review
    description: ...
    parameters:            # JSON schema for the call's `params`
      type: object
      properties: {topic: {type: string}, top_n: {type: integer, default: 5}}
      required: [topic]
    steps:
      - id: library        # a *tool* step: one catalog or meta tool call
        title: Search the indexed library
        group: search      # consecutive steps sharing a group run concurrently
        tool: research.search_library
        arguments: {query: "{{params.topic}}", limit: 10}
      - id: rank           # an *agent* step: a worker with its own tool loop
        title: Rank the candidates
        format: json       # the worker ends with a JSON block -> steps.rank.data
        agent: |
          Given {{steps.library.result}} ... return a JSON array ...
      - id: briefs
        each: "{{steps.rank.data}}"   # fan out: one run per item, in parallel
        agent: "Brief {{item.title}} ..."
      - id: topology
        when: "{{params.ingest}}"     # skipped unless truthy
        tool: research.rebuild_topology
    report: |                         # what the main agent's final answer covers
      Write a literature review for '{{params.topic}}' ...

Templates are `{{ path }}` expressions over `params`, `steps.<id>.result`,
`steps.<id>.data`, `steps.<id>.summary`, `workspace`, and `item` / `index`
inside `each`. A value that is exactly one expression keeps its type (so a
list can be passed as a tool argument); text with embedded expressions gets
them stringified. Missing paths render as empty.

The runtime supplies the two callables: `call_tool` runs a tool through the
agent's normal dispatch (guards, events and trace included) and `run_task`
runs a worker. The runner never touches a model or the catalog itself, which
is what makes it testable with plain fakes.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Tuple

import yaml
from jsonschema import Draft202012Validator

# Not `playbooks/`: a directory sharing this module's name would shadow it on import.
BUILTIN_DIR = Path(__file__).resolve().parent / "playbook_defs"
PLAYBOOKS_DIR_ENV = "AGENT_PLAYBOOKS_DIR"

NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,48}$")
EXPRESSION = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")

DEFAULT_MAX_ITEMS = 6
INTERPOLATION_CHARS = 6000
RESULT_BUDGET_CHARS = 10000
MIN_STEP_CHARS = 800
MAX_STEP_CHARS = 6000

CallTool = Callable[[str, Dict[str, Any]], Awaitable[Any]]
RunTask = Callable[[str, str, str], Awaitable[Dict[str, Any]]]


class PlaybookError(ValueError):
    """A playbook file is malformed, or a call named a playbook or parameters that do not fit."""


@dataclass
class Step:
    id: str
    title: str
    kind: str  # "tool" | "agent"
    tool: str = ""
    arguments: Any = None
    task: str = ""
    group: str = ""
    when: Any = None
    each: Any = None
    max_items: int = DEFAULT_MAX_ITEMS
    format: str = "text"  # "json": the worker ends with a JSON block, parsed into `data`

    def to_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {"id": self.id, "title": self.title, "kind": self.kind}
        if self.kind == "tool":
            data["tool"] = self.tool
            data["arguments"] = self.arguments or {}
        else:
            data["task"] = self.task
            data["format"] = self.format
        for key in ("group", "when", "each"):
            value = getattr(self, key)
            if value not in (None, ""):
                data[key] = value
        if self.each is not None:
            data["max_items"] = self.max_items
        return data


@dataclass
class Playbook:
    name: str
    title: str
    description: str
    parameters: Dict[str, Any]
    steps: List[Step]
    report: str = ""
    source: str = ""
    tags: List[str] = field(default_factory=list)

    def signature(self) -> str:
        """`name(topic, top_n=5, ingest=false)` for the system prompt."""
        props = self.parameters.get("properties") or {}
        required = set(self.parameters.get("required") or [])
        parts = []
        for key, spec in props.items():
            spec = spec if isinstance(spec, dict) else {}
            if key in required or "default" not in spec:
                parts.append(key if key in required else f"{key}?")
            else:
                default = spec["default"]
                parts.append(f"{key}={json.dumps(default) if isinstance(default, str) else _stringify(default)}")
        return f"{self.name}({', '.join(parts)})"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name, "title": self.title, "description": self.description, "tags": list(self.tags),
            "signature": self.signature(), "parameters": self.parameters,
            "steps": [step.to_dict() for step in self.steps], "report": self.report, "source": self.source,
        }


# --- loading ----------------------------------------------------------------

_cache: Dict[str, Playbook] = {}
_cache_key: Tuple[Tuple[str, float], ...] | None = None
_load_errors: Dict[str, str] = {}


def playbook_dirs() -> List[Path]:
    dirs = [BUILTIN_DIR]
    for raw in (os.getenv(PLAYBOOKS_DIR_ENV) or "").split(os.pathsep):
        raw = raw.strip()
        if raw:
            dirs.append(Path(raw).expanduser())
    return dirs


def _files() -> List[Path]:
    files: List[Path] = []
    for directory in playbook_dirs():
        if directory.is_dir():
            files.extend(sorted(p for p in directory.iterdir() if p.suffix.lower() in (".yaml", ".yml") and p.is_file()))
    return files


def _parse_step(raw: Any, index: int) -> Step:
    if not isinstance(raw, dict):
        raise PlaybookError(f"step {index + 1} must be a mapping")
    step_id = str(raw.get("id") or "").strip()
    if not NAME_RE.match(step_id):
        raise PlaybookError(f"step {index + 1} needs an id like 'search_library' (got {step_id!r})")
    has_tool, has_agent = "tool" in raw, "agent" in raw
    if has_tool == has_agent:
        raise PlaybookError(f"step {step_id!r} must have exactly one of 'tool' or 'agent'")
    arguments = raw.get("arguments")
    if arguments is not None and not isinstance(arguments, dict):
        raise PlaybookError(f"step {step_id!r}: arguments must be a mapping")
    fmt = str(raw.get("format") or "text").strip().lower()
    if fmt not in ("text", "json"):
        raise PlaybookError(f"step {step_id!r}: format must be 'text' or 'json'")
    try:
        max_items = max(1, min(int(raw.get("max_items", DEFAULT_MAX_ITEMS)), 50))
    except (TypeError, ValueError) as exc:
        raise PlaybookError(f"step {step_id!r}: max_items must be an integer") from exc
    return Step(
        id=step_id,
        title=str(raw.get("title") or step_id.replace("_", " ").capitalize()).strip(),
        kind="tool" if has_tool else "agent",
        tool=str(raw.get("tool") or "").strip(),
        arguments=arguments,
        task=str(raw.get("agent") or "").strip(),
        group=str(raw.get("group") or "").strip(),
        when=raw.get("when"),
        each=raw.get("each"),
        max_items=max_items,
        format=fmt,
    )


def parse_playbook(raw: Any, source: str = "") -> Playbook:
    if not isinstance(raw, dict):
        raise PlaybookError("a playbook file must contain one mapping")
    name = str(raw.get("name") or "").strip()
    if not NAME_RE.match(name):
        raise PlaybookError(f"playbook name must look like 'literature_review' (got {name!r})")
    steps_raw = raw.get("steps")
    if not isinstance(steps_raw, list) or not steps_raw:
        raise PlaybookError(f"playbook {name!r} needs a non-empty list of steps")
    steps = [_parse_step(item, index) for index, item in enumerate(steps_raw)]
    ids = [step.id for step in steps]
    if len(set(ids)) != len(ids):
        raise PlaybookError(f"playbook {name!r} has duplicate step ids")
    for step in steps:
        if step.kind == "tool" and not step.tool:
            raise PlaybookError(f"playbook {name!r} step {step.id!r}: tool name is empty")
        if step.kind == "agent" and not step.task:
            raise PlaybookError(f"playbook {name!r} step {step.id!r}: agent task is empty")
    parameters = raw.get("parameters") or {"type": "object", "properties": {}}
    if not isinstance(parameters, dict):
        raise PlaybookError(f"playbook {name!r}: parameters must be a JSON schema object")
    parameters.setdefault("type", "object")
    parameters.setdefault("properties", {})
    parameters.setdefault("additionalProperties", False)
    try:
        Draft202012Validator.check_schema(parameters)
    except Exception as exc:  # jsonschema.SchemaError
        raise PlaybookError(f"playbook {name!r}: invalid parameters schema: {exc}") from exc
    tags = raw.get("tags") or []
    return Playbook(
        name=name,
        title=str(raw.get("title") or name.replace("_", " ").capitalize()).strip(),
        description=" ".join(str(raw.get("description") or "").split()),
        parameters=parameters,
        steps=steps,
        report=str(raw.get("report") or "").strip(),
        source=source,
        tags=[str(t) for t in tags] if isinstance(tags, list) else [],
    )


def load_playbooks(refresh: bool = False) -> Dict[str, Playbook]:
    """Every playbook by name; later directories override earlier ones.

    Re-reads when any file's path or mtime changed, so editing a YAML file
    takes effect on the next turn without a restart. Malformed files are
    skipped and remembered in `load_errors()` instead of taking the agent down.
    """
    global _cache, _cache_key, _load_errors
    files = _files()
    key = tuple((str(path), path.stat().st_mtime) for path in files)
    if not refresh and key == _cache_key:
        return _cache
    loaded: Dict[str, Playbook] = {}
    errors: Dict[str, str] = {}
    for path in files:
        try:
            with path.open("r", encoding="utf-8") as handle:
                raw = yaml.safe_load(handle)
            playbook = parse_playbook(raw, source=str(path))
        except (PlaybookError, yaml.YAMLError, OSError) as exc:
            errors[str(path)] = str(exc)
            continue
        loaded[playbook.name] = playbook
    _cache, _cache_key, _load_errors = loaded, key, errors
    return loaded


def load_errors() -> Dict[str, str]:
    load_playbooks()
    return dict(_load_errors)


def get_playbook(name: str) -> Playbook:
    playbooks = load_playbooks()
    playbook = playbooks.get(str(name or "").strip())
    if playbook is None:
        raise PlaybookError(f"Unknown playbook {name!r}. Available: {', '.join(sorted(playbooks)) or 'none'}.")
    return playbook


def playbook_index() -> str:
    """One line per playbook for the system prompt."""
    playbooks = load_playbooks()
    if not playbooks:
        return "- none defined"
    return "\n".join(f"- {pb.signature()}: {pb.description}" for pb in sorted(playbooks.values(), key=lambda p: p.name))


# --- parameters -------------------------------------------------------------

def prepare_params(playbook: Playbook, raw: Any) -> Dict[str, Any]:
    """Apply schema defaults, then validate; the error carries the schema so a model can retry."""
    params = dict(raw) if isinstance(raw, dict) else {}
    if raw is not None and not isinstance(raw, dict):
        raise PlaybookError(f"params for {playbook.name} must be a JSON object matching {json.dumps(playbook.parameters)}")
    for key, spec in (playbook.parameters.get("properties") or {}).items():
        if isinstance(spec, dict) and "default" in spec and key not in params:
            params[key] = spec["default"]
    errors = sorted(Draft202012Validator(playbook.parameters).iter_errors(params), key=lambda e: list(e.path))
    if errors:
        where = "/".join(str(p) for p in errors[0].absolute_path) or "(root)"
        raise PlaybookError(
            f"Invalid params for playbook {playbook.name} at {where}: {errors[0].message}. "
            f"Expected: {json.dumps(playbook.parameters)[:3000]}"
        )
    return params


# --- templates ---------------------------------------------------------------

def _lookup(path: str, context: Dict[str, Any]) -> Any:
    current: Any = context
    for part in path.split("."):
        part = part.strip()
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and part.isdigit():
            index = int(part)
            current = current[index] if index < len(current) else None
        else:
            return None
        if current is None:
            return None
    return current


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    text = json.dumps(value, default=str, ensure_ascii=False)
    if len(text) > INTERPOLATION_CHARS:
        text = text[: INTERPOLATION_CHARS - 3] + "..."
    return text


def render(value: Any, context: Dict[str, Any]) -> Any:
    """Substitute `{{ path }}` expressions; a lone expression keeps the value's type."""
    if isinstance(value, str):
        whole = EXPRESSION.fullmatch(value.strip())
        if whole:
            return _lookup(whole.group(1), context)
        return EXPRESSION.sub(lambda match: _stringify(_lookup(match.group(1), context)), value)
    if isinstance(value, dict):
        return {key: render(item, context) for key, item in value.items()}
    if isinstance(value, list):
        return [render(item, context) for item in value]
    return value


def truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip().lower() not in ("", "false", "0", "no", "off", "none", "null")
    if isinstance(value, (int, float)):
        return value != 0
    return bool(value)


def extract_json(text: str) -> Any:
    """The JSON a worker was asked to end with: the last fenced block, else a trailing object/array."""
    if not text:
        return None
    blocks = re.findall(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.IGNORECASE)
    candidates = [block.strip() for block in reversed(blocks) if block.strip()]
    stripped = text.strip()
    for opener, closer in (("[", "]"), ("{", "}")):
        start = stripped.rfind(opener) if not stripped.endswith(closer) else stripped.find(opener)
        if start != -1 and stripped.endswith(closer):
            candidates.append(stripped[start:])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


# --- execution ----------------------------------------------------------------

def _brief(result: Any) -> str:
    if isinstance(result, dict):
        if result.get("error"):
            return str(result["error"])[:200]
        if isinstance(result.get("summary"), str) and result["summary"].strip():
            return result["summary"].strip()[:200]
        counts = [f"{len(value)} {key}" for key, value in result.items() if isinstance(value, list)]
        if counts:
            return ", ".join(counts[:4])
        return f"{len(result)} fields"
    if isinstance(result, list):
        return f"{len(result)} items"
    if isinstance(result, str):
        # A worker report may end with the JSON block it was asked for; the summary is the prose.
        prose = re.sub(r"```[\s\S]*?```", " ", result)
        return " ".join(prose.split())[:200]
    return str(result)[:200]


def _clip(value: Any, limit: int) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[: limit - 3] + "..."
    text = json.dumps(value, default=str, ensure_ascii=False)
    if len(text) <= limit:
        return value
    return text[: limit - 3] + "..."


def _omit_empty(arguments: Any) -> Dict[str, Any]:
    if not isinstance(arguments, dict):
        return {}
    return {key: value for key, value in arguments.items() if value not in (None, "")}


class PlaybookRun:
    def __init__(
        self,
        playbook: Playbook,
        params: Dict[str, Any],
        *,
        call_tool: CallTool,
        run_task: RunTask,
        workspace: Dict[str, Any] | None = None,
        concurrency: int = 4,
    ) -> None:
        self.playbook = playbook
        self.params = params
        self.call_tool = call_tool
        self.run_task = run_task
        self.workspace = workspace or {}
        self.semaphore = asyncio.Semaphore(max(1, concurrency))
        self.records: List[Dict[str, Any]] = []
        self.steps_ctx: Dict[str, Dict[str, Any]] = {}

    def _context(self, **extra: Any) -> Dict[str, Any]:
        return {"params": self.params, "steps": self.steps_ctx, "workspace": self.workspace, **extra}

    async def _run_once(self, step: Step, context: Dict[str, Any]) -> Dict[str, Any]:
        async with self.semaphore:
            if step.kind == "tool":
                arguments = _omit_empty(render(step.arguments or {}, context))
                result = await self.call_tool(step.tool, arguments)
                if isinstance(result, dict) and result.get("requires_confirmation"):
                    return {"status": "skipped", "summary": str(result.get("error") or "needs confirmation")[:300],
                            "result": result, "data": None, "needs_confirmation": result.get("pending_action") or {"tool": step.tool, "arguments": arguments}}
                if isinstance(result, dict) and result.get("error") and len(result) == 1:
                    return {"status": "error", "summary": str(result["error"])[:300], "result": result, "data": None}
                return {"status": "success", "summary": _brief(result), "result": result, "data": result}
            task = str(render(step.task, context))
            outcome = await self.run_task(task, step.title, step.format)
            status = "error" if outcome.get("status") == "error" else "success"
            report = outcome.get("report") or ""
            return {"status": status, "summary": _brief(report) if status == "success" else str(outcome.get("report") or "worker failed")[:300],
                    "result": report, "data": outcome.get("data")}

    async def _run_step(self, step: Step) -> Dict[str, Any]:
        record: Dict[str, Any] = {"id": step.id, "title": step.title, "kind": step.kind}
        base = self._context()
        if step.when is not None and not truthy(render(step.when, base)):
            record.update(status="skipped", summary="condition not met", result=None, data=None)
            return record
        if step.each is not None:
            items = render(step.each, base)
            if not isinstance(items, list) or not items:
                record.update(status="skipped", summary="nothing to iterate over", result=[], data=[])
                return record
            items = items[: step.max_items]
            outcomes = await asyncio.gather(*(
                self._run_once(step, self._context(item=item, index=index)) for index, item in enumerate(items)
            ))
            ok = sum(1 for o in outcomes if o["status"] == "success")
            record.update(
                status="success" if ok else ("skipped" if any(o.get("needs_confirmation") for o in outcomes) else "error"),
                summary=f"{ok}/{len(items)} items" if ok else (outcomes[0]["summary"] if outcomes else "no items"),
                result=[o["result"] for o in outcomes], data=[o["data"] for o in outcomes], items=len(items),
            )
            needs = [o["needs_confirmation"] for o in outcomes if o.get("needs_confirmation")]
            if needs:
                record["needs_confirmation"] = needs[0]
            return record
        record.update(await self._run_once(step, base))
        return record

    def _remember(self, record: Dict[str, Any]) -> None:
        self.records.append(record)
        self.steps_ctx[record["id"]] = {
            "status": record.get("status"), "summary": record.get("summary"),
            "result": record.get("result"), "data": record.get("data"),
        }

    async def run(self) -> Dict[str, Any]:
        steps = self.playbook.steps
        index = 0
        stopped: Dict[str, Any] | None = None
        while index < len(steps) and stopped is None:
            step = steps[index]
            batch = [step]
            if step.group:
                while index + len(batch) < len(steps) and steps[index + len(batch)].group == step.group:
                    batch.append(steps[index + len(batch)])
            records = await asyncio.gather(*(self._run_step(item) for item in batch)) if len(batch) > 1 else [await self._run_step(step)]
            for record in records:
                self._remember(record)
                if record.get("needs_confirmation") and stopped is None:
                    stopped = record
            index += len(batch)
        return self._payload(stopped, remaining=steps[index:])

    def _payload(self, stopped: Dict[str, Any] | None, remaining: List[Step]) -> Dict[str, Any]:
        per_step = max(MIN_STEP_CHARS, min(MAX_STEP_CHARS, RESULT_BUDGET_CHARS // max(1, len(self.records))))
        counts = {status: sum(1 for r in self.records if r.get("status") == status) for status in ("success", "error", "skipped")}
        summary = f"{counts['success']} of {len(self.playbook.steps)} steps succeeded"
        if counts["error"]:
            summary += f", {counts['error']} failed"
        if counts["skipped"]:
            summary += f", {counts['skipped']} skipped"
        payload: Dict[str, Any] = {
            "playbook": self.playbook.name,
            "title": self.playbook.title,
            "status": "stopped" if stopped else "completed",
            "summary": summary,
            "report_instructions": render(self.playbook.report, self._context()) if self.playbook.report else "",
        }
        if stopped:
            payload["needs_confirmation"] = stopped.get("needs_confirmation")
            payload["stopped_reason"] = (
                f"Step '{stopped['title']}' needs the user's confirmation and has NOT run; the playbook stopped there. "
                f"Not run: {', '.join(s.title for s in remaining) or 'nothing else'}. Ask the user to confirm; afterwards, "
                "finish the remaining steps yourself or run the playbook again."
            )
        payload["steps"] = [
            {"id": r["id"], "title": r["title"], "kind": r["kind"], "status": r.get("status"), "summary": r.get("summary"),
             **({"items": r["items"]} if "items" in r else {}),
             "result": _clip(r.get("result"), per_step) if r.get("result") not in (None, "", [], {}) else r.get("result")}
            for r in self.records
        ]
        return payload


async def run_playbook(
    playbook: Playbook,
    params: Dict[str, Any],
    *,
    call_tool: CallTool,
    run_task: RunTask,
    workspace: Dict[str, Any] | None = None,
    concurrency: int = 4,
) -> Dict[str, Any]:
    run = PlaybookRun(playbook, params, call_tool=call_tool, run_task=run_task, workspace=workspace, concurrency=concurrency)
    return await run.run()

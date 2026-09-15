"""What the user is looking at, as the assistant hears about it.

The browser sends a `workspace` object on every turn. Views add keys freely
(the model accepts extras), but the keys below are the ones the assistant
prompt renders as prose so the model reads "the user is on the Notes view
editing 'X'" instead of a JSON dump.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List

from pydantic import BaseModel, ConfigDict, Field

VIEW_LABELS = {
    "chat": "Chat",
    "library": "Paper Library",
    "crawler": "Crawler",
    "reddit": "Reddit",
    "notes": "Notes",
    "console": "Console (tool catalog, activity, jobs, diagnostics)",
    "graph": "Graph RAG explorer",
    # Sent by browsers that predate the Console; same page.
    "agent": "Console (tool catalog, activity, jobs, diagnostics)",
    "graph": "Graph RAG",
    "evaluation": "Evaluation",
    "visualizer": "Visualizer",
}


class PaperFocus(BaseModel):
    model_config = ConfigDict(extra="allow")
    article_id: str | None = None
    title: str | None = None
    source: str | None = None
    cluster_label: str | None = None


class ReaderFocus(BaseModel):
    model_config = ConfigDict(extra="allow")
    source: str | None = None
    title: str | None = None
    page: int | None = None
    total_pages: int | None = None
    selected_text: str | None = None


class NoteFocus(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str | None = None
    title: str | None = None
    folder: str | None = None


class ClusterFocus(BaseModel):
    model_config = ConfigDict(extra="allow")
    cluster_id: int | None = None
    cluster_label: str | None = None


class VisualizerFocus(BaseModel):
    model_config = ConfigDict(extra="allow")
    article_id: str | None = None
    title: str | None = None
    viz_id: str | None = None


class LibraryFilter(BaseModel):
    model_config = ConfigDict(extra="allow")
    domain: str | None = None
    category: str | None = None


class ChatRef(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str | None = None
    title: str | None = None


class ClientInfo(BaseModel):
    model_config = ConfigDict(extra="allow")
    source: str | None = None  # "voice" | "text"
    tts: bool | None = None
    locale: str | None = None
    local_time: str | None = None


class WorkspaceContext(BaseModel):
    """Everything the browser knows about the user's current focus."""

    model_config = ConfigDict(extra="allow")

    active_view: str | None = None
    selected_paper: PaperFocus | None = None
    reader: ReaderFocus | None = None
    open_note: NoteFocus | None = None
    selected_cluster: ClusterFocus | None = None
    visualizer: VisualizerFocus | None = None
    library_filter: LibraryFilter | None = None
    library_search: str | None = None
    pinned_sources: List[Dict[str, Any]] = Field(default_factory=list)
    active_chat_session: ChatRef | None = None
    context_mode: str | None = None
    retrieval_strategy: str | None = None
    visible_summary: str | None = None
    client: ClientInfo | None = None


_KNOWN = set(WorkspaceContext.model_fields)
# Flat keys the Agent tab already sends; they stay meaningful to `app.context`.
_LEGACY = {"document_source", "cluster_id", "domain", "category", "selected_paper"}


def normalize_workspace(raw: Dict[str, Any] | None) -> Dict[str, Any]:
    """Validate the known keys, keep the unknown ones, drop empty values."""
    if not raw:
        return {}
    try:
        model = WorkspaceContext.model_validate(raw)
        data = model.model_dump(exclude_none=True)
    except Exception:
        data = {k: v for k, v in raw.items() if v not in (None, "", [], {})}
    return {k: v for k, v in data.items() if v not in (None, "", [], {})}


def _quote(value: Any) -> str:
    return f"'{value}'" if value not in (None, "") else "an untitled item"


def render_workspace(workspace: Dict[str, Any] | None) -> str:
    """Prose bullets describing the user's current focus, for the system prompt."""
    ws = normalize_workspace(workspace)
    if not ws:
        return "Nothing is selected; the user is looking at the default view and the whole library is in scope."

    lines: List[str] = []
    view = ws.get("active_view")
    if view:
        lines.append(f"- The user is on the {VIEW_LABELS.get(view, view)} view.")

    paper = ws.get("selected_paper") or {}
    if paper:
        detail = f" (article_id {paper['article_id']})" if paper.get("article_id") else ""
        detail += f", file {paper['source']}" if paper.get("source") else ""
        lines.append(f"- Selected paper: {_quote(paper.get('title'))}{detail}.")

    reader = ws.get("reader") or {}
    if reader:
        page = f" on page {reader['page']}" if reader.get("page") else ""
        total = f" of {reader['total_pages']}" if reader.get("total_pages") and reader.get("page") else ""
        title = reader.get("title") or reader.get("source")
        lines.append(f"- The PDF reader shows {_quote(title)}{page}{total}.")
        if reader.get("selected_text"):
            lines.append(f"- Text selected in the reader: \"{str(reader['selected_text'])[:300]}\"")

    note = ws.get("open_note") or {}
    if note:
        folder = f" in folder {_quote(note['folder'])}" if note.get("folder") else ""
        ident = f" (note_id {note['id']})" if note.get("id") else ""
        lines.append(f"- Open note: {_quote(note.get('title'))}{ident}{folder}.")

    cluster = ws.get("selected_cluster") or {}
    if cluster:
        ident = f" (cluster_id {cluster['cluster_id']})" if cluster.get("cluster_id") is not None else ""
        lines.append(f"- Selected topology cluster: {_quote(cluster.get('cluster_label'))}{ident}.")

    viz = ws.get("visualizer") or {}
    if viz:
        ident = f" (viz_id {viz['viz_id']})" if viz.get("viz_id") else ""
        lines.append(f"- Visualizer is showing {_quote(viz.get('title'))}{ident}.")

    library_filter = ws.get("library_filter") or {}
    filters = [f"{k} {v}" for k, v in library_filter.items() if v]
    if ws.get("library_search"):
        filters.append(f"search '{ws['library_search']}'")
    if filters:
        lines.append(f"- Library filter: {', '.join(filters)}.")

    pinned = ws.get("pinned_sources") or []
    if pinned:
        titles = ", ".join(_quote(p.get("title") or p.get("source")) for p in pinned[:5] if isinstance(p, dict))
        lines.append(f"- Pinned passages ({len(pinned)}): {titles}.")

    chat = ws.get("active_chat_session") or {}
    if chat:
        lines.append(f"- Active chat session: {_quote(chat.get('title'))}.")

    modes = []
    if ws.get("context_mode"):
        modes.append(f"context mode {ws['context_mode']}")
    if ws.get("retrieval_strategy"):
        modes.append(f"retrieval {ws['retrieval_strategy']}")
    if modes:
        lines.append(f"- Chat settings: {', '.join(modes)}.")

    if ws.get("visible_summary"):
        lines.append(f"- On screen: {str(ws['visible_summary'])[:1200]}")

    client = ws.get("client") or {}
    if client.get("source") == "voice":
        lines.append("- This message was spoken aloud; the user is not necessarily looking at the panel.")

    extras = {k: v for k, v in ws.items() if k not in _KNOWN and k not in _LEGACY}
    if extras:
        lines.append(f"- Other context: {json.dumps(extras, default=str, ensure_ascii=False)[:800]}")

    return "\n".join(lines) if lines else "Nothing is selected; the whole library is in scope."

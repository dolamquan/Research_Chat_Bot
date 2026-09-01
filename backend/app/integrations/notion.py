"""Notion integration service.

All outbound Notion traffic lives here: database schema introspection, a
markdown -> Notion block converter, image upload through the File Upload API,
and an idempotent page upsert (create the first time, update in place after).
The MCP bridge and agent tools delegate to this module.
"""

import os
import re
from typing import Any, Dict, List, Tuple

import requests

NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"

# Notion rejects requests with more than 100 children; stay under it so the
# provenance footer always fits.
MAX_CHILDREN_PER_REQUEST = 90
MAX_RICH_TEXT_LENGTH = 2000


class NotionError(Exception):
    """A typed Notion failure the caller can surface meaningfully."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _api_key() -> str:
    key = os.getenv("NOTION_API_KEY", "").strip()
    if not key:
        raise NotionError(
            "not_configured",
            "NOTION_API_KEY is not set in backend/.env.",
        )
    return key


def _headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {_api_key()}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def _request(
    method: str,
    path: str,
    *,
    json_body: Dict[str, Any] | None = None,
    timeout: int = 30,
) -> Dict[str, Any]:
    try:
        response = requests.request(
            method,
            f"{NOTION_API}{path}",
            headers=_headers(),
            json=json_body,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise NotionError("network", f"Could not reach the Notion API: {exc}") from exc

    if response.status_code == 401:
        raise NotionError("unauthorized", "Notion rejected the API key (401).")
    if response.status_code == 404:
        raise NotionError(
            "not_found",
            "Notion object not found (404). Check the database id and make sure "
            "the database is shared with your integration.",
        )
    if response.status_code == 429:
        raise NotionError("rate_limited", "Notion rate limit hit (429). Try again shortly.")
    if response.status_code >= 400:
        detail = response.text[:500]
        raise NotionError("validation", f"Notion rejected the request ({response.status_code}): {detail}")
    if not response.content:
        return {}
    return response.json()


# --- markdown -> Notion blocks --------------------------------------------------

_INLINE_PATTERN = re.compile(
    r"(\*\*(?P<bold>.+?)\*\*)"
    r"|(\*(?P<italic>[^*]+)\*)"
    r"|(`(?P<code>[^`]+)`)"
    r"|(\[(?P<link_text>[^\]]+)\]\((?P<link_url>https?://[^)\s]+)\))"
)


def _plain_rich_text(text: str, annotations: Dict[str, bool] | None = None, link: str | None = None) -> Dict[str, Any]:
    item: Dict[str, Any] = {
        "type": "text",
        "text": {"content": text},
    }
    if link:
        item["text"]["link"] = {"url": link}
    if annotations:
        item["annotations"] = annotations
    return item


def _split_long(text: str) -> List[str]:
    return [
        text[index : index + MAX_RICH_TEXT_LENGTH]
        for index in range(0, len(text), MAX_RICH_TEXT_LENGTH)
    ] or [""]


def _rich_text(text: str) -> List[Dict[str, Any]]:
    """Parse inline markdown (bold, italic, code, links) into rich_text items."""
    items: List[Dict[str, Any]] = []
    cursor = 0

    for match in _INLINE_PATTERN.finditer(text):
        if match.start() > cursor:
            for chunk in _split_long(text[cursor : match.start()]):
                if chunk:
                    items.append(_plain_rich_text(chunk))

        if match.group("bold") is not None:
            items.append(_plain_rich_text(match.group("bold")[:MAX_RICH_TEXT_LENGTH], {"bold": True}))
        elif match.group("italic") is not None:
            items.append(_plain_rich_text(match.group("italic")[:MAX_RICH_TEXT_LENGTH], {"italic": True}))
        elif match.group("code") is not None:
            items.append(_plain_rich_text(match.group("code")[:MAX_RICH_TEXT_LENGTH], {"code": True}))
        elif match.group("link_text") is not None:
            items.append(
                _plain_rich_text(
                    match.group("link_text")[:MAX_RICH_TEXT_LENGTH],
                    link=match.group("link_url"),
                )
            )
        cursor = match.end()

    if cursor < len(text):
        for chunk in _split_long(text[cursor:]):
            if chunk:
                items.append(_plain_rich_text(chunk))

    return items or [_plain_rich_text("")]


def _block(block_type: str, rich_text: List[Dict[str, Any]], **extra: Any) -> Dict[str, Any]:
    return {
        "object": "block",
        "type": block_type,
        block_type: {"rich_text": rich_text, **extra},
    }


def heading_block(text: str, level: int = 2) -> Dict[str, Any]:
    level = min(max(level, 1), 3)
    return _block(f"heading_{level}", _rich_text(text[:MAX_RICH_TEXT_LENGTH]))


def code_block(code: str, language: str = "plain text") -> Dict[str, Any]:
    rich_text = [_plain_rich_text(chunk) for chunk in _split_long(code)]
    return {
        "object": "block",
        "type": "code",
        "code": {"language": language, "rich_text": rich_text},
    }


def markdown_to_blocks(markdown: str) -> List[Dict[str, Any]]:
    """Convert markdown into Notion blocks: headings, lists, quotes, code
    fences, dividers, and paragraphs with inline bold/italic/code/links."""
    blocks: List[Dict[str, Any]] = []
    lines = markdown.replace("\r\n", "\n").split("\n")
    paragraph_lines: List[str] = []
    index = 0

    def flush_paragraph() -> None:
        text = " ".join(part.strip() for part in paragraph_lines).strip()
        paragraph_lines.clear()
        if text:
            blocks.append(_block("paragraph", _rich_text(text)))

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        fence = re.match(r"^```(\w[\w+ -]*)?\s*$", stripped)
        if fence:
            flush_paragraph()
            language = (fence.group(1) or "plain text").strip().lower()
            code_lines: List[str] = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code_lines.append(lines[index])
                index += 1
            index += 1  # Skip the closing fence.
            blocks.append(code_block("\n".join(code_lines), language=language))
            continue

        if not stripped:
            flush_paragraph()
            index += 1
            continue

        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            flush_paragraph()
            blocks.append(heading_block(heading.group(2), level=min(len(heading.group(1)), 3)))
            index += 1
            continue

        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
            flush_paragraph()
            blocks.append({"object": "block", "type": "divider", "divider": {}})
            index += 1
            continue

        bullet = re.match(r"^[-*+]\s+(.*)$", stripped)
        if bullet:
            flush_paragraph()
            blocks.append(_block("bulleted_list_item", _rich_text(bullet.group(1))))
            index += 1
            continue

        numbered = re.match(r"^\d+[.)]\s+(.*)$", stripped)
        if numbered:
            flush_paragraph()
            blocks.append(_block("numbered_list_item", _rich_text(numbered.group(1))))
            index += 1
            continue

        quote = re.match(r"^>\s?(.*)$", stripped)
        if quote:
            flush_paragraph()
            blocks.append(_block("quote", _rich_text(quote.group(1))))
            index += 1
            continue

        paragraph_lines.append(line)
        index += 1

    flush_paragraph()
    return blocks


# --- database schema ------------------------------------------------------------


def get_database(database_id: str) -> Dict[str, Any]:
    return _request("GET", f"/databases/{database_id}")


def database_summary(database: Dict[str, Any]) -> Dict[str, Any]:
    """Compact schema: db title plus {property name: type}."""
    title = "".join(
        item.get("plain_text", "") for item in database.get("title", [])
    ).strip()
    properties = {
        name: prop.get("type", "")
        for name, prop in (database.get("properties") or {}).items()
    }
    return {"title": title or "Untitled database", "properties": properties}


def _find_property(properties: Dict[str, str], wanted_type: str, preferred_names: List[str]) -> str:
    lowered = {name.lower(): name for name, ptype in properties.items() if ptype == wanted_type}
    for preferred in preferred_names:
        if preferred in lowered:
            return lowered[preferred]
    for name, ptype in properties.items():
        if ptype == wanted_type:
            return name
    return ""


def build_properties(
    schema: Dict[str, Any],
    *,
    title: str,
    tags: List[str] | None = None,
    source_url: str = "",
    note_type: str = "",
) -> Dict[str, Any]:
    """Map note fields onto whatever properties the target database has.

    Only properties that exist in the schema are written, so a database with
    just a title column still works.
    """
    properties: Dict[str, str] = schema.get("properties") or {}
    payload: Dict[str, Any] = {}

    title_property = (
        _find_property(properties, "title", ["name", "title"])
        or os.getenv("NOTION_TITLE_PROPERTY", "").strip()
        or "Name"
    )
    payload[title_property] = {
        "title": [_plain_rich_text(title[:MAX_RICH_TEXT_LENGTH])]
    }

    if tags:
        tag_property = _find_property(properties, "multi_select", ["tags", "topics", "labels"])
        if tag_property:
            payload[tag_property] = {
                "multi_select": [{"name": tag[:100]} for tag in tags[:10]]
            }

    if source_url and re.match(r"^https?://", source_url):
        url_property = _find_property(properties, "url", ["source", "url", "link"])
        if url_property:
            payload[url_property] = {"url": source_url}

    if note_type:
        select_property = _find_property(properties, "select", ["type", "kind"])
        if select_property:
            payload[select_property] = {"select": {"name": note_type[:100]}}

    return payload


# --- file uploads ---------------------------------------------------------------


def upload_file(name: str, data: bytes, mime_type: str) -> str:
    """Upload bytes through the Notion File Upload API; returns the upload id."""
    created = _request(
        "POST",
        "/file_uploads",
        json_body={
            "mode": "single_part",
            "filename": name[:200] or "attachment.png",
            "content_type": mime_type,
        },
    )
    upload_id = created.get("id", "")
    if not upload_id:
        raise NotionError("upload_failed", "Notion did not return a file upload id.")

    try:
        response = requests.post(
            f"{NOTION_API}/file_uploads/{upload_id}/send",
            headers={
                "Authorization": f"Bearer {_api_key()}",
                "Notion-Version": NOTION_VERSION,
            },
            files={"file": (name or "attachment.png", data, mime_type)},
            timeout=60,
        )
    except requests.RequestException as exc:
        raise NotionError("network", f"Could not upload the file to Notion: {exc}") from exc

    if response.status_code >= 400:
        raise NotionError(
            "upload_failed",
            f"Notion rejected the file upload ({response.status_code}): {response.text[:300]}",
        )
    return upload_id


def image_block_from_upload(upload_id: str) -> Dict[str, Any]:
    return {
        "object": "block",
        "type": "image",
        "image": {"type": "file_upload", "file_upload": {"id": upload_id}},
    }


# --- page upsert ----------------------------------------------------------------


def _list_child_block_ids(page_id: str) -> List[str]:
    block_ids: List[str] = []
    cursor = ""
    while True:
        path = f"/blocks/{page_id}/children?page_size=100"
        if cursor:
            path += f"&start_cursor={cursor}"
        result = _request("GET", path)
        block_ids.extend(
            block.get("id", "") for block in result.get("results", []) if block.get("id")
        )
        if not result.get("has_more"):
            return block_ids
        cursor = result.get("next_cursor", "")


def _append_children(page_id: str, children: List[Dict[str, Any]]) -> None:
    for start in range(0, len(children), MAX_CHILDREN_PER_REQUEST):
        _request(
            "PATCH",
            f"/blocks/{page_id}/children",
            json_body={"children": children[start : start + MAX_CHILDREN_PER_REQUEST]},
        )


def _replace_children(page_id: str, children: List[Dict[str, Any]]) -> None:
    for block_id in _list_child_block_ids(page_id):
        _request("DELETE", f"/blocks/{block_id}")
    _append_children(page_id, children)


def _page_exists(page_id: str) -> bool:
    try:
        page = _request("GET", f"/pages/{page_id}")
    except NotionError as exc:
        if exc.code == "not_found":
            return False
        raise
    return not page.get("archived", False)


def upsert_page(
    *,
    database_id: str,
    title: str,
    children: List[Dict[str, Any]],
    tags: List[str] | None = None,
    source_url: str = "",
    note_type: str = "",
    existing_page_id: str = "",
    schema: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Create or update one database page. Returns {page_id, url, updated}."""
    resolved_schema = schema or database_summary(get_database(database_id))
    properties = build_properties(
        resolved_schema,
        title=title,
        tags=tags,
        source_url=source_url,
        note_type=note_type,
    )

    if existing_page_id and _page_exists(existing_page_id):
        page = _request(
            "PATCH",
            f"/pages/{existing_page_id}",
            json_body={"properties": properties},
        )
        _replace_children(existing_page_id, children)
        return {
            "page_id": existing_page_id,
            "url": page.get("url", ""),
            "updated": True,
        }

    page = _request(
        "POST",
        "/pages",
        json_body={
            "parent": {"database_id": database_id},
            "properties": properties,
            "children": children[:MAX_CHILDREN_PER_REQUEST],
        },
    )
    page_id = page.get("id", "")
    if len(children) > MAX_CHILDREN_PER_REQUEST and page_id:
        _append_children(page_id, children[MAX_CHILDREN_PER_REQUEST:])

    return {"page_id": page_id, "url": page.get("url", ""), "updated": False}


# --- note export ----------------------------------------------------------------


def build_note_children(
    *,
    markdown: str,
    selected_text: str = "",
    source_label: str = "",
    images: List[Tuple[str, bytes, str]] | None = None,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Assemble page children for a note. Returns (blocks, warnings)."""
    children: List[Dict[str, Any]] = []
    warnings: List[str] = []

    if selected_text.strip():
        children.append(heading_block("Highlighted passage", level=2))
        children.append(_block("quote", _rich_text(selected_text.strip()[:MAX_RICH_TEXT_LENGTH])))

    if markdown.strip():
        if selected_text.strip():
            children.append(heading_block("Note", level=2))
        children.extend(markdown_to_blocks(markdown))

    for name, data, mime_type in images or []:
        try:
            upload_id = upload_file(name, data, mime_type)
            children.append(image_block_from_upload(upload_id))
        except NotionError as exc:
            warnings.append(f"Skipped attachment '{name}': {exc.message}")

    footer = f"Exported from Zoetrope"
    if source_label:
        footer += f" - {source_label}"
    children.append(_block("paragraph", [_plain_rich_text(footer)]))

    return children, warnings


def default_database_id() -> str:
    return os.getenv("NOTION_DATABASE_ID", "").strip()


# --- MCP bridge compatibility -----------------------------------------------------


def create_research_page(args: Dict[str, Any]) -> Dict[str, Any]:
    """Legacy MCP entry point: create/update a research page from loose args."""
    database_id = str(args.get("database_id") or default_database_id()).strip()
    if not database_id:
        raise NotionError(
            "not_configured",
            "database_id is required or NOTION_DATABASE_ID must be configured.",
        )

    title = str(args.get("title") or "Research note").strip() or "Research note"
    markdown = str(args.get("summary") or args.get("content") or "").strip()
    source_url = str(args.get("source_url") or args.get("url") or "").strip()
    tags = [str(tag).strip() for tag in args.get("tags") or [] if str(tag).strip()]

    body = markdown
    if source_url:
        body += f"\n\n**Source:** {source_url}"

    children, warnings = build_note_children(markdown=body)
    result = upsert_page(
        database_id=database_id,
        title=title,
        children=children,
        tags=tags,
        source_url=source_url,
        note_type="research",
        existing_page_id=str(args.get("existing_page_id") or "").strip(),
    )
    result["title"] = title
    result["warnings"] = warnings
    return result


def create_visualization_page(args: Dict[str, Any]) -> Dict[str, Any]:
    """Legacy MCP entry point: create a page with a Mermaid diagram."""
    database_id = str(args.get("database_id") or default_database_id()).strip()
    if not database_id:
        raise NotionError(
            "not_configured",
            "database_id is required or NOTION_DATABASE_ID must be configured.",
        )

    title = str(args.get("title") or "Research visualization").strip()
    mermaid = str(args.get("mermaid") or args.get("diagram") or "").strip()
    explanation = str(args.get("explanation") or args.get("summary") or "").strip()
    source_url = str(args.get("source_url") or args.get("url") or "").strip()
    visualization_type = str(args.get("visualization_type") or "mermaid").strip()
    tags = [str(tag).strip() for tag in args.get("tags") or [] if str(tag).strip()]

    if not mermaid:
        raise NotionError("validation", "mermaid diagram text is required.")

    children: List[Dict[str, Any]] = [
        heading_block("Visualization", level=2),
        code_block(mermaid, language="mermaid"),
        heading_block("Explanation", level=2),
        *markdown_to_blocks(explanation or "No explanation provided."),
    ]
    if source_url:
        children.extend(markdown_to_blocks(f"**Source:** {source_url}"))
    children.append(
        _block("paragraph", [_plain_rich_text("Exported from Zoetrope")])
    )

    try:
        result = upsert_page(
            database_id=database_id,
            title=title,
            children=children,
            tags=tags,
            source_url=source_url,
            note_type=visualization_type,
        )
    except NotionError as exc:
        if "mermaid" not in exc.message.lower():
            raise
        children[1] = code_block(mermaid, language="plain text")
        result = upsert_page(
            database_id=database_id,
            title=title,
            children=children,
            tags=tags,
            source_url=source_url,
            note_type=visualization_type,
        )

    result["title"] = title
    result["diagram_format"] = "mermaid"
    return result

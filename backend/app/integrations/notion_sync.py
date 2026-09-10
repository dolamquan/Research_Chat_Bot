"""Export stored notes to Notion, idempotently.

A note remembers the Notion page it was exported to (`notion_page_id`) and a
hash of what was sent (`synced_content_hash`). Re-exporting updates the same
page instead of duplicating it; editing a note after export flips its
`notion_dirty` flag so the UI can show "edited since sync".
"""

from typing import Any, Dict, List, Tuple

from app.integrations.notion import (
    NotionError,
    build_note_children,
    database_summary,
    default_database_id,
    get_database,
    upsert_page,
)
from app.storage import notes as notes_store


def resolve_target(
    *,
    target_id: str = "",
    database_id: str = "",
) -> Tuple[str, Dict[str, Any] | None]:
    """Resolve where to export: a saved target, an explicit database id, or
    the NOTION_DATABASE_ID fallback. Returns (database_id, cached_schema)."""
    if target_id:
        target = notes_store.get_notion_target(target_id)
        return target["database_id"], target.get("schema") or None

    resolved = database_id.strip() or default_database_id()
    if not resolved:
        raise NotionError(
            "not_configured",
            "Pick a Notion target, pass a database_id, or set NOTION_DATABASE_ID.",
        )
    return resolved, None


def register_target(name: str, database_id: str) -> Dict[str, Any]:
    """Validate a database against the live API, then save it as a target."""
    schema = database_summary(get_database(database_id))
    return notes_store.save_notion_target(
        name=name or schema["title"],
        database_id=database_id,
        title_property=next(
            (
                prop_name
                for prop_name, prop_type in schema["properties"].items()
                if prop_type == "title"
            ),
            "",
        ),
        schema=schema,
    )


def _note_source_label(note: Dict[str, Any]) -> str:
    parts = [note.get("source_title") or note.get("source_ref") or ""]
    if note.get("page"):
        parts.append(f"p.{note['page']}")
    return " ".join(part for part in parts if part).strip()


def _scene_content(scene: Any) -> Any:
    if not isinstance(scene, dict):
        return None
    elements = [item for item in scene.get("elements", []) if not item.get("isDeleted")]
    if not elements:
        return None
    return (elements, (scene.get("appState") or {}).get("viewBackgroundColor") or "#ffffff", scene.get("files") or {})


def _note_images(note_id: str, sketch: Any = None) -> List[Tuple[str, bytes, str]]:
    attachments = notes_store.list_attachment_blobs(note_id)
    current_scene = _scene_content(sketch)
    if current_scene and not any(_scene_content(item.get("scene")) == current_scene for item in attachments):
        raise NotionError("sketch_not_prepared", "The current sketch needs an image preview. Open this note in the app and export again.")
    return [
        (
            attachment.get("name") or f"attachment-{attachment['attachment_id'][:8]}.png",
            attachment["data"],
            attachment.get("mime_type") or "image/png",
        )
        for attachment in attachments
    ]


def export_note(
    note_id: str,
    *,
    target_id: str = "",
    database_id: str = "",
) -> Dict[str, Any]:
    """Export one stored note to Notion and record the sync state.

    Returns the updated note plus {page_id, url, updated, warnings}.
    """
    note = notes_store.get_note(note_id)
    resolved_db, cached_schema = resolve_target(
        target_id=target_id, database_id=database_id
    )

    title = (
        note.get("title")
        or note.get("source_title")
        or (note.get("body_md") or note.get("selected_text") or "Research note")[:80]
    ).strip() or "Research note"

    children, warnings = build_note_children(
        markdown=note.get("body_md", ""),
        selected_text=note.get("selected_text", ""),
        source_label=_note_source_label(note),
        images=_note_images(note_id, note.get("sketch")),
    )

    source_ref = str(note.get("source_ref") or "")
    source_url = source_ref if source_ref.startswith("http") else ""

    # Reuse the existing page only when exporting to the same database;
    # a different target intentionally gets its own page.
    existing_page_id = (
        note.get("notion_page_id", "")
        if note.get("notion_database_id", "") in ("", resolved_db)
        else ""
    )

    result = upsert_page(
        database_id=resolved_db,
        title=title,
        children=children,
        tags=list(note.get("tags") or []),
        source_url=source_url,
        note_type=note.get("note_type", ""),
        existing_page_id=existing_page_id,
        schema=cached_schema,
    )

    updated_note = notes_store.mark_note_synced(
        note_id,
        notion_page_id=result["page_id"],
        notion_page_url=result["url"],
        notion_database_id=resolved_db,
        content_hash=note.get("content_hash", ""),
    )

    return {
        "note": updated_note,
        "page_id": result["page_id"],
        "url": result["url"],
        "updated": result["updated"],
        "warnings": warnings,
    }

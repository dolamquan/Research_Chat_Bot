from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from app.integrations.notion import NotionError
from app.integrations import notion_sync
from app.rag import notes_index
from app.storage import notes as notes_store

router = APIRouter(prefix="/notes", tags=["notes"])


class NoteCreateRequest(BaseModel):
    note_type: str = "freeform"
    source_type: str = ""
    source_ref: str = ""
    source_title: str = ""
    article_id: str = ""
    page: int | None = Field(default=None, ge=1)
    selected_text: str = ""
    title: str = ""
    body_md: str = ""
    tags: List[str] = Field(default_factory=list)
    folder_id: str = notes_store.DEFAULT_FOLDER_ID
    sketch: Any = None


class NoteUpdateRequest(BaseModel):
    title: str | None = None
    body_md: str | None = None
    selected_text: str | None = None
    source_title: str | None = None
    page: int | None = Field(default=None, ge=1)
    tags: List[str] | None = None
    folder_id: str | None = None
    sketch: Any = None


class FolderRequest(BaseModel):
    name: str = Field(..., min_length=1)


class AttachmentRequest(BaseModel):
    kind: str = "image"
    name: str = ""
    data_url: str = Field(..., min_length=10)
    scene: Any = None


class NotionTargetRequest(BaseModel):
    name: str = ""
    database_id: str = Field(..., min_length=8)


class NotionExportRequest(BaseModel):
    target_id: str = ""
    database_id: str = ""


class NotesSearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    limit: int = Field(default=8, ge=1, le=25)


class WorkspaceMigrationAttachment(BaseModel):
    kind: str = "image"
    name: str = ""
    data_url: str = ""
    scene: Any = None


class WorkspaceMigrationNote(BaseModel):
    id: str = ""
    title: str = ""
    body: str = ""
    folder_id: str = notes_store.DEFAULT_FOLDER_ID
    scope_id: str = ""
    scope_title: str = ""
    sketch: Any = None
    created_at: str = ""
    updated_at: str = ""
    attachments: List[WorkspaceMigrationAttachment] = Field(default_factory=list)


class WorkspaceMigrationFolder(BaseModel):
    id: str
    name: str


class WorkspaceMigrationRequest(BaseModel):
    folders: List[WorkspaceMigrationFolder] = Field(default_factory=list)
    notes: List[WorkspaceMigrationNote] = Field(default_factory=list)


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, NotionError):
        status = {
            "not_configured": 400,
            "validation": 400,
            "unauthorized": 401,
            "not_found": 404,
            "rate_limited": 429,
        }.get(exc.code, 502)
        return HTTPException(status_code=status, detail=exc.message)
    return HTTPException(status_code=404, detail=str(exc))


# --- folders (fixed paths must precede /{note_id}) -------------------------------


@router.get("/folders")
def list_folders() -> Dict[str, Any]:
    return {"folders": notes_store.list_folders()}


@router.post("/folders")
def create_folder(request: FolderRequest) -> Dict[str, Any]:
    return {"folder": notes_store.create_folder(request.name)}


@router.patch("/folders/{folder_id}")
def rename_folder(folder_id: str, request: FolderRequest) -> Dict[str, Any]:
    try:
        return {"folder": notes_store.rename_folder(folder_id, request.name)}
    except ValueError as exc:
        raise _http_error(exc) from exc


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: str) -> Dict[str, str]:
    try:
        notes_store.delete_folder(folder_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "deleted"}


# --- Notion targets ---------------------------------------------------------------


@router.get("/notion/targets")
def list_notion_targets() -> Dict[str, Any]:
    return {"targets": notes_store.list_notion_targets()}


@router.post("/notion/targets")
def create_notion_target(request: NotionTargetRequest) -> Dict[str, Any]:
    try:
        return {
            "target": notion_sync.register_target(request.name, request.database_id)
        }
    except (NotionError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.delete("/notion/targets/{target_id}")
def delete_notion_target(target_id: str) -> Dict[str, str]:
    try:
        notes_store.delete_notion_target(target_id)
    except ValueError as exc:
        raise _http_error(exc) from exc
    return {"status": "deleted"}


# --- attachments ------------------------------------------------------------------


@router.get("/attachments/{attachment_id}")
def download_attachment(attachment_id: str) -> Response:
    try:
        attachment = notes_store.get_attachment(attachment_id)
    except ValueError as exc:
        raise _http_error(exc) from exc
    return Response(
        content=attachment["data"],
        media_type=attachment["mime_type"] or "image/png",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/attachments/{attachment_id}/scene")
def get_attachment_scene(attachment_id: str) -> Dict[str, Any]:
    try:
        attachment = notes_store.get_attachment(attachment_id)
    except ValueError as exc:
        raise _http_error(exc) from exc
    return {"scene": attachment.get("scene")}


@router.delete("/attachments/{attachment_id}")
def delete_attachment(attachment_id: str) -> Dict[str, str]:
    try:
        notes_store.delete_attachment(attachment_id)
    except ValueError as exc:
        raise _http_error(exc) from exc
    return {"status": "deleted"}


# --- migration --------------------------------------------------------------------


@router.post("/migrate-workspace")
def migrate_workspace(request: WorkspaceMigrationRequest) -> Dict[str, Any]:
    """One-time import of localStorage workspace notes and folders."""
    folder_map: Dict[str, str] = {notes_store.DEFAULT_FOLDER_ID: notes_store.DEFAULT_FOLDER_ID}
    for folder in request.folders:
        if folder.id == notes_store.DEFAULT_FOLDER_ID:
            continue
        created = notes_store.create_folder(folder.name, folder_id=folder.id)
        folder_map[folder.id] = created["folder_id"]

    imported = 0
    skipped = 0
    for legacy in request.notes:
        note_id = legacy.id or ""
        try:
            if note_id:
                notes_store.get_note(note_id)
                skipped += 1  # Already migrated on a previous run.
                continue
        except ValueError:
            pass

        note = notes_store.create_note(
            note_id=note_id,
            note_type="freeform",
            source_type="scope",
            source_ref=legacy.scope_id,
            source_title=legacy.scope_title,
            title=legacy.title or legacy.scope_title or "Workspace note",
            body_md=legacy.body,
            folder_id=folder_map.get(legacy.folder_id, notes_store.DEFAULT_FOLDER_ID),
            sketch=legacy.sketch,
            created_at=legacy.created_at,
            updated_at=legacy.updated_at,
        )
        for attachment in legacy.attachments:
            if not attachment.data_url.startswith("data:"):
                continue
            notes_store.add_attachment(
                note_id=note["note_id"],
                kind=attachment.kind,
                name=attachment.name,
                data_url=attachment.data_url,
                scene=attachment.scene,
            )
        notes_index.index_note_safe(notes_store.get_note(note["note_id"]))
        imported += 1

    return {"status": "ok", "imported": imported, "skipped": skipped}


# --- semantic search over notes -----------------------------------------------------


@router.post("/search")
def search_notes(request: NotesSearchRequest) -> Dict[str, Any]:
    try:
        hits = notes_index.search_notes(request.query, limit=request.limit)
    except Exception as exc:  # noqa: BLE001 - Qdrant may be down.
        raise HTTPException(
            status_code=503,
            detail=f"Note search is unavailable: {exc}",
        ) from exc
    return {"results": hits}


# --- notes CRUD ---------------------------------------------------------------------


@router.get("")
def list_notes(
    note_type: str | None = None,
    source_ref: str | None = None,
    folder_id: str | None = None,
    q: str | None = None,
    limit: int = 200,
) -> Dict[str, Any]:
    return {
        "notes": notes_store.list_notes(
            note_type=note_type,
            source_ref=source_ref,
            folder_id=folder_id,
            query=q,
            limit=limit,
        )
    }


@router.post("")
def create_note(request: NoteCreateRequest) -> Dict[str, Any]:
    try:
        note = notes_store.create_note(
            note_type=request.note_type,
            source_type=request.source_type,
            source_ref=request.source_ref,
            source_title=request.source_title,
            article_id=request.article_id,
            page=request.page,
            selected_text=request.selected_text.strip(),
            title=request.title.strip(),
            body_md=request.body_md,
            tags=request.tags,
            folder_id=request.folder_id,
            sketch=request.sketch,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    notes_index.index_note_safe(note)
    return {"note": note}


@router.get("/{note_id}")
def get_note(note_id: str) -> Dict[str, Any]:
    try:
        return {"note": notes_store.get_note(note_id)}
    except ValueError as exc:
        raise _http_error(exc) from exc


@router.patch("/{note_id}")
def update_note(note_id: str, request: NoteUpdateRequest) -> Dict[str, Any]:
    try:
        note = notes_store.update_note(
            note_id,
            title=request.title,
            body_md=request.body_md,
            selected_text=request.selected_text,
            source_title=request.source_title,
            page=request.page,
            tags=request.tags,
            folder_id=request.folder_id,
            sketch=request.sketch,
        )
    except ValueError as exc:
        raise _http_error(exc) from exc

    notes_index.index_note_safe(note)
    return {"note": note}


@router.delete("/{note_id}")
def delete_note(note_id: str) -> Dict[str, str]:
    try:
        notes_store.delete_note(note_id)
    except ValueError as exc:
        raise _http_error(exc) from exc

    notes_index.remove_note_safe(note_id)
    return {"status": "deleted"}


@router.post("/{note_id}/attachments")
def add_attachment(note_id: str, request: AttachmentRequest) -> Dict[str, Any]:
    try:
        attachment = notes_store.add_attachment(
            note_id=note_id,
            kind=request.kind,
            name=request.name,
            data_url=request.data_url,
            scene=request.scene,
        )
    except ValueError as exc:
        raise _http_error(exc) from exc
    return {"attachment": attachment}


@router.post("/{note_id}/export-notion")
def export_note_to_notion(note_id: str, request: NotionExportRequest) -> Dict[str, Any]:
    try:
        return notion_sync.export_note(
            note_id,
            target_id=request.target_id,
            database_id=request.database_id,
        )
    except (NotionError, ValueError) as exc:
        raise _http_error(exc) from exc

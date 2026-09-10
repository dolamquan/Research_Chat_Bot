import base64
import sqlite3
from unittest.mock import Mock

import pytest

from app.storage import notes
from app.integrations import notion, notion_sync


@pytest.fixture
def note_store(tmp_path, monkeypatch):
    monkeypatch.setattr(notes, "DATA_DIR", tmp_path)
    monkeypatch.setattr(notes, "DB_PATH", tmp_path / "notes.sqlite3")
    return notes.create_note(title="Diagram note", body_md="Explanation")


def attach(note, content=b"png-bytes", **fields):
    return notes.add_attachment(note_id=note["note_id"], name="Sketch", data_url="data:image/png;base64," + base64.b64encode(content).decode(), **fields)


def test_reopened_note_uploads_are_idempotent_and_new_pictures_are_saved(note_store):
    first = attach(note_store, client_id="picture-1")
    retry = attach(note_store, client_id="picture-1")
    second = attach(note_store, b"new-picture", client_id="picture-2")
    assert retry["attachment_id"] == first["attachment_id"]
    assert second["attachment_id"] != first["attachment_id"]
    assert len(notes.list_attachment_blobs(note_store["note_id"])) == 2


def test_legacy_upload_is_adopted_without_duplication(note_store):
    legacy = attach(note_store)
    new = attach(note_store, client_id="browser-picture")
    assert new["attachment_id"] == legacy["attachment_id"]
    assert len(notes.get_note(note_store["note_id"])["attachments"]) == 1


def test_edited_canvas_replaces_image_and_marks_note_dirty(note_store):
    first = attach(note_store, client_id="workspace-canvas")
    current = notes.get_note(note_store["note_id"])
    notes.mark_note_synced(current["note_id"], notion_page_id="page", notion_page_url="url", notion_database_id="db", content_hash=current["content_hash"])
    attach(note_store, client_id="workspace-canvas")
    assert not notes.get_note(current["note_id"])["notion_dirty"]
    edited = attach(note_store, b"edited-png", client_id="workspace-canvas")
    assert edited["attachment_id"] == first["attachment_id"]
    assert notes.get_note(current["note_id"])["notion_dirty"]
    assert notes.get_attachment(first["attachment_id"])["data"] == b"edited-png"


def test_client_ids_are_scoped_to_each_note(note_store):
    other = notes.create_note(title="Other")
    assert attach(note_store, client_id="workspace-canvas")["attachment_id"] != attach(other, client_id="workspace-canvas")["attachment_id"]


def test_existing_attachment_schema_is_migrated_without_losing_images(tmp_path, monkeypatch):
    db = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(db) as conn:
        conn.execute("""CREATE TABLE note_attachments (attachment_id TEXT PRIMARY KEY, note_id TEXT NOT NULL,
                     kind TEXT, name TEXT, mime_type TEXT, data BLOB, scene_json TEXT, created_at TEXT)""")
        conn.execute("INSERT INTO note_attachments VALUES ('image', 'note', 'image', 'Photo', 'image/png', ?, '', 'today')", (b"legacy-bytes",))
    monkeypatch.setattr(notes, "DATA_DIR", tmp_path)
    monkeypatch.setattr(notes, "DB_PATH", db)
    notes.init_db()
    notes.init_db()
    image = notes.get_attachment("image")
    assert image["data"] == b"legacy-bytes"
    assert image["client_id"] == ""


def test_sketch_edit_alone_marks_a_synced_note_dirty(note_store):
    notes.mark_note_synced(note_store["note_id"], notion_page_id="page", notion_page_url="url", notion_database_id="db", content_hash=note_store["content_hash"])
    edited = notes.update_note(note_store["note_id"], sketch={"elements": [{"id": "new-shape"}]})
    assert edited["notion_dirty"]


def test_all_images_become_native_notion_blocks_before_marking_synced(note_store, monkeypatch):
    attach(note_store, client_id="photo")
    attach(note_store, b"diagram", client_id="diagram")
    uploads = Mock(side_effect=["upload-photo", "upload-diagram"])
    page = Mock(return_value={"page_id": "page", "url": "url", "updated": False})
    monkeypatch.setattr(notion, "upload_file", uploads)
    monkeypatch.setattr(notion_sync, "upsert_page", page)
    result = notion_sync.export_note(note_store["note_id"], database_id="db")
    images = [b["image"]["file_upload"]["id"] for b in page.call_args.kwargs["children"] if b["type"] == "image"]
    assert images == ["upload-photo", "upload-diagram"]
    assert result["warnings"] == []
    assert not result["note"]["notion_dirty"]


def test_failed_image_does_not_replace_page_or_mark_synced(note_store, monkeypatch):
    attach(note_store, client_id="photo")
    attach(note_store, b"second", client_id="diagram")
    current = notes.get_note(note_store["note_id"])
    notes.mark_note_synced(current["note_id"], notion_page_id="existing-page", notion_page_url="url", notion_database_id="db", content_hash="older-hash")
    monkeypatch.setattr(notion, "upload_file", Mock(side_effect=["first-upload", notion.NotionError("upload_failed", "Rejected")]))
    page = Mock()
    monkeypatch.setattr(notion_sync, "upsert_page", page)
    with pytest.raises(notion.NotionError, match="Could not export attachment"):
        notion_sync.export_note(current["note_id"], database_id="db")
    page.assert_not_called()
    saved = notes.get_note(current["note_id"])
    assert saved["synced_content_hash"] == "older-hash"
    assert saved["notion_dirty"]


def test_canvas_json_cannot_silently_export_without_an_image(note_store, monkeypatch):
    scene = {"elements": [{"id": "box", "type": "rectangle"}], "files": {}}
    notes.update_note(note_store["note_id"], sketch=scene)
    page = Mock()
    monkeypatch.setattr(notion_sync, "upsert_page", page)
    with pytest.raises(notion.NotionError, match="image preview"):
        notion_sync.export_note(note_store["note_id"], database_id="db")
    page.assert_not_called()
    attach(note_store, kind="sketch", scene=scene, client_id="workspace-canvas")
    assert len(notion_sync._note_images(note_store["note_id"], scene)) == 1


@pytest.mark.parametrize("status", ["pending", "failed", "expired"])
def test_incomplete_notion_uploads_are_not_attached(monkeypatch, status):
    monkeypatch.setenv("NOTION_API_KEY", "test-only")
    monkeypatch.setattr(notion, "_request", Mock(return_value={"id": "upload", "status": status}))
    monkeypatch.setattr(notion.requests, "post", Mock(return_value=Mock(status_code=200, json=lambda: {"status": status})))
    with pytest.raises(notion.NotionError, match="not completed"):
        notion.upload_file("Sketch", b"png", "image/png")


def test_upload_uses_consistent_png_filename_and_checks_pending_status(monkeypatch):
    monkeypatch.setenv("NOTION_API_KEY", "test-only")
    request = Mock(side_effect=[{"id": "upload"}, {"id": "upload", "status": "uploaded"}])
    post = Mock(return_value=Mock(status_code=200, json=lambda: {"status": "pending"}))
    monkeypatch.setattr(notion, "_request", request)
    monkeypatch.setattr(notion.requests, "post", post)
    assert notion.upload_file("Sketch 1", b"png", "image/png") == "upload"
    assert request.call_args_list[0].kwargs["json_body"]["filename"] == "Sketch 1.png"
    assert post.call_args.kwargs["files"]["file"] == ("Sketch 1.png", b"png", "image/png")

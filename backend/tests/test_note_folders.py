"""Note folders behave like a file system: nesting, moving, renaming, deleting."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth.context import CurrentUser, reset_current_user, set_current_user
from app.storage import notes

A = CurrentUser(id="user-a")
B = CurrentUser(id="user-b")


@contextmanager
def acting_as(user: CurrentUser | None):
    token = set_current_user(user)
    try:
        yield
    finally:
        reset_current_user(token)


@pytest.fixture(autouse=True)
def temp_database(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(notes, "DATA_DIR", tmp_path)
    monkeypatch.setattr(notes, "DB_PATH", tmp_path / "notes.sqlite3")


def _tree():
    papers = notes.create_folder("Papers")
    rag = notes.create_folder("RAG", parent_id=papers["folder_id"])
    graphs = notes.create_folder("Graph RAG", parent_id=rag["folder_id"])
    return papers, rag, graphs


def test_folders_nest_and_list_with_parents():
    papers, rag, graphs = _tree()
    assert papers["parent_id"] == ""
    assert rag["parent_id"] == papers["folder_id"]
    listed = {f["folder_id"]: f for f in notes.list_folders()}
    assert listed[notes.DEFAULT_FOLDER_ID]["parent_id"] == ""
    assert listed[graphs["folder_id"]]["parent_id"] == rag["folder_id"]
    # The default folder id is another spelling of the top level.
    top = notes.create_folder("Top", parent_id=notes.DEFAULT_FOLDER_ID)
    assert top["parent_id"] == ""


def test_parent_must_exist():
    with pytest.raises(ValueError, match="Parent folder not found"):
        notes.create_folder("Orphan", parent_id="missing")


def test_rename_and_move_refuse_cycles():
    papers, rag, graphs = _tree()
    renamed = notes.update_folder(rag["folder_id"], name="  Retrieval  ")
    assert renamed["name"] == "Retrieval" and renamed["parent_id"] == papers["folder_id"]
    assert notes.rename_folder(rag["folder_id"], "RAG")["name"] == "RAG"

    moved = notes.update_folder(graphs["folder_id"], parent_id="")
    assert moved["parent_id"] == ""
    moved = notes.update_folder(graphs["folder_id"], parent_id=papers["folder_id"])
    assert moved["parent_id"] == papers["folder_id"]

    with pytest.raises(ValueError, match="itself or one of its subfolders"):
        notes.update_folder(papers["folder_id"], parent_id=papers["folder_id"])
    with pytest.raises(ValueError, match="itself or one of its subfolders"):
        notes.update_folder(papers["folder_id"], parent_id=rag["folder_id"])
    with pytest.raises(ValueError, match="Folder name is required"):
        notes.update_folder(rag["folder_id"], name="   ")
    with pytest.raises(ValueError, match="default folder"):
        notes.update_folder(notes.DEFAULT_FOLDER_ID, name="x")
    with pytest.raises(ValueError, match="Folder not found"):
        notes.update_folder("missing", name="x")


def test_deleting_a_folder_moves_its_contents_up_one_level():
    papers, rag, graphs = _tree()
    in_rag = notes.create_note(title="rag note", folder_id=rag["folder_id"])
    in_graphs = notes.create_note(title="graph note", folder_id=graphs["folder_id"])

    result = notes.delete_folder(rag["folder_id"])
    assert result == {
        "folder_id": rag["folder_id"], "parent_id": papers["folder_id"], "notes_moved": 1, "folders_moved": 1,
    }
    assert notes.get_note(in_rag["note_id"])["folder_id"] == papers["folder_id"]
    assert notes.get_note(in_graphs["note_id"])["folder_id"] == graphs["folder_id"]
    listed = {f["folder_id"]: f for f in notes.list_folders()}
    assert rag["folder_id"] not in listed
    assert listed[graphs["folder_id"]]["parent_id"] == papers["folder_id"]

    # Deleting a top-level folder sends notes to the default folder.
    result = notes.delete_folder(papers["folder_id"])
    assert result["parent_id"] == "" and result["notes_moved"] == 1 and result["folders_moved"] == 1
    assert notes.get_note(in_rag["note_id"])["folder_id"] == notes.DEFAULT_FOLDER_ID
    assert notes.list_folders()[1]["parent_id"] == ""

    with pytest.raises(ValueError, match="default folder"):
        notes.delete_folder(notes.DEFAULT_FOLDER_ID)
    with pytest.raises(ValueError, match="Folder not found"):
        notes.delete_folder(rag["folder_id"])


def test_folder_trees_are_per_user():
    with acting_as(A):
        papers, _, _ = _tree()
    with acting_as(B):
        with pytest.raises(ValueError, match="Parent folder not found"):
            notes.create_folder("Mine", parent_id=papers["folder_id"])
        with pytest.raises(ValueError, match="Folder not found"):
            notes.update_folder(papers["folder_id"], parent_id="")
        with pytest.raises(ValueError, match="Folder not found"):
            notes.delete_folder(papers["folder_id"])
    with acting_as(A):
        assert len(notes.list_folders()) == 4


def test_folder_routes(monkeypatch):
    from app.main import app

    client = TestClient(app)
    created = client.post("/notes/folders", json={"name": "Papers"}).json()["folder"]
    child = client.post("/notes/folders", json={"name": "RAG", "parent_id": created["folder_id"]}).json()["folder"]
    assert child["parent_id"] == created["folder_id"]
    assert client.post("/notes/folders", json={"name": "x", "parent_id": "missing"}).status_code == 404

    renamed = client.patch(f"/notes/folders/{child['folder_id']}", json={"name": "Retrieval"}).json()["folder"]
    assert renamed["name"] == "Retrieval"
    assert client.patch(f"/notes/folders/{created['folder_id']}", json={"parent_id": child["folder_id"]}).status_code == 400
    assert client.patch("/notes/folders/missing", json={"name": "x"}).status_code == 404

    note = client.post("/notes", json={"title": "n", "folder_id": child["folder_id"]}).json()["note"]
    deleted = client.delete(f"/notes/folders/{child['folder_id']}").json()
    assert deleted["status"] == "deleted" and deleted["notes_moved"] == 1 and deleted["parent_id"] == created["folder_id"]
    assert client.get(f"/notes/{note['note_id']}").json()["note"]["folder_id"] == created["folder_id"]
    assert client.delete("/notes/folders/default").status_code == 400

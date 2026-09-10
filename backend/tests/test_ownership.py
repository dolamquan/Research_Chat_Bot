"""Per-user data: personal stores are private, papers are public-or-own.

Each store gets a temporary database. The acting user is set through the same
context variable the request dependency uses, so these tests exercise exactly
what a route sees.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

import pytest
from qdrant_client.models import FieldCondition, Filter, IsEmptyCondition

from app.auth.context import CurrentUser, current_owner_id, reset_current_user, set_current_user
from app.ingestion import url_ingester
from app.rag import access_scope, retriever
from app.storage import agent_history, article_store, chat_history, ingestion_jobs, notes

A = CurrentUser(id="user-a", email="a@example.com")
B = CurrentUser(id="user-b", email="b@example.com")
ADMIN = CurrentUser(id="admin-1", role="admin")


@contextmanager
def acting_as(user: CurrentUser | None):
    token = set_current_user(user)
    try:
        yield
    finally:
        reset_current_user(token)


@pytest.fixture(autouse=True)
def temp_databases(monkeypatch, tmp_path: Path):
    for module, name in (
        (notes, "notes.sqlite3"),
        (article_store, "articles.sqlite3"),
        (ingestion_jobs, "articles.sqlite3"),
        (chat_history, "chat.sqlite3"),
        (agent_history, "agent.sqlite3"),
    ):
        monkeypatch.setattr(module, "DATA_DIR", tmp_path)
        monkeypatch.setattr(module, "DB_PATH", tmp_path / name)
    monkeypatch.setattr(article_store, "ARXIV_MANIFEST_PATH", tmp_path / "missing_manifest.json")


def test_context_defaults_to_nobody():
    assert current_owner_id() is None
    with acting_as(A):
        assert current_owner_id() == "user-a"
    assert current_owner_id() is None


def test_notes_are_private_to_their_author():
    with acting_as(A):
        note = notes.create_note(title="mine", body_md="secret")
        folder = notes.create_folder("Reading")
        notes.add_attachment(note_id=note["note_id"], data_url="data:image/png;base64,aGk=")
        target = notes.save_notion_target(name="DB", database_id="db-1")
        assert note["owner_id"] == "user-a"
        assert [n["note_id"] for n in notes.list_notes()] == [note["note_id"]]
        attachment_id = notes.get_note(note["note_id"])["attachments"][0]["attachment_id"]

    with acting_as(B):
        assert notes.list_notes() == []
        assert [f["folder_id"] for f in notes.list_folders()] == [notes.DEFAULT_FOLDER_ID]
        assert notes.list_notion_targets() == []
        with pytest.raises(ValueError):
            notes.get_note(note["note_id"])
        with pytest.raises(ValueError):
            notes.update_note(note["note_id"], title="hijacked")
        with pytest.raises(ValueError):
            notes.delete_note(note["note_id"])
        with pytest.raises(ValueError):
            notes.get_attachment(attachment_id)
        with pytest.raises(ValueError):
            notes.delete_attachment(attachment_id)
        with pytest.raises(ValueError):
            notes.rename_folder(folder["folder_id"], "theirs")
        with pytest.raises(ValueError):
            notes.get_notion_target(target["target_id"])
        # Same Notion database, separate target per user.
        theirs = notes.save_notion_target(name="DB", database_id="db-1")
        assert theirs["target_id"] != target["target_id"]

    with acting_as(A):
        assert notes.get_note(note["note_id"])["title"] == "mine"
        assert notes.get_attachment(attachment_id)["data"] == b"hi"
        notes.delete_note(note["note_id"])
        assert notes.list_notes() == []


def test_unscoped_calls_see_everything_and_admin_claims_legacy_rows():
    legacy = notes.create_note(title="before accounts", owner_id=None)
    with acting_as(A):
        notes.create_note(title="a's")
        assert [n["title"] for n in notes.list_notes()] == ["a's"]
    assert {n["title"] for n in notes.list_notes(owner_id=None)} == {"before accounts", "a's"}

    assert notes.claim_unowned(ADMIN.id) == {"notes": 1, "note_folders": 0, "notion_targets": 0}
    with acting_as(ADMIN):
        assert [n["note_id"] for n in notes.list_notes()] == [legacy["note_id"]]
    assert notes.claim_unowned(ADMIN.id)["notes"] == 0


def test_chat_and_agent_sessions_are_private():
    for store in (chat_history, agent_history):
        with acting_as(A):
            session = store.create_session(first_question="hello")
            store.append_message(session["id"], "user", "hello")
            assert [s["id"] for s in store.list_sessions()] == [session["id"]]
        with acting_as(B):
            assert store.list_sessions() == []
            with pytest.raises(ValueError):
                store.get_session(session["id"])
            with pytest.raises(ValueError):
                store.append_message(session["id"], "user", "not mine")
            with pytest.raises(ValueError):
                store.delete_session(session["id"])
        with acting_as(A):
            assert len(store.get_session(session["id"])["messages"]) == 1
            store.delete_session(session["id"])
        legacy = store.create_session(first_question="old", owner_id=None)
        assert list(store.claim_unowned(ADMIN.id).values()) == [1]
        with acting_as(ADMIN):
            assert store.get_session_summary(legacy["id"])["id"] == legacy["id"]


def _paper(article_id: str, owner_id, source: str | None = None, category: str = "nlp"):
    return article_store.upsert_article(
        article_id=article_id, title=article_id, source=source or f"{article_id}.pdf",
        domain="research", category=category, owner_id=owner_id,
    )


def test_papers_are_public_or_own():
    _paper("public-1", None)
    with acting_as(A):
        _paper("a-private", "user-a", category="vision")
    with acting_as(B):
        _paper("b-private", "user-b")

    with acting_as(A):
        assert {a["article_id"] for a in article_store.list_articles()} == {"public-1", "a-private"}
        assert article_store.get_article("public-1")["visibility"] == "public"
        assert article_store.get_article("a-private")["visibility"] == "private"
        with pytest.raises(ValueError):
            article_store.get_article("b-private")
        assert article_store.list_domains() == [
            {"domain": "research", "category": "nlp", "article_count": 1},
            {"domain": "research", "category": "vision", "article_count": 1},
        ]
        assert article_store.can_access_source("public-1.pdf")
        assert article_store.can_access_source("a-private.pdf")
        assert not article_store.can_access_source("b-private.pdf")
        assert article_store.can_access_source("never-indexed.pdf")

    assert {a["article_id"] for a in article_store.list_articles(owner_id=None)} == {"public-1", "a-private", "b-private"}


def test_reindexing_never_changes_ownership_but_admin_publishing_does():
    with acting_as(A):
        _paper("a-private", "user-a")
    with acting_as(B):
        # B cannot take over A's row by re-upserting the same id.
        article_store.upsert_article(article_id="a-private", title="stolen", source="a-private.pdf", owner_id="user-b")
    assert article_store.get_article("a-private", owner_id=None)["owner_id"] == "user-a"

    published = article_store.set_article_visibility("a-private", public=True)
    assert published["owner_id"] is None
    with acting_as(B):
        assert article_store.get_article("a-private")["visibility"] == "public"
    with pytest.raises(ValueError):
        article_store.set_article_visibility("missing", public=True)
    with pytest.raises(ValueError):
        article_store.set_article_visibility("a-private", public=False)


def test_ingestion_jobs_are_private():
    with acting_as(A):
        job = ingestion_jobs.create_ingestion_job(url="https://arxiv.org/abs/1")
        assert [j["job_id"] for j in ingestion_jobs.list_ingestion_jobs()] == [job["job_id"]]
    with acting_as(B):
        assert ingestion_jobs.list_ingestion_jobs() == []
        with pytest.raises(ValueError):
            ingestion_jobs.get_ingestion_job(job["job_id"])


def test_ingest_identity_reuses_public_copies_and_separates_private_ones():
    resolve = url_ingester.resolve_article_identity
    # Nothing indexed yet: everyone writes the natural id.
    assert resolve("arxiv:1", "1.pdf", None) == ("arxiv:1", None)
    assert resolve("arxiv:1", "1.pdf", "user-a") == ("arxiv:1", None)

    with acting_as(A):
        _paper("arxiv:1", "user-a", source="1.pdf")
    # A re-ingesting keeps their row; B gets a separate private copy.
    assert resolve("arxiv:1", "1.pdf", "user-a") == ("arxiv:1", None)
    assert resolve("arxiv:1", "1.pdf", "user-b") == ("arxiv:1~user-b", None)

    public = _paper("arxiv:2", None, source="2.pdf")
    article_id, reuse = resolve("arxiv:2", "2.pdf", "user-b")
    assert article_id == "arxiv:2" and reuse["article_id"] == public["article_id"]


def _conditions(filter_: Filter):
    return list(filter_.must or [])


def test_retrieval_filters_carry_the_users_visibility():
    assert retriever.build_retrieval_filter() is None
    plain = retriever.build_retrieval_filter(domain="research")
    assert len(_conditions(plain)) == 1

    with acting_as(A):
        scoped = retriever.build_retrieval_filter()
        assert len(_conditions(scoped)) == 1
        visibility = _conditions(scoped)[0]
        assert isinstance(visibility, Filter)
        kinds = {type(condition) for condition in visibility.should}
        assert kinds == {FieldCondition, IsEmptyCondition}

        combined = retriever.build_retrieval_filter(domain="research", cluster_id=3)
        assert len(_conditions(combined)) == 3
        assert access_scope.owner_scope(None) is not None

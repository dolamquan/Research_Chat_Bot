"""Every store against a real Postgres, plus the SQLite→Postgres copy.

Skipped unless TEST_DATABASE_URL points at a disposable database, e.g.

    docker run -d --name pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=x -e POSTGRES_USER=x -e POSTGRES_DB=x postgres:16-alpine
    TEST_DATABASE_URL=postgresql://x:x@127.0.0.1:55432/x python -m pytest tests/test_postgres_storage.py

The schema is dropped before each test, so never point this at real data.
"""

from __future__ import annotations

import base64
import os

import pytest
from fastapi.testclient import TestClient

from app.storage import (
    agent_history,
    article_store,
    chat_history,
    db,
    ingestion_jobs,
    integrations,
    notes,
    scene_store,
    stage_scene_store,
    variant_store,
    visual_assets,
    visualization_store,
)

TEST_URL = os.getenv("TEST_DATABASE_URL", "").strip()
pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL not set")

STORES = (agent_history, chat_history, article_store, ingestion_jobs, integrations, notes,
          visualization_store, scene_store, stage_scene_store, variant_store, visual_assets)


def _wipe() -> None:
    import psycopg

    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")


@pytest.fixture
def postgres(monkeypatch):
    db.reset_for_tests()
    _wipe()
    monkeypatch.setenv("DATABASE_URL", TEST_URL)
    yield
    db.reset_for_tests()
    monkeypatch.delenv("DATABASE_URL", raising=False)


PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nfake-image-bytes").decode()


def test_schema_builds_and_every_store_round_trips(postgres):
    for store in STORES:
        store.init_db()
    with db.connect(agent_history.DB_PATH) as conn:
        assert conn.dialect == "postgres"
        tables = db.table_names(conn)
    assert {"agent_sessions", "agent_messages", "chat_sessions", "chat_messages", "articles", "notes", "note_folders",
            "note_attachments", "notion_targets", "paper_visualizations", "node_expansions", "algorithm_scenes",
            "stage_scenes", "diagram_variants", "verification_runs", "variant_messages", "visual_assets",
            "visual_asset_blobs", "ingestion_jobs", "user_integrations"} <= tables

    # identity columns replace AUTOINCREMENT; ordering by id still works
    session = agent_history.create_session(first_question="hello postgres", kind="assistant")
    agent_history.append_message(session["id"], "user", "first", meta={"source": "voice"})
    agent_history.append_message(session["id"], "assistant", "second", tool_trace=[{"tool": "x"}])
    recent = agent_history.recent_messages(session["id"], limit=5)
    assert [m["content"] for m in recent] == ["first", "second"]
    assert recent[0]["meta"] == {"source": "voice"} and recent[1]["tool_trace"] == [{"tool": "x"}]
    assert agent_history.list_sessions(kind="assistant")[0]["id"] == session["id"]
    assert agent_history.list_sessions() == []  # default kind=agent
    # cascade delete through the real foreign key
    agent_history.delete_session(session["id"])
    with db.connect(agent_history.DB_PATH) as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM agent_messages").fetchone()["n"] == 0

    chat = chat_history.create_session(first_question="chat")
    chat_history.append_message(chat["id"], "user", "q", sources=[{"id": "s1"}])
    assert chat_history.get_session(chat["id"])["messages"][0]["sources"] == [{"id": "s1"}]

    # ON CONFLICT DO UPDATE on the primary key
    article_store.upsert_article("a1", "Graph RAG", "graph.pdf", domain="research", category="nlp", tags=["rag"])
    article_store.upsert_article("a1", "Graph RAG v2", "graph.pdf", domain="research", category="nlp")
    found = article_store.find_articles_by_source("graph.pdf")
    assert [a["title"] for a in found] == ["Graph RAG v2"] and found[0]["tags"] == []
    assert any(d["category"] == "nlp" and d["article_count"] == 1 for d in article_store.list_domains())
    assert article_store.can_access_source("graph.pdf")

    # notes: ILIKE search, lower() ordering, BYTEA attachments, ON CONFLICT DO NOTHING on folders
    for name in ("banana", "Apple", "cherry"):
        notes.create_folder(name, folder_id=f"f-{name}")
    notes.create_folder("dup", folder_id="f-banana")  # ignored, same id
    user_folders = [f["name"] for f in notes.list_folders() if f["folder_id"] != notes.DEFAULT_FOLDER_ID]
    assert user_folders == ["Apple", "banana", "cherry"]  # lower() replaces COLLATE NOCASE
    note = notes.create_note(title="Graph RAG Notes", body_md="**bold** text", tags=["a"], folder_id="f-Apple")
    assert [n["note_id"] for n in notes.list_notes(query="graph rag")] == [note["note_id"]]
    assert notes.list_notes(query="nothing here") == []
    attachment = notes.add_attachment(note_id=note["note_id"], data_url=PNG, name="fig.png")
    stored = notes.get_attachment(attachment["attachment_id"])
    assert bytes(stored["data"]) == b"\x89PNG\r\n\x1a\nfake-image-bytes"
    notes.update_note(note["note_id"], title="Renamed")
    assert notes.get_note(note["note_id"])["title"] == "Renamed"

    # visualizations: composite UNIQUE + ON CONFLICT DO UPDATE
    diagram = {"nodes": [], "edges": [], "groups": []}
    first = visualization_store.upsert_visualization(article_id="a1", document_source="graph.pdf", diagram_kind="method_flow",
                                                     title="v1", algorithm_name="alg", diagram=diagram, summary="", key_insight="", model="m")
    second = visualization_store.upsert_visualization(article_id="a1", document_source="graph.pdf", diagram_kind="method_flow",
                                                      title="v2", algorithm_name="alg", diagram=diagram, summary="", key_insight="", model="m")
    assert first["viz_id"] == second["viz_id"]
    assert [v["title"] for v in visualization_store.list_visualizations("a1")] == ["v2"]
    visualization_store.upsert_node_expansion(viz_id=first["viz_id"], node_id="n1", node_label="N", content={"overview": "o"}, model="m")
    assert visualization_store.get_node_expansion(first["viz_id"], "n1")["content"]["overview"] == "o"

    # scenes: INTEGER flag written from a Python bool
    scene_store.upsert_scene(viz_id=first["viz_id"], article_id="a1", scene={"code": "function init(){}"}, verification={"valid": False})
    scene_store.update_verification(first["viz_id"], {"valid": True, "issues": []})
    assert scene_store.get_scene(first["viz_id"])["verification"]["valid"] is True
    stage_scene_store.upsert_stage_scene(viz_id=first["viz_id"], node_id="n1", scene={"code": "x"}, verification={"valid": True})
    assert len(stage_scene_store.list_stage_scenes(first["viz_id"])) == 1

    # variants, runs and discussion messages
    variant = variant_store.create_variant(root_viz_id=first["viz_id"], parent_variant_id=None, article_id="a1", document_source="graph.pdf",
                                           diagram_kind="method_flow", title="t", algorithm_name="alg", variant_title="vt", diagram=diagram,
                                           summary="", key_insight="", worked_example=None, intent="i", patch={"ops": []},
                                           patch_result={"applied": []}, changed_node_ids=["n1"], depth=1, model="m")
    run = variant_store.create_run(target_id=variant["variant_id"], target_kind="variant", layers=[])
    variant_store.finish_run(run["run_id"], status="done", verdict="structurally_sound")
    assert variant_store.latest_run(variant["variant_id"])["verdict"] == "structurally_sound"
    variant_store.append_message(target_id=variant["variant_id"], role="user", content="why?")
    assert variant_store.list_messages(variant["variant_id"])[0]["content"] == "why?"

    # visual asset blobs (BYTEA) and ingestion jobs
    visual_assets.upsert_visual_asset_blob(filename="fig1.png", content=b"\x00\x01binary", mime_type="image/png")
    assert bytes(visual_assets.get_visual_asset_blob("fig1.png")["content"]) == b"\x00\x01binary"
    job = ingestion_jobs.create_ingestion_job("https://arxiv.org/abs/1", title="T")
    ingestion_jobs.update_ingestion_job(job["job_id"], status="indexed", stage="done", completed=True)
    assert ingestion_jobs.list_ingestion_jobs()[0]["status"] == "indexed"

    # encrypted per-user secrets keyed by (owner, provider)
    integrations.set_secret("notion", "secret-token", owner_id="user-a")
    assert integrations.get_secret("notion", owner_id="user-a") == "secret-token"
    assert integrations.status_for("notion", owner_id="user-a")["configured"] is True


def test_routes_serve_from_postgres(postgres):
    from app.main import app

    client = TestClient(app)
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/articles/domains").status_code == 200
    assert client.get("/notes/folders").status_code == 200
    assert client.get("/agent/sessions").json() == {"sessions": []}
    created = client.post("/agent/sessions", json={"title": "pg session"})
    assert created.status_code == 200
    assert [s["title"] for s in client.get("/agent/sessions").json()["sessions"]] == ["pg session"]


def test_sqlite_data_copies_into_postgres(postgres, monkeypatch, tmp_path):
    from scripts import migrate_to_cloud as migrate

    # Build a small SQLite trio the way the app would have, with DATABASE_URL off.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    db.reset_for_tests()
    for store in STORES:
        monkeypatch.setattr(store, "DB_PATH", tmp_path / ("agent_history.sqlite3" if store is agent_history else
                                                            "chat_history.sqlite3" if store is chat_history else "researchmind.sqlite3"))
    session = agent_history.create_session(first_question="from sqlite")
    agent_history.append_message(session["id"], "user", "one")
    agent_history.append_message(session["id"], "assistant", "two")
    chat = chat_history.create_session(first_question="chat")
    chat_history.append_message(chat["id"], "user", "hi")
    article_store.upsert_article("a1", "Paper", "paper.pdf", tags=["x"])
    note = notes.create_note(title="Note", body_md="body")
    notes.add_attachment(note_id=note["note_id"], data_url=PNG, name="fig.png")
    visual_assets.upsert_visual_asset_blob(filename="f.png", content=b"\x00\xff", mime_type="image/png")

    monkeypatch.setenv("DATABASE_URL", TEST_URL)
    db.reset_for_tests()
    monkeypatch.setattr(migrate, "DATA_DIR", tmp_path)
    assert migrate.migrate_tables(dry_run=True) is True
    assert migrate.migrate_tables(dry_run=False) is True
    assert migrate.migrate_tables(dry_run=False) is True  # idempotent

    assert [m["content"] for m in agent_history.get_session(session["id"])["messages"]] == ["one", "two"]
    # the identity sequence moved past the copied ids
    agent_history.append_message(session["id"], "user", "three")
    assert [m["content"] for m in agent_history.recent_messages(session["id"], 10)] == ["one", "two", "three"]
    assert chat_history.get_session(chat["id"])["messages"][0]["content"] == "hi"
    assert article_store.find_articles_by_source("paper.pdf")[0]["tags"] == ["x"]
    assert notes.get_note(note["note_id"])["title"] == "Note"
    assert bytes(visual_assets.get_visual_asset_blob("f.png")["content"]) == b"\x00\xff"
    with db.connect(agent_history.DB_PATH) as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM note_attachments").fetchone()["n"] == 1

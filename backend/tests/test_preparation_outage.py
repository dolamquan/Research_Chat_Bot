"""A paper-store outage must be actionable and must not create ungrounded scenes."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from qdrant_client.http.exceptions import ResponseHandlingException

from app.rag import retriever, scene_service
from app.rag.retriever import PaperStoreUnavailable
from app.routes import visualizer


def test_connection_refusal_names_the_paper_database(monkeypatch):
    client = Mock()
    client.scroll.side_effect = ResponseHandlingException(ConnectionRefusedError("refused"))
    monkeypatch.setattr(retriever, "get_client", lambda: client)
    with pytest.raises(PaperStoreUnavailable, match="Qdrant"):
        retriever.retrieve_document_chunks("paper.pdf")


def test_pagination_keeps_normal_results(monkeypatch):
    point = SimpleNamespace(id="chunk", payload={"text": "paper excerpt"})
    client = Mock()
    client.scroll.side_effect = [([point], "next-page"), ([], None)]
    monkeypatch.setattr(retriever, "get_client", lambda: client)
    assert retriever.retrieve_document_chunks("paper.pdf")[0]["text"] == "paper excerpt"
    assert client.scroll.call_args.kwargs["offset"] == "next-page"


@pytest.mark.parametrize("endpoint,function,body", [
    ("generate", "generate_paper_visualization", {"article_id": "paper"}),
    ("expand-node", "expand_node", {"viz_id": "viz", "node_id": "stage"}),
    ("generate-stage-scene", "build_stage_scene", {"viz_id": "viz", "node_id": "stage"}),
    ("generate-scene", "build_scene", {"viz_id": "viz"}),
])
def test_visualizer_reports_service_unavailable(monkeypatch, endpoint, function, body):
    monkeypatch.setattr(visualizer, function, Mock(side_effect=PaperStoreUnavailable()))
    app = FastAPI()
    app.include_router(visualizer.router)
    response = TestClient(app).post(f"/visualizer/{endpoint}", json=body)
    assert response.status_code == 503
    assert "Qdrant" in response.json()["detail"]
    assert "saved scenes" in response.json()["detail"]


def test_missing_paper_store_does_not_call_model_or_save(monkeypatch):
    from app.storage import article_store

    monkeypatch.setattr(scene_service, "get_stage_scene", lambda *a: None)
    monkeypatch.setattr(scene_service, "get_visualization_by_id", lambda *a: {
        "article_id": "paper", "document_source": "paper.pdf",
        "diagram": {"nodes": [{"id": "stage"}]},
    })
    monkeypatch.setattr(scene_service, "get_node_expansion", lambda *a: None)
    monkeypatch.setattr(article_store, "get_article", lambda *a: {})
    monkeypatch.setattr(retriever, "retrieve_document_chunks", Mock(side_effect=PaperStoreUnavailable()))
    generate, save = Mock(), Mock()
    monkeypatch.setattr(scene_service, "generate_stage_code", generate)
    monkeypatch.setattr(scene_service, "upsert_stage_scene", save)
    with pytest.raises(PaperStoreUnavailable):
        scene_service.build_stage_scene("viz", "stage")
    generate.assert_not_called()
    save.assert_not_called()


def test_cached_scene_works_during_outage(monkeypatch):
    cached = {"scene": {"code": "function init(ctx) {} function update(ctx,t) {}"}}
    monkeypatch.setattr(scene_service, "get_stage_scene", lambda *a: cached)
    read = Mock(side_effect=PaperStoreUnavailable())
    monkeypatch.setattr(scene_service, "get_visualization_by_id", read)
    assert scene_service.build_stage_scene("viz", "stage") == cached
    read.assert_not_called()

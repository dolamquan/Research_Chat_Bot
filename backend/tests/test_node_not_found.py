"""A wrong node id is answered with the real ids, so an agent can correct itself."""

from __future__ import annotations

import pytest

from app.rag import scene_service


NODES = [{"id": "n1", "label": "Retriever"}, {"id": "n2", "label": "Top-k selection"}, {"id": "n3"}]


def test_message_lists_ids_with_labels():
    message = scene_service.describe_node_not_found("retriever", NODES)
    assert message.startswith("Node not found in diagram: retriever.")
    assert "n1 (Retriever), n2 (Top-k selection), n3." in message
    assert "not its label" in message
    assert scene_service.describe_node_not_found("x", []) == "Node not found in diagram: x. The diagram has no nodes. Use a node's id, not its label."


def test_build_stage_scene_raises_the_descriptive_error(monkeypatch):
    monkeypatch.setattr(scene_service, "get_stage_scene", lambda *a, **k: None)
    monkeypatch.setattr(scene_service, "get_visualization_by_id", lambda viz_id: {"diagram": {"nodes": NODES}})
    with pytest.raises(scene_service.NodeNotFound) as error:
        scene_service.build_stage_scene(viz_id="v1", node_id="seq2seq")
    assert "Diagram node ids are: n1 (Retriever)" in str(error.value)

"""The parametric scene graph: normalization, the layout linter, composition."""

from __future__ import annotations

import pytest

from app.rag.scene_graph import (
    MAX_GRAPH_NODES,
    MAX_TOTAL_INSTANCES,
    GraphNode,
    GraphTrack,
    MechanismGraph,
    compose_scene_graph,
    graph_to_dict,
    lint_graph,
    normalize_graph,
)


def make_node(node_id: str = "n1", **overrides) -> GraphNode:
    fields = {
        "node_id": node_id,
        "parent_id": "",
        "label": node_id,
        "geometry": "sphere",
        "size": [0.4],
        "tone": "primary",
        "opacity": 1.0,
        "emissive": 0.5,
        "position": [0.0, 0.0, 0.0],
        "rotation_deg": [],
        "count": 1,
        "layout": "single",
        "spacing": 0.0,
        "values": [],
        "items": [],
    }
    fields.update(overrides)
    return GraphNode(**fields)


def make_track(node_id: str = "n1", **overrides) -> GraphTrack:
    fields = {
        "node_id": node_id,
        "prop": "position_x",
        "times": [0.1, 0.6],
        "keys": [0.0, 3.0],
        "easing": "ease_in_out",
    }
    fields.update(overrides)
    return GraphTrack(**fields)


def make_graph(nodes, tracks=(), described: bool = True) -> MechanismGraph:
    return MechanismGraph(
        title="t",
        summary="s",
        caption="c",
        nodes=list(nodes),
        tracks=list(tracks),
        evidence="",
        described=described,
    )


class TestNormalizeGraph:
    def test_caps_nodes_and_drops_duplicate_ids(self):
        nodes = [make_node(f"n{i}") for i in range(MAX_GRAPH_NODES + 5)]
        nodes[1] = make_node("n0")  # duplicate
        graph = normalize_graph(make_graph(nodes))
        ids = [n.node_id for n in graph.nodes]
        assert len(ids) == len(set(ids))
        assert len(ids) <= MAX_GRAPH_NODES

    def test_breaks_parent_cycles(self):
        graph = normalize_graph(
            make_graph(
                [make_node("a", parent_id="b"), make_node("b", parent_id="a")]
            )
        )
        parents = {n.node_id: n.parent_id for n in graph.nodes}
        assert "" in parents.values()  # at least one node was re-rooted

    def test_reroots_unknown_and_self_parents(self):
        graph = normalize_graph(
            make_graph([make_node("a", parent_id="ghost"), make_node("b", parent_id="b")])
        )
        assert all(n.parent_id == "" for n in graph.nodes)

    def test_enforces_the_total_instance_budget(self):
        nodes = [make_node(f"n{i}", count=64, layout="grid", spacing=0.5) for i in range(10)]
        graph = normalize_graph(make_graph(nodes))
        # Every node keeps at least one instance, so the hard ceiling is the
        # budget plus one per node.
        assert sum(n.count for n in graph.nodes) <= MAX_TOTAL_INSTANCES + len(graph.nodes)
        assert any(n.count == 1 for n in graph.nodes)  # later nodes got squeezed

    def test_filters_non_finite_values_and_clamps_fields(self):
        graph = normalize_graph(
            make_graph(
                [
                    make_node(
                        "a",
                        opacity=7.0,
                        emissive=-3.0,
                        position=[99.0, float("nan"), -99.0],
                        values=[float("inf"), 0.5],
                        items=["", "  x  ", "y" * 60],
                    )
                ]
            )
        )
        node = graph.nodes[0]
        assert node.opacity == 1.0
        assert node.emissive == 0.0
        assert node.position == [12.0, -12.0]  # NaN dropped, rest clamped
        assert node.values == [0.5]
        assert node.items[0] == "x"
        assert all(len(i) <= 24 for i in node.items)

    def test_tracks_drop_unknown_nodes_and_sort_keyframes(self):
        graph = normalize_graph(
            make_graph(
                [make_node("a")],
                [
                    make_track("ghost"),
                    make_track("a", times=[0.8, 0.2], keys=[1.0, 0.0]),
                ],
            )
        )
        assert len(graph.tracks) == 1
        assert graph.tracks[0].times == [0.2, 0.8]
        assert graph.tracks[0].keys == [0.0, 1.0]

    def test_empty_graph_is_marked_undescribed(self):
        assert normalize_graph(make_graph([])).described is False


class TestLintGraph:
    def test_clean_graph_has_no_errors(self):
        graph = make_graph(
            [
                make_node("a", position=[-4.0, 0.0, 0.0]),
                make_node("b", position=[4.0, 0.0, 0.0]),
            ],
            [make_track("a")],
        )
        assert not [f for f in lint_graph(graph) if f.startswith("ERROR")]

    def test_flags_out_of_frame_nodes(self):
        graph = make_graph([make_node("a", position=[11.0, 0.0, 0.0])])
        assert any("outside the visible frame" in f for f in lint_graph(graph))

    def test_flags_overlapping_roots(self):
        graph = make_graph(
            [
                make_node("a", size=[2.0], position=[0.0, 0.0, 0.0]),
                make_node("b", size=[2.0], position=[0.2, 0.0, 0.0]),
            ]
        )
        assert any("overlap" in f for f in lint_graph(graph))

    def test_flags_graphs_that_copy_the_worked_example(self):
        parrot = make_graph(
            [
                make_node("a", position=[-4.5, 0.0, 0.0]),
                make_node("b", position=[0.0, 0.0, 0.0]),
                make_node("c", position=[4.5, 0.0, 0.0]),
            ],
            [
                make_track(
                    "b", prop="emissive",
                    times=[0.35, 0.5, 0.65], keys=[0.6, 2.0, 0.8],
                    easing="pulse",
                )
            ],
        )
        assert any("worked example" in f and f.startswith("ERROR") for f in lint_graph(parrot))

    def test_example_keyframes_alone_are_not_parroting(self):
        # Same keyframes but a different arrangement: legitimate reuse.
        graph = make_graph(
            [make_node("a", position=[-2.0, 1.0, 0.0])],
            [
                make_track(
                    "a", prop="emissive",
                    times=[0.35, 0.5, 0.65], keys=[0.6, 2.0, 0.8],
                    easing="pulse",
                )
            ],
        )
        assert not any("worked example" in f for f in lint_graph(graph))

    def test_warns_on_static_and_all_neutral_graphs(self):
        graph = make_graph([make_node("a", tone="neutral")])
        findings = "\n".join(lint_graph(graph))
        assert "never moves" in findings
        assert "neutral grey" in findings


class TestComposeSceneGraph:
    def test_returns_the_normalized_graph(self, stub_chat_model):
        raw = make_graph([make_node("a", count=500)], [make_track("a")])
        stub = stub_chat_model(structured=raw)
        graph = compose_scene_graph(
            stage_label="Input Embeddings",
            stage_detail="maps tokens to vectors",
            algorithm_name="Transformer",
            domain="computational",
            context="excerpts",
            llm=stub,
        )
        assert graph.nodes[0].count <= MAX_TOTAL_INSTANCES

    def test_prompt_carries_the_extracted_data(self, stub_chat_model):
        stub = stub_chat_model(
            structured=make_graph(
                [make_node("a", position=[-4.0, 0.0, 0.0])], [make_track("a")]
            )
        )
        compose_scene_graph(
            stage_label="s",
            stage_detail="d",
            algorithm_name="A",
            domain="computational",
            context="c",
            process_steps=[{"caption": "x", "items": ["the", "cat"], "values": [0.42]}],
            worked_example={"tokens": ["the", "cat", "sat"]},
            llm=stub,
        )
        prompt = stub.prompts[0]
        assert "the, cat, sat" in prompt
        assert "0.42" in prompt
        assert "GEOMETRY" in prompt  # vocabulary made it in

    def test_layout_errors_trigger_one_repair_pass(self, stub_chat_model):
        overlapping = make_graph(
            [
                make_node("a", size=[2.0], position=[0.0, 0.0, 0.0]),
                make_node("b", size=[2.0], position=[0.1, 0.0, 0.0]),
            ]
        )
        stub = stub_chat_model(structured=overlapping)
        compose_scene_graph(
            stage_label="s",
            stage_detail="d",
            algorithm_name="A",
            domain="general",
            context="c",
            llm=stub,
        )
        # First compose + one repair attempt (the stub returns the same
        # overlapping graph, so the repair is not kept -- but it was tried).
        assert len(stub.prompts) == 2
        assert "layout problems" in stub.prompts[1]

    def test_clean_graphs_skip_the_repair_pass(self, stub_chat_model):
        clean = make_graph(
            [make_node("a", position=[-4.0, 0.0, 0.0])], [make_track("a")]
        )
        stub = stub_chat_model(structured=clean)
        compose_scene_graph(
            stage_label="s",
            stage_detail="d",
            algorithm_name="A",
            domain="general",
            context="c",
            llm=stub,
        )
        assert len(stub.prompts) == 1


def test_the_shared_fixture_parses_normalizes_and_lints_clean():
    """The frontend renders this exact file; both sides must accept it."""
    import json
    from pathlib import Path

    payload = json.loads(
        (Path(__file__).parent / "fixtures" / "mechanism" / "embedding_scene_graph.json")
        .read_text(encoding="utf-8")
    )
    graph = normalize_graph(MechanismGraph(**payload))
    assert graph.described is True
    assert len(graph.nodes) == 4
    assert not [f for f in lint_graph(graph) if f.startswith("ERROR")]


def test_graph_round_trips_and_carries_its_version():
    graph = normalize_graph(make_graph([make_node("a")], [make_track("a")]))
    payload = graph_to_dict(graph)
    assert payload["graph_schema_version"] == 1
    again = MechanismGraph(**payload)
    assert graph_to_dict(again) == payload

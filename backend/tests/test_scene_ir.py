"""Scene IR validation: the rules that make a scene safe to render."""

from __future__ import annotations

import pytest

from app.rag.scene_ir import (
    MAX_ENTITIES,
    MAX_STEPS,
    SUPPORTED_PRIMITIVES,
    AlgorithmScene,
    SceneIRError,
    normalize_primitive,
    parse_scene,
    scene_to_dict,
)


def test_fixtures_parse(all_scene_fixtures):
    assert len(all_scene_fixtures) == 3
    for payload in all_scene_fixtures:
        scene = parse_scene(payload)
        assert scene.schema_version == "1.0"
        assert scene.steps and scene.entities


def test_round_trip_is_stable(transformer_scene):
    scene = parse_scene(transformer_scene)
    again = parse_scene(scene_to_dict(scene))
    assert scene_to_dict(scene) == scene_to_dict(again)


def test_unknown_primitive_is_rejected(transformer_scene):
    transformer_scene["steps"][0]["primitive"] = "summon_gpu_daemon"
    with pytest.raises(SceneIRError) as excinfo:
        parse_scene(transformer_scene)
    assert "primitive" in str(excinfo.value).lower()


def test_every_supported_primitive_is_constructible(transformer_scene):
    # Guards against a primitive being added to the Literal but not the tuple.
    for primitive in SUPPORTED_PRIMITIVES:
        payload = dict(transformer_scene)
        payload["steps"] = [
            {
                "id": "only",
                "primitive": primitive,
                "caption": "c",
                "input_ids": [],
                "output_ids": [],
                "evidence_ids": [],
            }
        ]
        payload["camera_cues"] = []
        assert parse_scene(payload).steps[0].primitive == primitive


def test_duplicate_entity_id_is_rejected(transformer_scene):
    first = transformer_scene["entities"][0]
    transformer_scene["entities"].append(dict(first))
    with pytest.raises(SceneIRError, match="duplicate entity id"):
        parse_scene(transformer_scene)


def test_duplicate_step_id_is_rejected(transformer_scene):
    transformer_scene["steps"].append(dict(transformer_scene["steps"][0]))
    with pytest.raises(SceneIRError, match="duplicate step id"):
        parse_scene(transformer_scene)


def test_duplicate_evidence_id_is_rejected(transformer_scene):
    transformer_scene["evidence"].append(dict(transformer_scene["evidence"][0]))
    with pytest.raises(SceneIRError, match="duplicate evidence id"):
        parse_scene(transformer_scene)


def test_dangling_entity_reference_is_rejected(transformer_scene):
    transformer_scene["steps"][0]["input_ids"] = ["no_such_entity"]
    with pytest.raises(SceneIRError, match="unknown input entity"):
        parse_scene(transformer_scene)


def test_dangling_output_reference_is_rejected(transformer_scene):
    transformer_scene["steps"][0]["output_ids"] = ["ghost"]
    with pytest.raises(SceneIRError, match="unknown output entity"):
        parse_scene(transformer_scene)


def test_dangling_evidence_reference_is_rejected(transformer_scene):
    transformer_scene["steps"][0]["evidence_ids"] = ["ev_imaginary"]
    with pytest.raises(SceneIRError, match="unknown evidence"):
        parse_scene(transformer_scene)


def test_entity_dangling_evidence_is_rejected(transformer_scene):
    transformer_scene["entities"][0]["evidence_ids"] = ["ev_nope"]
    with pytest.raises(SceneIRError, match="unknown evidence"):
        parse_scene(transformer_scene)


def test_camera_cue_must_reference_a_real_step(transformer_scene):
    transformer_scene["camera_cues"] = [
        {"step_id": "not_a_step", "focus_entity_ids": [], "framing": "overview",
         "transition_ms": 500}
    ]
    with pytest.raises(SceneIRError, match="unknown step"):
        parse_scene(transformer_scene)


@pytest.mark.parametrize("duration", [0, 10, 60_000])
def test_duration_out_of_range_is_rejected(transformer_scene, duration):
    transformer_scene["steps"][0]["duration_ms"] = duration
    with pytest.raises(SceneIRError, match="duration_ms"):
        parse_scene(transformer_scene)


@pytest.mark.parametrize("confidence", [-0.1, 1.5])
def test_confidence_out_of_range_is_rejected(transformer_scene, confidence):
    transformer_scene["steps"][0]["confidence"] = confidence
    with pytest.raises(SceneIRError, match="confidence"):
        parse_scene(transformer_scene)


def test_entity_budget_is_enforced(transformer_scene):
    transformer_scene["entities"] = [
        {"id": f"e{i}", "label": f"E{i}", "kind": "component",
         "semantic_role": "", "group": None, "evidence_ids": []}
        for i in range(MAX_ENTITIES + 1)
    ]
    transformer_scene["steps"] = []
    transformer_scene["camera_cues"] = []
    with pytest.raises(SceneIRError, match="entities"):
        parse_scene(transformer_scene)


def test_step_budget_is_enforced(transformer_scene):
    transformer_scene["steps"] = [
        {"id": f"s{i}", "primitive": "note", "caption": "c",
         "input_ids": [], "output_ids": [], "evidence_ids": []}
        for i in range(MAX_STEPS + 1)
    ]
    transformer_scene["camera_cues"] = []
    with pytest.raises(SceneIRError, match="steps"):
        parse_scene(transformer_scene)


def test_scene_carries_no_executable_fields(transformer_scene):
    """The IR must not have grown a field that could carry code."""
    banned = {"code", "build_code", "update_code", "script", "shader", "html", "jsx"}
    fields = set(AlgorithmScene.model_fields)
    from app.rag.scene_ir import SceneStep

    fields |= set(SceneStep.model_fields)
    assert not (fields & banned), f"executable-looking field present: {fields & banned}"


def test_total_duration_is_the_sum_of_steps(transformer_scene):
    scene = parse_scene(transformer_scene)
    assert scene.total_duration_ms() == sum(s.duration_ms for s in scene.steps)


@pytest.mark.parametrize(
    "legacy,expected",
    [
        ("token_stream", "token_stream"),
        ("transport", "data_transfer"),
        ("differentiate", "state_transition"),
        ("not_described", "note"),
        ("utterly_unknown", "note"),
    ],
)
def test_legacy_primitive_normalisation(legacy, expected):
    assert normalize_primitive(legacy) == expected

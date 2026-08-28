"""Deterministic verification: what a scene is allowed to get away with."""

from __future__ import annotations

from app.rag.scene_ir import parse_scene
from app.rag.scene_verifier import LOW_GROUNDING_RATIO, verify_scene


def codes(report) -> set[str]:
    return {finding.code for finding in report.findings}


def test_fixtures_verify_clean(all_scene_fixtures):
    for payload in all_scene_fixtures:
        report = verify_scene(parse_scene(payload))
        assert report.valid, f"{payload['algorithm_name']}: {codes(report)}"
        assert report.grounded_step_ratio == 1.0


def test_empty_scene_is_an_error():
    scene = parse_scene(
        {
            "schema_version": "1.0",
            "title": "",
            "algorithm_name": "",
            "visualization_mode": "2d",
            "summary": "",
            "entities": [],
            "evidence": [],
            "steps": [],
            "camera_cues": [],
        }
    )
    report = verify_scene(scene)
    assert not report.valid
    assert "empty_scene" in codes(report)
    assert "no_entities" in codes(report)


def test_ungrounded_steps_are_warned_and_counted(transformer_scene):
    for step in transformer_scene["steps"]:
        step["evidence_ids"] = []
    report = verify_scene(parse_scene(transformer_scene))
    assert "ungrounded_steps" in codes(report)
    assert report.grounded_step_ratio == 0.0
    # Below the threshold, so this is an error rather than merely a warning.
    assert "low_grounding" in codes(report)
    assert not report.valid


def test_partial_grounding_above_threshold_stays_valid(transformer_scene):
    # Strip evidence from one of five steps: 80% grounded, above the floor.
    transformer_scene["steps"][0]["evidence_ids"] = []
    report = verify_scene(parse_scene(transformer_scene))
    assert report.grounded_step_ratio > LOW_GROUNDING_RATIO
    assert "low_grounding" not in codes(report)
    assert report.valid


def test_input_consumed_before_it_is_produced(transformer_scene):
    # Make the first step consume something only the last step produces.
    transformer_scene["steps"][0]["input_ids"] = ["context"]
    report = verify_scene(parse_scene(transformer_scene))
    assert "input_before_creation" in codes(report)
    assert not report.valid


def test_disconnected_entity_is_warned(transformer_scene):
    transformer_scene["entities"].append(
        {
            "id": "orphan",
            "label": "Unused thing",
            "kind": "component",
            "semantic_role": "",
            "group": None,
            "evidence_ids": [],
        }
    )
    report = verify_scene(parse_scene(transformer_scene))
    assert "disconnected_entity" in codes(report)
    finding = next(f for f in report.findings if f.code == "disconnected_entity")
    assert "orphan" in finding.entity_ids


def test_impossible_loop_is_an_error(transformer_scene):
    transformer_scene["steps"] = [
        {
            "id": "spin",
            "primitive": "loop_repeat",
            "caption": "loops over nothing",
            "input_ids": [],
            "output_ids": [],
            "evidence_ids": ["ev_abstract"],
            "execution": "loop",
            "count": 4,
        }
    ]
    transformer_scene["camera_cues"] = []
    report = verify_scene(parse_scene(transformer_scene))
    assert "impossible_loop" in codes(report)
    assert not report.valid


def test_unsupported_confidence_is_flagged(transformer_scene):
    transformer_scene["steps"][0]["evidence_ids"] = []
    transformer_scene["steps"][0]["confidence"] = 0.95
    report = verify_scene(parse_scene(transformer_scene))
    assert "unsupported_confidence" in codes(report)


def test_illustrative_values_are_distinguished(transformer_scene):
    # Values present, evidence absent: illustrative, and reported as such.
    transformer_scene["steps"][2]["evidence_ids"] = []
    report = verify_scene(parse_scene(transformer_scene))
    finding = next(f for f in report.findings if f.code == "illustrative_values")
    assert finding.severity == "info"
    assert "s3" in finding.step_ids


def test_unused_evidence_is_only_informational(transformer_scene):
    transformer_scene["evidence"].append(
        {
            "evidence_id": "ev_spare",
            "chunk_id": None,
            "section": "Appendix",
            "page": 9,
            "quote": "Something nobody cites.",
            "confidence": 0.5,
        }
    )
    report = verify_scene(parse_scene(transformer_scene))
    assert "unused_evidence" in codes(report)
    assert report.valid


def test_report_serialises(transformer_scene):
    report = verify_scene(parse_scene(transformer_scene))
    payload = report.model_dump(mode="json")
    assert set(payload) >= {
        "valid",
        "findings",
        "entity_count",
        "step_count",
        "grounded_entity_ratio",
        "grounded_step_ratio",
    }

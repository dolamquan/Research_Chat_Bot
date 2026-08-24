"""Planning: structured output, the JSON fallback, and the repair attempt.

Every test drives a stub client, so nothing here reaches a provider.
"""

from __future__ import annotations

import json

import pytest

from app.rag.document_structure import (
    EXTRACTION_LEGACY,
    PaperFigure,
    PaperSection,
    StructuredPaper,
)
from app.rag.scene_ir import AlgorithmScene, parse_scene
from app.rag.scene_planner import (
    ScenePlanningError,
    generate_algorithm_scene,
    scene_from_process_steps,
)


@pytest.fixture
def structured_paper() -> StructuredPaper:
    return StructuredPaper(
        title="Test Method",
        abstract="We propose a test method that encodes then decodes.",
        sections=[
            PaperSection(
                section_id="sec_1",
                title="Proposed Method",
                text="The encoder maps the input to a latent code.",
                page_start=3,
                page_end=3,
                section_type="method",
            ),
            PaperSection(
                section_id="sec_2",
                title="Related Work",
                text="Others have used entirely different architectures.",
                page_start=2,
                page_end=2,
                section_type="excluded",
            ),
        ],
        figures=[
            PaperFigure(
                figure_id="fig_1",
                caption="Figure 1: Overview of the proposed architecture.",
                page=3,
                image_ref=None,
                surrounding_text="",
            )
        ],
        equations=[],
        extraction_strategy=EXTRACTION_LEGACY,
    )


def _minimal_scene_payload() -> dict:
    return {
        "schema_version": "1.0",
        "title": "Test Method",
        "algorithm_name": "Test Method",
        "visualization_mode": "2d",
        "summary": "Encode then decode.",
        "entities": [
            {"id": "input", "label": "Input", "kind": "input", "semantic_role": "",
             "group": None, "evidence_ids": ["ev_abstract"]},
            {"id": "encoder", "label": "Encoder", "kind": "operation",
             "semantic_role": "", "group": None, "evidence_ids": ["ev_sec_1"]},
        ],
        "evidence": [
            {"evidence_id": "ev_abstract", "chunk_id": None, "section": "Abstract",
             "page": None, "quote": "placeholder", "confidence": 0.9},
            {"evidence_id": "ev_sec_1", "chunk_id": None, "section": "Proposed Method",
             "page": 3, "quote": "placeholder", "confidence": 0.9},
        ],
        "steps": [
            {"id": "s1", "node_id": "encoder", "primitive": "matrix_transform",
             "caption": "The encoder maps input to a latent code.", "detail": "",
             "items": [], "values": [], "count": 4, "label_in": "input",
             "label_out": "latent", "input_ids": ["input"], "output_ids": ["encoder"],
             "execution": "sequential", "duration_ms": 1200,
             "evidence_ids": ["ev_sec_1"], "confidence": 0.9},
        ],
        "camera_cues": [],
    }


def test_structured_path_is_used_when_available(
    stub_chat_model, sample_visualization, structured_paper
):
    scene_obj = parse_scene(_minimal_scene_payload())
    client = stub_chat_model(structured=scene_obj)

    scene, origin = generate_algorithm_scene(
        visualization=sample_visualization,
        article={"title": "Test Method"},
        structured_paper=structured_paper,
        chunks=[],
        llm=client,
    )

    assert isinstance(scene, AlgorithmScene)
    assert client.structured_calls == 1
    assert scene.steps[0].primitive == "matrix_transform"
    assert origin["model"] == "stub-model"


def test_json_fallback_when_structured_output_unsupported(
    stub_chat_model, sample_visualization, structured_paper
):
    client = stub_chat_model(
        structured_raises=True,
        responses=[json.dumps(_minimal_scene_payload())],
    )
    scene, _origin = generate_algorithm_scene(
        visualization=sample_visualization,
        article=None,
        structured_paper=structured_paper,
        chunks=[],
        llm=client,
    )
    assert scene.steps[0].id == "s1"


def test_json_fence_is_stripped(stub_chat_model, sample_visualization, structured_paper):
    fenced = "```json\n" + json.dumps(_minimal_scene_payload()) + "\n```"
    client = stub_chat_model(structured_raises=True, responses=[fenced])
    scene, _ = generate_algorithm_scene(
        visualization=sample_visualization,
        article=None,
        structured_paper=structured_paper,
        chunks=[],
        llm=client,
    )
    assert scene.entities[0].id == "input"


def test_one_repair_attempt_recovers_from_invalid_json(
    stub_chat_model, sample_visualization, structured_paper
):
    broken = json.dumps({"schema_version": "1.0", "steps": [{"id": "s1",
                        "primitive": "not_a_primitive"}]})
    client = stub_chat_model(
        structured_raises=True,
        responses=[broken, json.dumps(_minimal_scene_payload())],
    )
    scene, _ = generate_algorithm_scene(
        visualization=sample_visualization,
        article=None,
        structured_paper=structured_paper,
        chunks=[],
        llm=client,
    )
    assert scene.steps[0].id == "s1"
    # The repair prompt must state what was wrong.
    assert "rejected" in client.prompts[-1]


def test_two_failures_raise_planning_error(
    stub_chat_model, sample_visualization, structured_paper
):
    client = stub_chat_model(
        structured_raises=True, responses=["not json at all", "still not json"]
    )
    with pytest.raises(ScenePlanningError, match="could not produce a valid scene"):
        generate_algorithm_scene(
            visualization=sample_visualization,
            article=None,
            structured_paper=structured_paper,
            chunks=[],
            llm=client,
        )


def test_invented_evidence_ids_are_dropped(
    stub_chat_model, sample_visualization, structured_paper
):
    """A citation to an id we never offered is removed, not trusted."""
    payload = _minimal_scene_payload()
    payload["evidence"].append(
        {"evidence_id": "ev_hallucinated", "chunk_id": None, "section": "Nowhere",
         "page": 99, "quote": "invented", "confidence": 0.99}
    )
    payload["steps"][0]["evidence_ids"] = ["ev_sec_1", "ev_hallucinated"]
    client = stub_chat_model(structured=parse_scene(payload))

    scene, _ = generate_algorithm_scene(
        visualization=sample_visualization,
        article=None,
        structured_paper=structured_paper,
        chunks=[],
        llm=client,
    )
    ids = {ref.evidence_id for ref in scene.evidence}
    assert "ev_hallucinated" not in ids
    assert "ev_hallucinated" not in scene.steps[0].evidence_ids


def test_quotes_come_from_our_candidates_not_the_model(
    stub_chat_model, sample_visualization, structured_paper
):
    """The model supplies ids; the authoritative text is ours."""
    payload = _minimal_scene_payload()
    payload["evidence"][1]["quote"] = "A paraphrase the paper never said."
    client = stub_chat_model(structured=parse_scene(payload))

    scene, _ = generate_algorithm_scene(
        visualization=sample_visualization,
        article=None,
        structured_paper=structured_paper,
        chunks=[],
        llm=client,
    )
    ref = scene.evidence_by_id("ev_sec_1")
    assert ref is not None
    assert ref.quote == "The encoder maps the input to a latent code."


def test_prompt_excludes_related_work(
    stub_chat_model, sample_visualization, structured_paper
):
    client = stub_chat_model(structured=parse_scene(_minimal_scene_payload()))
    generate_algorithm_scene(
        visualization=sample_visualization,
        article=None,
        structured_paper=structured_paper,
        chunks=[],
        llm=client,
    )
    # `with_structured_output` returns the stub itself, so the prompt reaches
    # `invoke` only on the JSON path; assert on the built prompt instead.
    from app.rag.scene_planner import _build_prompt
    from app.rag.document_structure import evidence_candidates

    prompt = _build_prompt(
        sample_visualization, None, structured_paper,
        evidence_candidates(structured_paper), [],
    )
    assert "entirely different architectures" not in prompt
    assert "The encoder maps the input to a latent code." in prompt
    assert "proposed architecture" in prompt.lower()


def test_prompt_offers_the_diagram_node_ids(
    sample_visualization, structured_paper
):
    from app.rag.scene_planner import _build_prompt
    from app.rag.document_structure import evidence_candidates

    prompt = _build_prompt(
        sample_visualization, None, structured_paper,
        evidence_candidates(structured_paper), [],
    )
    for node_id in ("input", "encoder", "output"):
        assert node_id in prompt


def test_scene_from_process_steps_needs_no_model(sample_visualization):
    expansions = [
        {
            "node_id": "encoder",
            "content": {
                "process_steps": [
                    {"primitive": "matrix_transform", "caption": "project",
                     "items": [], "values": [1.0, 2.0], "count": 4,
                     "label_in": "x", "label_out": "z", "detail": ""},
                    {"primitive": "not_described", "caption": "unclear",
                     "items": [], "values": [], "count": 0,
                     "label_in": "", "label_out": "", "detail": ""},
                ]
            },
        }
    ]
    scene = scene_from_process_steps(sample_visualization, expansions)
    assert len(scene.steps) == 2
    assert scene.steps[0].primitive == "matrix_transform"
    # The legacy gap primitive maps onto `note`, asserting no mechanism.
    assert scene.steps[1].primitive == "note"
    # Nothing derived this way is grounded, and it says so.
    assert all(step.evidence_ids == [] for step in scene.steps)
    assert all(step.confidence < 0.5 for step in scene.steps)

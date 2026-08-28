"""The model must never produce executable content.

This is the project's central security property, so it gets its own suite rather
than being implied by other tests. A regression here is not a cosmetic
regression.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
FRONTEND_VIS = (
    BACKEND.parent / "frontend" / "src" / "app" / "components" / "visualization"
)


def test_scene_ir_has_no_field_that_could_carry_code():
    from app.rag.scene_ir import (
        AlgorithmScene,
        CameraCue,
        EvidenceRef,
        SceneEntity,
        SceneStep,
    )

    banned = {
        "code", "build_code", "update_code", "script", "shader", "html",
        "jsx", "javascript", "eval", "expression", "formula_code", "callback",
    }
    for model in (AlgorithmScene, SceneEntity, SceneStep, EvidenceRef, CameraCue):
        overlap = set(model.model_fields) & banned
        assert not overlap, f"{model.__name__} exposes {overlap}"


def test_primitive_is_a_closed_enum():
    """The one field the model chooses freely must be a fixed whitelist."""
    from app.rag.scene_ir import SUPPORTED_PRIMITIVES, SceneStep

    annotation = SceneStep.model_fields["primitive"].annotation
    literal_values = set(getattr(annotation, "__args__", ()))
    assert literal_values == set(SUPPORTED_PRIMITIVES)
    assert len(SUPPORTED_PRIMITIVES) == 16


def test_the_planner_never_executes_model_output():
    """No dynamic-execution builtin appears anywhere in the scene pipeline."""
    from app.rag import scene_planner, scene_service, scene_verifier

    forbidden = re.compile(
        r"\b(eval|exec|compile)\s*\(|__import__|subprocess|os\.system"
    )
    for module in (scene_planner, scene_service, scene_verifier):
        source = inspect.getsource(module)
        found = forbidden.findall(source)
        assert not found, f"{module.__name__} contains dynamic execution: {found}"


def test_the_retired_code_generator_is_no_longer_called():
    """`paper_visualizer` must not request executable animation code."""
    from app.rag import paper_visualizer

    source = inspect.getsource(paper_visualizer)
    assert "generate_stage_animation" not in source
    assert "animation_to_dict" not in source


@pytest.mark.parametrize(
    "pattern",
    [
        r"\beval\s*\(",
        r"new\s+Function\s*\(",
        r"dangerouslySetInnerHTML",
        r"srcDoc\s*=",
        r"import\s*\(\s*[a-zA-Z_$][\w$]*\s*\)",  # dynamic import of a variable
    ],
)
def test_frontend_visualization_package_is_free_of_execution_paths(pattern):
    """Scan the shipped visualization package, not just the modules we recall."""
    compiled = re.compile(pattern)
    offenders = []
    for path in FRONTEND_VIS.rglob("*.ts*"):
        if "__tests__" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        if compiled.search(text):
            offenders.append(path.name)
    assert not offenders, f"{pattern} found in {offenders}"


def test_primitive_registry_and_whitelist_agree():
    """A drift here would silently degrade real scenes to the note fallback."""
    from app.rag.scene_ir import SUPPORTED_PRIMITIVES

    compiler = (FRONTEND_VIS / "SceneCompiler.tsx").read_text(encoding="utf-8")
    registry_block = compiler.split("primitiveRegistry", 1)[1].split("});", 1)[0]
    registered = set(re.findall(r"^\s{2}(\w+):", registry_block, re.M))
    assert registered == set(SUPPORTED_PRIMITIVES), (
        f"only in registry: {registered - set(SUPPORTED_PRIMITIVES)}; "
        f"only in IR: {set(SUPPORTED_PRIMITIVES) - registered}"
    )


def test_frontend_whitelist_matches_the_backend():
    from app.rag.scene_ir import SUPPORTED_PRIMITIVES

    types_source = (FRONTEND_VIS / "sceneTypes.ts").read_text(encoding="utf-8")
    block = types_source.split("SUPPORTED_PRIMITIVES", 1)[1].split("] as const", 1)[0]
    listed = set(re.findall(r'"(\w+)"', block))
    assert listed == set(SUPPORTED_PRIMITIVES)


def test_evidence_quotes_are_not_taken_from_the_model():
    """Quote text must come from our candidate list, never the model's output."""
    from app.rag.scene_planner import _attach_evidence_text
    from app.rag.scene_ir import parse_scene

    scene = parse_scene(
        {
            "schema_version": "1.0",
            "title": "t",
            "algorithm_name": "a",
            "visualization_mode": "2d",
            "summary": "",
            "entities": [],
            "evidence": [
                {"evidence_id": "ev_1", "chunk_id": None, "section": "Invented",
                 "page": 99, "quote": "A sentence the paper never contained.",
                 "confidence": 0.99}
            ],
            "steps": [],
            "camera_cues": [],
        }
    )
    candidates = [
        {"evidence_id": "ev_1", "section": "Method", "page": 3,
         "quote": "The real sentence from the paper."}
    ]
    patched = _attach_evidence_text(scene, candidates)
    ref = patched.evidence_by_id("ev_1")
    assert ref is not None
    assert ref.quote == "The real sentence from the paper."
    assert ref.section == "Method"
    assert ref.page == 3

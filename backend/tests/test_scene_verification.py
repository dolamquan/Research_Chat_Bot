"""Runtime verdicts, evidence-driven repair, and user-directed refinement.

The backend cannot execute Three.js. What it can do is (1) turn the browser's
verdict on a scene into a stored fact, (2) hand the failing code and the real
error back to the model as a repair, and (3) refuse to alter what an animation
shows about a paper until the user has acknowledged that is what they asked
for. Every test here runs offline.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.rag import scene_service
from app.rag.document_structure import StructuredPaper
from app.rag.scene_coder import (
    CODE_RULES,
    SCHEMA_VERSION,
    STAGE_CODE_RULES,
    RefinementClassification,
    SceneCodingError,
    classify_refinement,
    format_layout_report,
    generate_scene_code,
    generate_stage_code,
    refine_scene_code,
    scene_code_from_diagram,
)
from app.rag.scene_requests import share_scene_request
from app.storage import scene_store, stage_scene_store, visualization_store

GOOD_CODE = """\
const state = {};
function init(ctx) {
  const { THREE, scene } = ctx;
  state.box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x4fc3f7 })
  );
  scene.add(state.box);
  ctx.setCaption("A box rotates.");
}
function update(ctx, t) {
  state.box.rotation.y = t;
}
"""

CRASHING_CODE = (
    "const state = { rows: 3 };\n"
    "function init(ctx) { state.rows.forEach((r) => r); }\n"
    "function update(ctx, t) {}\n"
)

RUNTIME_ERROR = "TypeError: state.rows.forEach is not a function\n    at init (<anonymous>:2:33)"


class _Offline:
    """A client that cannot be reached: forces every classification onto the heuristic."""

    def with_structured_output(self, *_args, **_kwargs):
        raise RuntimeError("offline")

    def invoke(self, *_args, **_kwargs):
        raise RuntimeError("offline")


@pytest.fixture
def paper() -> StructuredPaper:
    return StructuredPaper(title="Test Paper", sections=[], figures=[], equations=[])


@pytest.fixture(autouse=True)
def temp_db(monkeypatch, tmp_path: Path):
    db = tmp_path / "verification.sqlite3"
    for module in (visualization_store, scene_store, stage_scene_store):
        monkeypatch.setattr(module, "DB_PATH", db)
        monkeypatch.setattr(module, "DATA_DIR", tmp_path)
    scene_store.init_db()
    stage_scene_store.init_db()
    return db


@pytest.fixture(autouse=True)
def _act_as_local_admin():
    from app.auth.context import LOCAL_USER, reset_current_user, set_current_user

    token = set_current_user(LOCAL_USER)
    yield
    reset_current_user(token)


@pytest.fixture
def client() -> TestClient:
    from app.main import app

    return TestClient(app)


def _seed_scene(sample_visualization, viz_id="viz_1"):
    scene = scene_code_from_diagram(sample_visualization)
    return scene_store.upsert_scene(
        viz_id=viz_id, article_id="article_1", scene=scene,
        verification={"valid": True, "findings": [], "checks": "static"},
        provider="openai", model="gpt-4o-mini", schema_version=SCHEMA_VERSION,
    )


def _seed_stage(sample_visualization, viz_id="viz_1", node_id="encoder", code=None):
    scene = scene_code_from_diagram(sample_visualization)
    scene["node_id"] = node_id
    if code is not None:
        scene["code"] = code
    return stage_scene_store.upsert_stage_scene(
        viz_id=viz_id, node_id=node_id, scene=scene,
        verification={"valid": True, "findings": [], "checks": "static"},
        provider="openai", model="gpt-5", schema_version=SCHEMA_VERSION,
    )


# --- the prompt forbids what the probe measures ------------------------------------


def test_presentation_rules_forbid_overlapping_text():
    for rules in (CODE_RULES, STAGE_CODE_RULES):
        assert "TEXT MUST NEVER OVERLAP" in rules
        assert "Exactly one label per anchor" in rules
        assert "ctx.setCaption, not in a floating label" in rules


# --- runtime evidence turns generation into repair ---------------------------------


def test_runtime_error_turns_stage_generation_into_a_repair(stub_chat_model, sample_visualization):
    llm = stub_chat_model(responses=[GOOD_CODE])
    scene, _ = generate_stage_code(
        visualization=sample_visualization,
        node=sample_visualization["diagram"]["nodes"][1],
        llm=llm,
        previous_code=CRASHING_CODE,
        runtime_error=RUNTIME_ERROR,
    )
    assert len(llm.prompts) == 1, "a runtime repair is the first request, not a retry"
    prompt = llm.prompts[0]
    assert "passed the static checks but must be fixed" in prompt
    assert "RUNTIME ERROR" in prompt and "forEach is not a function" in prompt
    assert CRASHING_CODE in prompt
    assert "fix the cause, not the symptom" in prompt
    assert scene["code"] == GOOD_CODE.strip()


def test_layout_report_names_each_colliding_pair_and_when(stub_chat_model, sample_visualization, paper):
    llm = stub_chat_model(responses=[GOOD_CODE])
    report = {
        "pairs": [
            {"a": 'emb("I")', "b": "0.20", "seconds": [3, 6]},
            {"a": "Scale by √d_model", "b": "figure", "seconds": [9]},
        ],
        "samples": 8,
    }
    generate_scene_code(
        visualization=sample_visualization, article=None, structured_paper=paper,
        llm=llm, previous_code=GOOD_CODE, layout_report=report,
    )
    prompt = llm.prompts[0]
    assert "MEASURED OVERLAPS" in prompt
    assert "'emb(\"I\")' overlaps '0.20' at 3s, 6s" in prompt
    assert "'Scale by √d_model' overlaps 'figure' at 9s" in prompt
    assert "Do not shrink text to fit" in prompt
    assert "Keep everything else about the animation the same" in prompt


def test_previous_code_without_evidence_is_a_fresh_generation(stub_chat_model, sample_visualization):
    """A plain forced regenerate must not anchor the model on the old program."""
    llm = stub_chat_model(responses=[GOOD_CODE])
    generate_stage_code(
        visualization=sample_visualization,
        node=sample_visualization["diagram"]["nodes"][0],
        llm=llm,
        previous_code="const OLD_PROGRAM = 1;",
    )
    assert "OLD_PROGRAM" not in llm.prompts[0]
    assert "RUNTIME ERROR" not in llm.prompts[0]


def test_runtime_repair_still_gets_one_static_repair(stub_chat_model, sample_visualization):
    llm = stub_chat_model(responses=["const nope = 1;", GOOD_CODE])
    scene, _ = generate_stage_code(
        visualization=sample_visualization,
        node=sample_visualization["diagram"]["nodes"][0],
        llm=llm, previous_code=CRASHING_CODE, runtime_error=RUNTIME_ERROR,
    )
    assert len(llm.prompts) == 2
    assert "rejected for these reasons" in llm.prompts[1]
    assert scene["code"] == GOOD_CODE.strip()


def test_empty_layout_report_formats_to_nothing():
    assert format_layout_report(None) == ""
    assert format_layout_report({"pairs": []}) == ""


def test_dict_arguments_still_share_one_call():
    """The coalescer keys on arguments; a layout report is a dict and must hash."""
    calls = []

    @share_scene_request
    def build(viz_id, layout_report=None):
        calls.append(layout_report)
        return len(calls)

    assert build("v", layout_report={"pairs": [{"a": "x", "b": "y"}]}) == 1
    assert build("v", layout_report={"pairs": [{"b": "y", "a": "x"}]}) == 2
    assert calls == [{"pairs": [{"a": "x", "b": "y"}]}, {"pairs": [{"b": "y", "a": "x"}]}]


# --- refinement: classification ------------------------------------------------------


@pytest.mark.parametrize(
    "instruction, kind",
    [
        ("The value labels overlap the bars, move them below the baseline", "cosmetic"),
        ("make the text bigger and slow the animation down", "cosmetic"),
        ("the caption is hidden behind the matrix; shift the matrix left", "cosmetic"),
        ("add a step that normalizes the scores before the softmax", "fundamental"),
        ("use a different formula: multiply instead of add", "fundamental"),
        ("swap the order so attention happens after the feed-forward sum", "fundamental"),
    ],
)
def test_heuristic_classification(instruction, kind):
    result = classify_refinement(instruction, llm=_Offline())
    assert result["kind"] == kind
    assert result["basis"] == "heuristic"
    assert result["reason"]


def test_heuristic_matches_whole_words_only():
    # "update", "summary" and "baseline" must not count as "up", "sum", "line".
    result = classify_refinement("update the summary caption under the baseline", llm=_Offline())
    assert result["kind"] == "cosmetic"


def test_model_classification_is_preferred_and_labelled(stub_chat_model):
    llm = stub_chat_model(structured=RefinementClassification(kind="fundamental", reason="It adds a step."))
    result = classify_refinement("tweak the flow", title="Encoder", llm=llm)
    assert result == {"kind": "fundamental", "reason": "It adds a step.", "basis": "model"}
    assert "Encoder" in llm.prompts[0] and "tweak the flow" in llm.prompts[0]


def test_empty_instruction_is_cosmetic_without_a_model_call():
    assert classify_refinement("   ", llm=_Offline())["kind"] == "cosmetic"


# --- refinement: rewriting -------------------------------------------------------------


def test_refine_applies_only_the_requested_change(stub_chat_model):
    llm = stub_chat_model(responses=[GOOD_CODE])
    code, origin = refine_scene_code(
        CRASHING_CODE, "move the labels above the bars", title="Encoder", kind="cosmetic", llm=llm,
    )
    prompt = llm.prompts[0]
    assert "REQUESTED CHANGE:\nmove the labels above the bars" in prompt
    assert "CURRENT PROGRAM:\n" + CRASHING_CODE in prompt
    assert "presentation change: the method shown must stay exactly the same" in prompt
    assert "function init(ctx)" in prompt, "the contract travels with every prompt"
    assert "TEXT MUST NEVER OVERLAP" in prompt
    assert code == GOOD_CODE.strip()
    assert origin["model"] == "stub-model"


def test_refine_fundamental_says_so_in_the_prompt(stub_chat_model):
    llm = stub_chat_model(responses=[GOOD_CODE])
    refine_scene_code(GOOD_CODE, "add a normalisation step", kind="fundamental", llm=llm)
    assert "no longer match the paper" in llm.prompts[0]
    assert "update ctx.setCaption" in llm.prompts[0]


def test_refine_repairs_once_then_fails(stub_chat_model):
    llm = stub_chat_model(responses=["nope", "still nope"])
    with pytest.raises(SceneCodingError):
        refine_scene_code(GOOD_CODE, "move labels", llm=llm)
    assert len(llm.prompts) == 2


def test_refine_rejects_an_empty_request(stub_chat_model):
    with pytest.raises(SceneCodingError):
        refine_scene_code(GOOD_CODE, "  ", llm=stub_chat_model(responses=[GOOD_CODE]))


# --- service: verdicts are stored, fresh scenes start unverified -----------------------


def test_fresh_verification_report_is_unverified():
    assert scene_service._verification_report([])["runtime"] == {"status": "unverified"}
    assert scene_service._verification_report(["x"])["valid"] is False


def test_runtime_verdict_is_bounded_and_normalised():
    verdict = scene_service._runtime_verdict({
        "status": "failed",
        "error": "E" * 5000,
        "overlaps": [{"a": "A" * 200, "b": "b", "seconds": [1, "x", 2.5]}, "junk"] + [{"a": "n", "b": "m"}] * 40,
        "samples": 8,
    })
    assert verdict["status"] == "failed"
    assert len(verdict["error"]) == 2000
    assert len(verdict["overlaps"]) == scene_service.MAX_REPORTED_OVERLAPS
    assert verdict["overlaps"][0] == {"a": "A" * 80, "b": "b", "seconds": [1.0, 2.5]}
    assert verdict["samples"] == 8
    assert verdict["checked_at"]


def test_runtime_verdict_rejects_unknown_status():
    with pytest.raises(ValueError):
        scene_service._runtime_verdict({"status": "maybe"})


# --- routes: runtime reports ----------------------------------------------------------


def test_stage_runtime_verdict_is_recorded_and_survives_reload(client, sample_visualization):
    _seed_stage(sample_visualization)
    response = client.post(
        "/visualizer/item/viz_1/stage-scenes/encoder/runtime",
        json={"status": "failed", "error": RUNTIME_ERROR,
              "overlaps": [{"a": "x", "b": "y", "seconds": [3]}], "samples": 8},
    )
    assert response.status_code == 200
    record = response.json()["stage_scene"]
    runtime = record["verification"]["runtime"]
    assert runtime["status"] == "failed" and "forEach" in runtime["error"]
    assert runtime["overlaps"] == [{"a": "x", "b": "y", "seconds": [3.0]}]
    # Static validity is a separate fact and is untouched.
    assert record["valid"] is True and record["verification"]["valid"] is True
    listed = client.get("/visualizer/item/viz_1/stage-scenes").json()["stage_scenes"]
    assert listed[0]["verification"]["runtime"]["status"] == "failed"

    passed = client.post(
        "/visualizer/item/viz_1/stage-scenes/encoder/runtime", json={"status": "passed", "samples": 8},
    )
    assert passed.json()["stage_scene"]["verification"]["runtime"]["status"] == "passed"
    assert "error" not in passed.json()["stage_scene"]["verification"]["runtime"]


def test_scene_runtime_verdict_is_recorded(client, sample_visualization):
    _seed_scene(sample_visualization)
    response = client.post("/visualizer/item/viz_1/runtime", json={"status": "passed", "samples": 8})
    assert response.status_code == 200
    assert response.json()["scene"]["verification"]["runtime"]["status"] == "passed"
    stored = client.get("/visualizer/item/viz_1/scene").json()["scene"]
    assert stored["verification"]["runtime"]["status"] == "passed"


def test_runtime_report_for_missing_scene_is_404(client):
    assert client.post("/visualizer/item/viz_1/runtime", json={"status": "passed"}).status_code == 404
    assert client.post(
        "/visualizer/item/viz_1/stage-scenes/nope/runtime", json={"status": "passed"}
    ).status_code == 404


def test_runtime_report_rejects_unknown_status(client, sample_visualization):
    _seed_stage(sample_visualization)
    response = client.post("/visualizer/item/viz_1/stage-scenes/encoder/runtime", json={"status": "maybe"})
    assert response.status_code == 422


# --- routes: forced rebuild with evidence repairs the stored code ------------------------


def test_forced_rebuild_with_evidence_repairs_the_stored_stage_code(client, sample_visualization, monkeypatch):
    stored = _seed_stage(sample_visualization, code=CRASHING_CODE)
    captured = {}

    def fake_generate_stage_code(**kwargs):
        captured.update(kwargs)
        return {**stored["scene"], "code": GOOD_CODE}, {"provider": "openai", "model": "stub"}

    monkeypatch.setattr(scene_service, "generate_stage_code", fake_generate_stage_code)
    monkeypatch.setattr(scene_service, "get_visualization_by_id", lambda *a, **k: {**sample_visualization, "viz_id": "viz_1"})
    monkeypatch.setattr(scene_service, "get_node_expansion", lambda *a, **k: None)
    import app.rag.retriever as retriever
    import app.storage.article_store as article_store
    monkeypatch.setattr(retriever, "retrieve_document_chunks", lambda **k: [])
    monkeypatch.setattr(article_store, "get_article", lambda *a, **k: (_ for _ in ()).throw(ValueError("no article")))

    response = client.post("/visualizer/generate-stage-scene", json={
        "viz_id": "viz_1", "node_id": "encoder", "force": True,
        "runtime_error": RUNTIME_ERROR,
        "layout_report": {"pairs": [{"a": "x", "b": "y", "seconds": [3]}]},
    })
    assert response.status_code == 200, response.text
    assert captured["previous_code"] == CRASHING_CODE
    assert captured["runtime_error"] == RUNTIME_ERROR
    assert captured["layout_report"] == {"pairs": [{"a": "x", "b": "y", "seconds": [3]}]}
    record = response.json()["stage_scene"]
    assert record["scene"]["code"] == GOOD_CODE
    # The repaired scene has not been run yet, so it is not ready.
    assert record["verification"]["runtime"] == {"status": "unverified"}


def test_unforced_generate_ignores_evidence_and_returns_the_cache(client, sample_visualization, monkeypatch):
    _seed_stage(sample_visualization)
    monkeypatch.setattr(scene_service, "generate_stage_code", lambda **k: pytest.fail("must not generate"))
    response = client.post("/visualizer/generate-stage-scene", json={
        "viz_id": "viz_1", "node_id": "encoder", "runtime_error": RUNTIME_ERROR,
    })
    assert response.status_code == 200


# --- routes: refinement ------------------------------------------------------------------


def _stub_refinement(monkeypatch, kind: str, calls: list):
    monkeypatch.setattr(
        scene_service, "classify_refinement",
        lambda *a, **k: {"kind": kind, "reason": "Because.", "basis": "model"},
    )

    def fake_refine(code, instruction, **kwargs):
        calls.append(kwargs["kind"])
        # The real function returns fence-stripped code; mirror that.
        return GOOD_CODE.strip(), {"provider": "openai", "model": "stub"}

    monkeypatch.setattr(scene_service, "refine_scene_code", fake_refine)


def test_fundamental_refinement_is_refused_until_acknowledged(client, sample_visualization, monkeypatch):
    _seed_stage(sample_visualization)
    calls: list = []
    _stub_refinement(monkeypatch, "fundamental", calls)

    refused = client.post(
        "/visualizer/item/viz_1/stage-scenes/encoder/refine",
        json={"instruction": "add a normalisation step before the softmax"},
    )
    assert refused.status_code == 409
    assert refused.json()["detail"] == {
        "code": "needs_acknowledgement", "kind": "fundamental", "reason": "Because.", "basis": "model",
    }
    assert calls == [], "nothing may be generated before the user has seen the warning"
    unchanged = client.get("/visualizer/item/viz_1/stage-scenes").json()["stage_scenes"][0]
    assert unchanged["scene"].get("edits") is None

    accepted = client.post(
        "/visualizer/item/viz_1/stage-scenes/encoder/refine",
        json={"instruction": "add a normalisation step before the softmax", "acknowledge_fundamental": True},
    )
    assert accepted.status_code == 200, accepted.text
    body = accepted.json()
    assert calls == ["fundamental"]
    assert body["classification"]["basis"] == "acknowledged"
    record = body["stage_scene"]
    assert record["scene"]["code"] == GOOD_CODE.strip()
    edit = record["scene"]["edits"][-1]
    assert edit["kind"] == "fundamental"
    assert edit["instruction"] == "add a normalisation step before the softmax"
    assert edit["at"]
    # Edited code has not been run yet.
    assert record["verification"]["runtime"] == {"status": "unverified"}


def test_cosmetic_refinement_applies_directly(client, sample_visualization, monkeypatch):
    _seed_scene(sample_visualization)
    calls: list = []
    _stub_refinement(monkeypatch, "cosmetic", calls)
    response = client.post(
        "/visualizer/item/viz_1/refine", json={"instruction": "move the value labels below the bars"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert calls == ["cosmetic"]
    assert body["classification"]["kind"] == "cosmetic"
    assert body["scene"]["scene"]["edits"][-1]["kind"] == "cosmetic"
    assert body["scene"]["verification"]["runtime"] == {"status": "unverified"}
    # Each refinement extends the trail rather than replacing it.
    again = client.post("/visualizer/item/viz_1/refine", json={"instruction": "make the title smaller"})
    assert len(again.json()["scene"]["scene"]["edits"]) == 2


def test_refine_missing_scene_is_404(client, monkeypatch):
    _stub_refinement(monkeypatch, "cosmetic", [])
    assert client.post("/visualizer/item/viz_1/refine", json={"instruction": "move it"}).status_code == 404
    assert client.post(
        "/visualizer/item/viz_1/stage-scenes/encoder/refine", json={"instruction": "move it"}
    ).status_code == 404


def test_refine_rejects_a_too_short_instruction(client, sample_visualization):
    _seed_scene(sample_visualization)
    assert client.post("/visualizer/item/viz_1/refine", json={"instruction": "x"}).status_code == 422


def test_refine_coding_failure_is_502(client, sample_visualization, monkeypatch):
    _seed_stage(sample_visualization)
    monkeypatch.setattr(
        scene_service, "classify_refinement", lambda *a, **k: {"kind": "cosmetic", "reason": "", "basis": "model"},
    )
    monkeypatch.setattr(
        scene_service, "refine_scene_code",
        lambda *a, **k: (_ for _ in ()).throw(SceneCodingError("could not")),
    )
    response = client.post(
        "/visualizer/item/viz_1/stage-scenes/encoder/refine", json={"instruction": "move the labels"},
    )
    assert response.status_code == 502

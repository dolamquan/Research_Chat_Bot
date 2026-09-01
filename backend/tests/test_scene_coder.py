"""The scene coder: contract checks, repair loop, and the offline template."""

from __future__ import annotations

import pytest

from app.rag.document_structure import StructuredPaper
from app.rag.scene_coder import (
    MAX_CODE_CHARS,
    SceneCodingError,
    check_scene_code,
    generate_scene_code,
    generate_stage_code,
    scene_code_from_diagram,
)

GOOD_CODE = """\
// A tiny but contract-complete scene.
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


# --- check_scene_code ----------------------------------------------------------


def test_contract_complete_code_passes():
    assert check_scene_code(GOOD_CODE) == []


def test_empty_code_is_rejected():
    assert check_scene_code("") == ["the code is empty"]
    assert check_scene_code("   \n  ") == ["the code is empty"]


def test_missing_entry_points_are_named_individually():
    findings = check_scene_code("const x = 1;")
    assert any("function init" in f for f in findings)
    assert any("function update" in f for f in findings)


def test_oversized_code_is_rejected():
    padded = GOOD_CODE + "\n// pad" + "x" * MAX_CODE_CHARS
    assert any("maximum" in f for f in check_scene_code(padded))


@pytest.mark.parametrize(
    "snippet",
    [
        "fetch('https://x.example')",
        "new XMLHttpRequest()",
        "new WebSocket('wss://x')",
        "new EventSource('/stream')",
        "navigator.sendBeacon('/x')",
        "importScripts('x.js')",
        "import('three')",
        "import * as THREE from 'three';",
        "export function helper() {}",
        "require('fs')",
        "eval('1+1')",
        "new Function('return 1')",
        "document.cookie",
        "localStorage.setItem('k', 'v')",
        "sessionStorage.getItem('k')",
        "indexedDB.open('db')",
        "window.parent.location",
        "window.top",
        "window.open('https://x')",
        "window.location.href = 'x'",
        "postMessage({}, '*')",
        "el.innerHTML = '<script>alert(1)</scr' + 'ipt>'",
        "document.body.appendChild(x)",
        "document.write('hi')",
    ],
)
def test_forbidden_constructs_are_rejected(snippet):
    code = GOOD_CODE + "\n" + snippet
    findings = check_scene_code(code)
    assert findings, f"accepted forbidden snippet: {snippet}"


def test_ctx_usage_is_not_mistaken_for_violations():
    """Names that merely resemble forbidden ones must pass."""
    code = GOOD_CODE + (
        "\nfunction fetchColor(i) { return i; }"  # not fetch(
        "\nconst important = 1;"                   # not import
        "\nconst exported = 2;"                    # not export
    )
    assert check_scene_code(code) == []


# --- generate_scene_code ---------------------------------------------------------


@pytest.fixture
def paper() -> StructuredPaper:
    return StructuredPaper(title="Test Paper")


def test_generation_happy_path(stub_chat_model, sample_visualization, paper):
    llm = stub_chat_model(responses=[GOOD_CODE])
    scene, origin = generate_scene_code(
        visualization=sample_visualization,
        article={"title": "Test Paper"},
        structured_paper=paper,
        llm=llm,
    )
    assert scene["format"] == "threejs-code@1"
    assert scene["code"] == GOOD_CODE.strip()
    assert scene["title"] == "Test Method"
    # The leading comment becomes the summary.
    assert "contract-complete" in scene["summary"]
    assert origin["model"] == "stub-model"
    # The prompt carried the diagram and the contract.
    assert "Encoder" in llm.prompts[0]
    assert "function init(ctx)" in llm.prompts[0]


def test_markdown_fences_are_stripped(stub_chat_model, sample_visualization, paper):
    llm = stub_chat_model(responses=[f"```javascript\n{GOOD_CODE}\n```"])
    scene, _ = generate_scene_code(
        visualization=sample_visualization,
        article=None,
        structured_paper=paper,
        llm=llm,
    )
    assert scene["code"].startswith("//")
    assert "```" not in scene["code"]


def test_one_repair_attempt_names_the_violation(
    stub_chat_model, sample_visualization, paper
):
    bad = GOOD_CODE + "\nfetch('https://exfil.example')"
    llm = stub_chat_model(responses=[bad, GOOD_CODE])
    scene, _ = generate_scene_code(
        visualization=sample_visualization,
        article=None,
        structured_paper=paper,
        llm=llm,
    )
    assert scene["code"] == GOOD_CODE.strip()
    assert len(llm.prompts) == 2
    assert "fetch" in llm.prompts[1]


def test_failure_after_repair_raises(stub_chat_model, sample_visualization, paper):
    bad = "const nope = true;"
    llm = stub_chat_model(responses=[bad, bad])
    with pytest.raises(SceneCodingError):
        generate_scene_code(
            visualization=sample_visualization,
            article=None,
            structured_paper=paper,
            llm=llm,
        )


def test_stage_model_and_reasoning_effort_resolution(
    monkeypatch, stub_chat_model, sample_visualization
):
    """Stages prefer STAGE_SCENE_MODEL, and reasoning effort is applied only
    to models that accept the parameter."""
    from app.rag import scene_coder

    seen: dict[str, object] = {}

    def fake_build_chat_model(provider=None, model=None, temperature=0, **kwargs):
        seen["model"] = model
        seen["kwargs"] = kwargs
        return stub_chat_model(responses=[GOOD_CODE])

    monkeypatch.setattr(scene_coder, "build_chat_model", fake_build_chat_model)
    monkeypatch.setenv("SCENE_MODEL", "gpt-5")
    monkeypatch.setenv("STAGE_SCENE_MODEL", "gpt-5-mini")
    monkeypatch.setenv("SCENE_REASONING_EFFORT", "low")

    node = sample_visualization["diagram"]["nodes"][0]
    generate_stage_code(visualization=sample_visualization, node=node)
    assert seen["model"] == "gpt-5-mini"
    assert seen["kwargs"] == {"reasoning_effort": "low"}

    # A non-reasoning model must never receive the parameter.
    monkeypatch.setenv("STAGE_SCENE_MODEL", "gpt-4o-mini")
    generate_stage_code(visualization=sample_visualization, node=node)
    assert seen["model"] == "gpt-4o-mini"
    assert seen["kwargs"] == {}

    # "off" disables it even for reasoning models.
    monkeypatch.setenv("STAGE_SCENE_MODEL", "gpt-5-mini")
    monkeypatch.setenv("SCENE_REASONING_EFFORT", "off")
    generate_stage_code(visualization=sample_visualization, node=node)
    assert seen["kwargs"] == {}

    # Without a stage-specific model, stages fall back to SCENE_MODEL.
    # (Set empty rather than deleted: load_dotenv would resurrect a deleted
    # var from .env, but never overrides one that exists.)
    monkeypatch.setenv("STAGE_SCENE_MODEL", "")
    generate_stage_code(visualization=sample_visualization, node=node)
    assert seen["model"] == "gpt-5"


def test_scene_model_env_upgrades_only_the_scene_path(
    monkeypatch, stub_chat_model, sample_visualization, paper
):
    """SCENE_MODEL steers scene code without touching the app-wide default."""
    from app.rag import scene_coder

    seen: dict[str, str | None] = {}

    def fake_build_chat_model(provider=None, model=None, temperature=0, **_kw):
        seen["model"] = model
        return stub_chat_model(responses=[GOOD_CODE])

    monkeypatch.setattr(scene_coder, "build_chat_model", fake_build_chat_model)
    monkeypatch.setenv("SCENE_MODEL", "test-scene-model")
    generate_scene_code(
        visualization=sample_visualization, article=None, structured_paper=paper
    )
    assert seen["model"] == "test-scene-model"

    # An explicitly requested model still wins over the environment.
    generate_scene_code(
        visualization=sample_visualization,
        article=None,
        structured_paper=paper,
        model="explicit-model",
    )
    assert seen["model"] == "explicit-model"


# --- generate_stage_code -----------------------------------------------------------


def test_stage_generation_happy_path(stub_chat_model, sample_visualization):
    llm = stub_chat_model(responses=[GOOD_CODE])
    node = sample_visualization["diagram"]["nodes"][1]  # encoder
    expansion = {
        "content": {
            "overview": "The encoder maps tokens to contextual vectors.",
            "mechanism": "Self-attention mixes token representations.",
            "process_steps": [{"caption": "tokens attend to each other"}],
        }
    }
    scene, origin = generate_stage_code(
        visualization=sample_visualization,
        node=node,
        expansion=expansion,
        article={"title": "Test Paper"},
        llm=llm,
    )
    assert scene["format"] == "threejs-code@1"
    assert scene["node_id"] == "encoder"
    assert scene["title"] == "Encoder"
    assert origin["model"] == "stub-model"
    prompt = llm.prompts[0]
    # Focused on one stage, with the contract, neighbours and notes present.
    assert "ONE" in prompt and "STAGE" in prompt
    assert "function init(ctx)" in prompt
    assert "RECEIVES FROM: Input" in prompt
    assert "SENDS TO: Output" in prompt
    assert "Self-attention mixes" in prompt
    assert "tokens attend to each other" in prompt


def test_stage_generation_works_without_an_expansion(
    stub_chat_model, sample_visualization
):
    llm = stub_chat_model(responses=[GOOD_CODE])
    node = sample_visualization["diagram"]["nodes"][0]
    scene, _ = generate_stage_code(
        visualization=sample_visualization,
        node=node,
        expansion=None,
        article=None,
        llm=llm,
    )
    assert scene["node_id"] == "input"
    assert "(no stage notes available)" in llm.prompts[0]


def test_stage_generation_repairs_then_fails(stub_chat_model, sample_visualization):
    bad = "const nope = true;"
    llm = stub_chat_model(responses=[bad, bad])
    with pytest.raises(SceneCodingError):
        generate_stage_code(
            visualization=sample_visualization,
            node=sample_visualization["diagram"]["nodes"][0],
            llm=llm,
        )
    assert len(llm.prompts) == 2


# --- offline template ------------------------------------------------------------


def test_diagram_template_passes_its_own_checks(sample_visualization):
    scene = scene_code_from_diagram(sample_visualization)
    assert check_scene_code(scene["code"]) == []
    assert scene["format"] == "threejs-code@1"


def test_diagram_template_embeds_nodes_and_edges(sample_visualization):
    scene = scene_code_from_diagram(sample_visualization)
    for node in sample_visualization["diagram"]["nodes"]:
        assert node["id"] in scene["code"]
    assert '"source": "input"' in scene["code"]
    assert "model call" in scene["summary"]


def test_diagram_template_handles_an_empty_diagram():
    scene = scene_code_from_diagram({"diagram": {"nodes": [], "edges": []}})
    assert check_scene_code(scene["code"]) == []

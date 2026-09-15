"""Generate executable Three.js scene code for one paper's proposed method.

This module replaces the retired declarative pipeline (`scene_ir`,
`scene_planner`, `scene_verifier`): the model now writes JavaScript that the
frontend executes directly, instead of emitting a validated data document.

The security boundary is the browser, not this file. Generated code runs in an
iframe with `sandbox="allow-scripts"` only — an opaque origin with no cookies,
no storage, and no handle on the parent page. The static checks here catch
obvious contract violations (network calls, imports, missing entry points) at
generation time so they become a repair prompt rather than a broken scene, but
they are honesty checks, not the sandbox.

The trade-off against the old pipeline is deliberate and documented in
docs/PAPER_TO_SCENE.md: scenes are no longer verifiable against the paper's
text, in exchange for unbounded visual vocabulary.
"""

from __future__ import annotations

import json
import logging
import os
import re
from functools import lru_cache
from typing import Any, Dict, List, Literal, Sequence, Tuple

from dotenv import load_dotenv
from langsmith import traceable
from pydantic import BaseModel, Field

from app.rag.document_structure import (
    StructuredPaper,
    select_architecture_evidence,
)
from app.rag.llm_provider import build_chat_model, describe_model
from app.rag.scene_validation import scope_findings

logger = logging.getLogger(__name__)

# Version markers persisted with every record. Bump CODE_FORMAT when the
# runtime contract (the ctx object) changes shape; SCHEMA_VERSION namespaces
# rows in scene_store so stale records are regenerated, not misrendered.
CODE_FORMAT = "threejs-code@1"
SCHEMA_VERSION = "code-1.0"
THREE_RUNTIME = "three@0.170"

MAX_CODE_CHARS = 60_000
MAX_DIAGRAM_NODES_IN_PROMPT = 30


class SceneCodingError(RuntimeError):
    """The model could not produce scene code that passes the static checks."""


def _resolve_scene_model(model: str | None) -> str | None:
    """Which model writes scene code: explicit, then SCENE_MODEL, then None.

    Scene code is the one task in the app that needs a strong model — weak
    ones produce plausible-looking Three.js that crashes at runtime — while
    chat and diagrams are fine on the cheap default. SCENE_MODEL upgrades
    just this path without touching OPENAI_MODEL, which `get_llm` applies
    deployment-wide. Returning None defers to the provider's usual chain.
    """
    if model:
        return model
    load_dotenv()
    return os.getenv("SCENE_MODEL") or None


def _resolve_stage_model(model: str | None) -> str | None:
    """Which model writes per-STAGE code: explicit, then STAGE_SCENE_MODEL,
    then the whole-scene chain.

    A stage is a smaller, more constrained task than a whole method, so a
    faster model is usually good enough there — and prepare writes one scene
    per node, so stage latency is what the user actually waits on.
    """
    if model:
        return model
    load_dotenv()
    return os.getenv("STAGE_SCENE_MODEL") or _resolve_scene_model(None)


# Models that accept the reasoning_effort parameter. Sending it to a
# non-reasoning model (gpt-4o-mini) is a hard API error, so the prefix check
# errs toward omitting it.
_REASONING_MODEL_PREFIXES = ("gpt-5", "o1", "o3", "o4")


def _scene_model_kwargs(resolved_model: str | None) -> Dict[str, Any]:
    """Latency knobs for the scene-writing call.

    SCENE_REASONING_EFFORT (default "low") caps how long a reasoning model
    deliberates before writing code — the single biggest latency lever for
    this task, which is closer to transcription than to problem-solving once
    the prompt carries the paper excerpts. Set it to "off" to restore the
    model's default. Ignored entirely for models that do not take the
    parameter.
    """
    load_dotenv()
    effort = (os.getenv("SCENE_REASONING_EFFORT") or "low").strip().lower()
    if effort in {"", "off", "none", "default"}:
        return {}
    if not resolved_model or not resolved_model.startswith(_REASONING_MODEL_PREFIXES):
        return {}
    return {"reasoning_effort": effort}


# Contract violations worth rejecting before the code ever reaches a browser.
# The sandbox would neutralise most of these anyway; rejecting them here turns
# a silently-dead call into a named repair instruction.
FORBIDDEN_PATTERNS: List[Tuple[str, str]] = [
    (r"\bfetch\s*\(", "network access via fetch()"),
    (r"\bXMLHttpRequest\b", "network access via XMLHttpRequest"),
    (r"\bWebSocket\b", "network access via WebSocket"),
    (r"\bEventSource\b", "network access via EventSource"),
    (r"\bnavigator\s*\.\s*sendBeacon\b", "network access via sendBeacon"),
    (r"\bimportScripts\s*\(", "importScripts()"),
    (r"\bimport\s*\(", "dynamic import()"),
    (r"^\s*import\s", "static import statement"),
    (r"^\s*export\s", "export statement"),
    (r"\brequire\s*\(", "require()"),
    (r"\beval\s*\(", "eval()"),
    (r"\bnew\s+Function\b", "new Function()"),
    (r"\bdocument\s*\.\s*cookie\b", "document.cookie"),
    (r"\blocalStorage\b", "localStorage"),
    (r"\bsessionStorage\b", "sessionStorage"),
    (r"\bindexedDB\b", "indexedDB"),
    (r"\bwindow\s*\.\s*(top|parent|opener|open|location)\b", "window escape hatch"),
    (r"\bpostMessage\s*\(", "postMessage (reserved for the harness)"),
    (r"<\s*script", "inline <script> markup"),
    (r"\bdocument\s*\.\s*(write|body|head)\b", "direct DOM mutation outside ctx"),
]

_COMPILED_FORBIDDEN = [
    (re.compile(pattern, re.IGNORECASE | re.MULTILINE), reason)
    for pattern, reason in FORBIDDEN_PATTERNS
]

# The harness compiles the code and calls these by name; their absence is the
# most common failure mode, so it is checked and repaired explicitly.
REQUIRED_FUNCTIONS = ("init", "update")


def check_scene_code(code: str) -> List[str]:
    # Return a fresh list so callers cannot mutate the cached validation result.
    return list(_cached_scene_findings(code))


@lru_cache(maxsize=128)
def _cached_scene_findings(code: str) -> tuple[str, ...]:
    """Static contract findings for one piece of generated code.

    Empty list means the code is accepted. Every finding is phrased so it can
    be pasted straight into a repair prompt.
    """
    findings: List[str] = []
    if not code or not code.strip():
        return ("the code is empty",)
    if len(code) > MAX_CODE_CHARS:
        findings.append(
            f"the code is {len(code)} characters; the maximum is {MAX_CODE_CHARS}"
        )
    for name in REQUIRED_FUNCTIONS:
        if not re.search(rf"\bfunction\s+{name}\s*\(", code):
            findings.append(
                f"missing required top-level declaration `function {name}(...)`"
            )
    for compiled, reason in _COMPILED_FORBIDDEN:
        if compiled.search(code):
            findings.append(f"forbidden construct: {reason}")
    if not findings:
        findings.extend(scope_findings(code))
    return tuple(findings)


# The parts of the prompt shared by every generation mode: what the harness
# provides, the entry-point contract, and the constraints whose violation gets
# an answer rejected. Kept as one block so whole-method and per-stage prompts
# can never drift apart on the contract.
_CONTRACT_RULES = """\
THE HARNESS provides a context object `ctx` with:
  ctx.THREE          the three.js module (r170)
  ctx.scene          a THREE.Scene (background and lights already set up)
  ctx.camera         a THREE.PerspectiveCamera with OrbitControls attached
  ctx.controls       the OrbitControls instance
  ctx.renderer       the WebGLRenderer
  ctx.width, ctx.height   viewport size in pixels
  ctx.theme          application palette: background, surface, border, ink,
                     muted, data, process, output, danger. Reuse these colors.
  ctx.makeLabel(text, opts) -> THREE.Sprite
                     a crisp text label; opts is optional: { size (world units,
                     default 1), color (css string), background (css string) }
  ctx.setLabelText(sprite, text) updates an existing label without rebuilding it.
                     Use for changing scores and tokens; never stretch text with
                     scale.setScalar or leave placeholder values in the animation.
  ctx.makeMatrix(values, opts) -> THREE.Group
                     numeric/symbolic entries framed by fine mathematical brackets;
                     opts: {title, cellSize:0.65, decimals:1, color}.
                     group.userData.cells[row][col] is its label; update via setLabelText.
  ctx.makeNetwork(layerSizes, opts) -> THREE.Group
                     layered neuron spheres with fine connections; opts:
                     {title, width:5, height:4, weights}. Optional weights are
                     indexed [layerConnection][destination][source]; signed values
                     use teal/coral. Without weights, edges are neutral.
                     group.userData.layers[layer][node] exposes meshes for animation.
  ctx.setCaption(text)    sets the caption above the figure; call it whenever
                     the animation enters a new phase so the viewer can follow
  ctx.makePanel(title, opts) -> THREE.Group
                     a styled dark card with a readable colored heading;
                     opts: {width: 4.4, height: 5, color: "#85a3bd"}
  ctx.makeBars(values, opts) -> THREE.Group
                     signed numeric bars with a baseline and value labels;
                     opts: {width: 3.5, height: 1.7, maxValue: 2, color: "#85a3bd"}
                     place bars inside a panel; use the same maxValue to compare.
  Prefer these helpers over hand-written mesh/label boilerplate. Add their
  returned groups to ctx.scene; set group.position to place them. Build once
  in init, animate group scale/position in update. Do not rebuild per frame.
  ctx.setContentHeight(pixels) sets a vertically scrollable canvas height;
                     use it in optional function resize(ctx) on narrow screens
                     to stack panels instead of shrinking labels. The harness
                     calls resize after init and whenever the viewport changes.

DEFINE EXACTLY these two top-level functions (plain declarations, no exports):
  function init(ctx) { ... }       // build the scene graph, runs once
  function update(ctx, t) { ... }  // t = seconds since start; animate

HARD CONSTRAINTS — violating any of these gets your answer rejected:
  - Plain JavaScript only. No import, export, or require; use ctx.THREE.
  - No network access of any kind, no storage, no eval, no postMessage.
  - Do not touch document, window, parent, or top; everything comes from ctx.
  - Allocate geometries, materials and reusable vectors in init(); allocate
    nothing per frame in update(), so the animation holds 60fps.
  - SCOPE: init and update are separate functions and share NO local scope.
    Anything update() needs must live in one top-level `const state = {}`
    declared before init, and be written as `state.foo` in both functions.
    A bare variable created inside init() does not exist inside update() —
    that is a ReferenceError at runtime. Never reference a variable you did
    not declare at top level or receive via ctx.

Output ONLY the JavaScript source. No markdown fences, no commentary before
or after the code.
"""

# One presentation policy for every paper, stage, and repair prompt.
_PRESENTATION_RULES = """\
PRESENTATION FOR EVERY PAPER:
  - Use the visual language of a mathematical film: black negative space,
    elegant serif section headings (makeLabel opts.role='heading'), unboxed
    text, fine bracketed matrices, thin connecting lines, restrained teal/coral
    accents, and layered geometry whose depth explains the computation.
  - Reuse ctx.theme: data for inputs, process for transformations, output for
    results, danger for errors, ink and muted for text. Color encodes meaning.
  - Keep the harness background and lights. Use matte surfaces (roughness >=
    0.85, metalness <= 0.05); no neon glow, glass cages, mirrors, or colored lights.
  - Use ctx.makeLabel for ALL text and ctx.setLabelText for changing values.
    The player supplies the stage title; do not add another oversized title.
  - Compose 2-4 major structures with generous negative space. Use shallow
    oblique layers where depth explains a tensor, attention path, or mechanism;
    keep text facing the camera. Avoid generic boxes standing in for mechanisms.
    Reserve separate rows for diagrams, values, and formulas. Account for
    multiline labels; never place text on top of text or shrink text to fit.
  - Use ctx.makeMatrix and ctx.makeNetwork for actual matrices and networks;
    use bars for scalar comparisons and domain-specific structures for other
    mechanisms. Do not force every domain into a neural-network metaphor.
    Leave at least 1.5 world units between structures. Preserve the paper's
    specific mechanism and explicitly label invented numbers as illustrative.
  - Reveal the explanation in phases: establish inputs, show the operation,
    then the result. Reveal detailed values and annotations only in their
    relevant phase; do not display every equation and annotation at once.
  - For narrow screens, define function resize(ctx), stack groups vertically,
    and use ctx.setContentHeight to keep the complete figure scrollable.
    Do not shrink a desktop layout into unreadable phone-sized text.

LAYOUT — TEXT MUST NEVER OVERLAP TEXT OR GEOMETRY. The player measures this
after generation and rejects scenes where labels collide, so plan positions:
  - Lay structures out on an explicit grid you compute once in init(): pick a
    column pitch (>= 5 world units) and a row pitch (>= 3.5 world units), and
    derive every group.position from (column, row). Never eyeball positions.
  - Exactly one label per anchor. A label sits 0.9 world units above the top
    of the thing it names (or below, for value readouts); never at the same
    y as a neighbouring label in the same column unless x differs by more
    than the label's width. Default label size 0.45; headings 0.6.
  - Value readouts under bars/cells go in a single row BELOW the baseline, at
    least 0.6 units under the lowest bar; the structure's title goes ABOVE it.
    Do not place a name label and a value label on the same object.
  - Matrices: one title above; numbers only inside cells (makeMatrix does this).
    Do not add a second layer of labels over a matrix. Keep >= 1.5 units of
    clear space around every matrix, panel and network.
  - Captions belong in ctx.setCaption, not in a floating label: anything
    longer than ~6 words is a caption.
  - Different phases may reuse the same screen region only if the earlier
    phase's labels are hidden first (material.opacity = 0 or visible = false).
    Fading text to 0.3 opacity is not hiding it.
  - Keep every label inside the camera view: |x| <= 9, -5 <= y <= 6 at z ~ 0
    for a desktop layout. Text beyond that is clipped.
"""

CODE_RULES = (
    """\
You are writing a self-contained Three.js animation that TEACHES one research
paper's proposed method. Your code runs inside a sandboxed harness that owns
the page; you only build and animate the scene graph.

"""
    + _CONTRACT_RULES
    + _PRESENTATION_RULES
    + """
QUALITY BAR:
  - Visualize the method the paper PROPOSES, not related work or baselines.
  - Label every major component with ctx.makeLabel so it reads like a figure.
  - Show data FLOWING: animate pulses along connections, transformations of
    shapes, attention links forming — motion should carry the mechanism.
  - Structure the animation as named phases; announce each via ctx.setCaption.
  - Loop forever: derive all motion from t (e.g. const phase = t % CYCLE) so
    the scene never freezes or drifts.
  - Choose a legible layout: spread components out, face the camera, use
    color to distinguish roles consistently.
"""
)

STAGE_CODE_RULES = (
    """\
You are writing a self-contained Three.js animation that TEACHES exactly ONE
STAGE of a research paper's method — the single component named below, not
the whole pipeline. Your code runs inside a sandboxed harness that owns the
page; you only build and animate the scene graph.

"""
    + _CONTRACT_RULES
    + _PRESENTATION_RULES
    + """
QUALITY BAR:
  - Zoom in: show THIS stage's internal mechanism, step by step. Its inputs
    arrive from the left, its outputs leave to the right; everything between
    is this stage's own machinery.
  - Label the stage's parts with ctx.makeLabel; narrate each internal step
    with ctx.setCaption as it happens.
  - A short loop beats a long one here: a 8-20 second cycle (const phase =
    t % CYCLE) that a reader can watch two or three times.
  - Use a small worked example (a handful of tokens or numbers) so the
    mechanism is concrete, and keep it consistent across the whole loop.
  - Keep the whole program under roughly 200 lines. One clear mechanism,
    well animated, beats an exhaustive reconstruction.
  - Aim for 80-120 concise lines; reuse helpers and geometry.
  - Use 2-4 clearly separated structures with short camera-facing labels
    (size 0.4-0.6). Place labels above their objects with clear gaps.
    Avoid decorative grids and titles. Allow vertical space when stacking
    groups for a narrow viewport.
  - Keep surfaces visible, labels bright, and inactive elements at least 45%
    opacity. Use motion to explain a transformation, not as decoration.
"""
)


def _diagram_block(visualization: Dict[str, Any]) -> str:
    """The existing diagram as an id table, so the animation matches it."""
    diagram = visualization.get("diagram") or {}
    nodes = (diagram.get("nodes") or [])[:MAX_DIAGRAM_NODES_IN_PROMPT]
    edges = diagram.get("edges") or []
    if not nodes:
        return "(no existing diagram)"

    lines = ["NODES (id | kind | label):"]
    for node in nodes:
        lines.append(
            f"  {node.get('id', '')} | {node.get('kind', '')} | {node.get('label', '')}"
        )
    known = {n.get("id") for n in nodes}
    edge_lines = [
        f"  {e.get('source')} -> {e.get('target')}"
        for e in edges
        if e.get("source") in known and e.get("target") in known
    ]
    if edge_lines:
        lines.append("EDGES:")
        lines.extend(edge_lines[:40])
    return "\n".join(lines)


def _build_prompt(
    visualization: Dict[str, Any],
    article: Dict[str, Any] | None,
    structured_paper: StructuredPaper,
    chunks: Sequence[Dict[str, Any]],
) -> str:
    diagram = visualization.get("diagram") or {}
    title = (
        (article or {}).get("title")
        or diagram.get("title")
        or structured_paper.title
        or "Unknown paper"
    )
    evidence_text = select_architecture_evidence(structured_paper)
    if not evidence_text and chunks:
        # Structure recovery failed entirely; fall back to raw chunk text so
        # the model still has something method-shaped to read.
        evidence_text = "\n\n".join(
            str(chunk.get("text", ""))[:1500] for chunk in chunks[:8]
        )

    return (
        f"{CODE_RULES}\n"
        f"PAPER: {title}\n\n"
        f"THE PAPER'S ARCHITECTURE DIAGRAM (animate these components):\n"
        f"{_diagram_block(visualization)}\n\n"
        f"METHOD EXCERPTS:\n{evidence_text}\n"
    )


def _strip_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    return stripped.strip()


def _response_text(response: Any) -> str:
    content = getattr(response, "content", response)
    if isinstance(content, list):
        # Anthropic returns a list of content blocks.
        parts = [
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content
        ]
        return "".join(parts)
    return str(content)


def _leading_comment_summary(code: str) -> str:
    """A summary from the code's leading comment, if the model wrote one."""
    match = re.match(r"\s*/\*+(.*?)\*/", code, re.DOTALL)
    if match:
        return re.sub(r"\s+", " ", match.group(1)).strip()[:400]
    lines: List[str] = []
    for line in code.splitlines():
        stripped = line.strip()
        if stripped.startswith("//"):
            lines.append(stripped.lstrip("/ ").strip())
            continue
        if stripped:
            break
    return " ".join(lines)[:400]


def _scene_document(
    code: str, visualization: Dict[str, Any], article: Dict[str, Any] | None
) -> Dict[str, Any]:
    diagram = visualization.get("diagram") or {}
    title = (
        diagram.get("title")
        or (article or {}).get("title")
        or visualization.get("algorithm_name")
        or "Proposed method"
    )
    return {
        "format": CODE_FORMAT,
        "language": "javascript",
        "runtime": THREE_RUNTIME,
        "title": str(title),
        "algorithm_name": str(title),
        "summary": _leading_comment_summary(code),
        "code": code,
    }


# --- repair prompts -------------------------------------------------------------

_REPAIR_CLOSING = (
    "\n\nReturn the corrected JavaScript only. Remember: define "
    "`function init(ctx)` and `function update(ctx, t)`, keep shared state in "
    "a top-level `const state = {}`, use only what ctx provides, and never "
    "touch the network, storage, or the surrounding page."
)


def _static_repair_prompt(prompt: str, code: str, findings: List[str]) -> str:
    """The follow-up sent when the static checks reject an answer."""
    return (
        prompt
        + "\n\nYour previous answer was rejected for these reasons:\n"
        + "\n".join(f"  - {finding}" for finding in findings)
        + "\n\nPrevious JavaScript:\n" + code
        + _REPAIR_CLOSING
    )


def format_layout_report(layout_report: Dict[str, Any] | None) -> str:
    """The browser's overlap measurements as instructions the model can act on.

    The player probes a scene after generation: it sweeps `update` across the
    animation cycle, lays labels out exactly as the viewer would see them, and
    records every pair that still collide after its own nudging pass. Each
    pair arrives with the seconds at which it collided, so the repair can
    target one phase instead of rearranging everything.
    """
    pairs = list((layout_report or {}).get("pairs") or [])
    if not pairs:
        return ""
    lines = ["MEASURED OVERLAPS (label ↔ label or label ↔ figure, with the seconds they collide):"]
    for pair in pairs[:12]:
        a = str(pair.get("a") or "").strip()[:60]
        b = str(pair.get("b") or "").strip()[:60]
        seconds = pair.get("seconds") or []
        when = ", ".join(f"{float(s):g}s" for s in list(seconds)[:6])
        lines.append(f"  - {a!r} overlaps {b!r}" + (f" at {when}" if when else ""))
    lines.append(
        "Fix EVERY pair above by moving one of the two to a clear position "
        "(different row, or a column at least one label-width away), by hiding "
        "the earlier phase's label before the later one appears, or by moving "
        "the text into ctx.setCaption. Do not shrink text to fit. Keep everything "
        "else about the animation the same."
    )
    return "\n".join(lines)


def _runtime_repair_prompt(
    prompt: str,
    previous_code: str,
    runtime_error: str | None,
    layout_report: Dict[str, Any] | None,
) -> str:
    """Repair a program the browser already ran and found wanting.

    Unlike the static repair this is the first request of the call, not a
    retry: the previous code passed every static check and still failed in
    the sandbox (a thrown error, or labels that collide on screen). The real
    error text is the most useful thing the model can be given.
    """
    sections = [prompt, "\n\nTHE PREVIOUS PROGRAM BELOW passed the static checks but must be fixed:"]
    if runtime_error:
        sections.append(
            "\nRUNTIME ERROR thrown while the browser ran it (fix the cause, not the symptom):\n"
            + str(runtime_error).strip()[:2000]
        )
    layout = format_layout_report(layout_report)
    if layout:
        sections.append("\n" + layout)
    sections.append("\nPrevious JavaScript:\n" + previous_code)
    sections.append(
        "\n\nReturn the complete corrected JavaScript only. Keep the same "
        "mechanism, phases and worked example; change only what the error or "
        "the overlaps require." + _REPAIR_CLOSING
    )
    return "".join(sections)


def _generate_with_repair(
    client: Any,
    prompt: str,
    *,
    previous_code: str | None,
    runtime_error: str | None,
    layout_report: Dict[str, Any] | None,
    failure_label: str,
) -> str:
    """One generation (or runtime repair) plus at most one static repair."""
    if previous_code and (runtime_error or (layout_report or {}).get("pairs")):
        first_prompt = _runtime_repair_prompt(prompt, previous_code, runtime_error, layout_report)
    else:
        first_prompt = prompt

    code = _strip_fence(_response_text(client.invoke(first_prompt)))
    findings = check_scene_code(code)
    if findings:
        code = _strip_fence(
            _response_text(client.invoke(_static_repair_prompt(prompt, code, findings)))
        )
        findings = check_scene_code(code)
        if findings:
            raise SceneCodingError(
                f"The model could not produce acceptable {failure_label}: "
                + "; ".join(findings)
            )
    return code


@traceable(name="generate_scene_code", run_type="chain")
def generate_scene_code(
    visualization: Dict[str, Any],
    article: Dict[str, Any] | None,
    structured_paper: StructuredPaper,
    chunks: Sequence[Dict[str, Any]] | None = None,
    llm: Any = None,
    provider: str | None = None,
    model: str | None = None,
    previous_code: str | None = None,
    runtime_error: str | None = None,
    layout_report: Dict[str, Any] | None = None,
) -> tuple[Dict[str, Any], Dict[str, str]]:
    """Write Three.js code for one paper, with one repair attempt.

    With `previous_code` and a `runtime_error` or `layout_report`, the call is
    a repair of a program the browser already executed rather than a fresh
    generation. Returns the scene document together with the provider/model
    that produced it, so the stored record can say how it was made.
    """
    prompt = _build_prompt(visualization, article, structured_paper, list(chunks or []))
    resolved_model = _resolve_scene_model(model)
    client = llm or build_chat_model(
        provider=provider,
        model=resolved_model,
        temperature=0,
        **_scene_model_kwargs(resolved_model),
    )

    code = _generate_with_repair(
        client,
        prompt,
        previous_code=previous_code,
        runtime_error=runtime_error,
        layout_report=layout_report,
        failure_label="scene code",
    )

    return _scene_document(code, visualization, article), describe_model(client, provider)


# --- per-stage scenes -----------------------------------------------------------


def _stage_connections_block(
    visualization: Dict[str, Any], node_id: str
) -> str:
    """The focused node's immediate neighbours, so io reads correctly."""
    diagram = visualization.get("diagram") or {}
    labels = {
        n.get("id"): str(n.get("label") or n.get("id") or "")
        for n in (diagram.get("nodes") or [])
    }
    inbound = [
        labels.get(e.get("source"), str(e.get("source")))
        for e in (diagram.get("edges") or [])
        if e.get("target") == node_id
    ]
    outbound = [
        labels.get(e.get("target"), str(e.get("target")))
        for e in (diagram.get("edges") or [])
        if e.get("source") == node_id
    ]
    lines = []
    if inbound:
        lines.append("RECEIVES FROM: " + ", ".join(inbound[:8]))
    if outbound:
        lines.append("SENDS TO: " + ", ".join(outbound[:8]))
    return "\n".join(lines) or "(no recorded connections)"


def _stage_notes_block(expansion: Dict[str, Any] | None) -> str:
    """What is already known about this stage, from its stored expansion."""
    if not expansion:
        return "(no stage notes available)"
    content = expansion.get("content") or {}
    parts: List[str] = []
    for key in ("overview", "mechanism", "role"):
        value = str(content.get(key) or "").strip()
        if value:
            parts.append(f"{key.upper()}: {value[:900]}")
    steps = content.get("process_steps") or []
    captions = [str(s.get("caption") or "").strip() for s in steps]
    captions = [c for c in captions if c]
    if captions:
        parts.append("NARRATED STEPS:\n" + "\n".join(f"  - {c}" for c in captions[:12]))
    return "\n".join(parts) or "(no stage notes available)"


def _build_stage_prompt(
    visualization: Dict[str, Any],
    node: Dict[str, Any],
    expansion: Dict[str, Any] | None,
    article: Dict[str, Any] | None,
    stage_context: str = "",
) -> str:
    diagram = visualization.get("diagram") or {}
    title = (
        (article or {}).get("title") or diagram.get("title") or "Unknown paper"
    )
    context_block = (
        f"\nPAPER EXCERPTS ABOUT THIS STAGE:\n{stage_context[:12_000]}\n"
        if stage_context
        else ""
    )
    return (
        f"{STAGE_CODE_RULES}\n"
        f"PAPER: {title}\n\n"
        f"THIS STAGE:\n"
        f"  id: {node.get('id', '')}\n"
        f"  label: {node.get('label', '')}\n"
        f"  kind: {node.get('kind', '')}\n"
        f"  detail: {str(node.get('detail') or '')[:400]}\n\n"
        f"CONNECTIONS:\n{_stage_connections_block(visualization, str(node.get('id')))}\n\n"
        f"STAGE NOTES (paraphrase of the paper; your source material):\n"
        f"{_stage_notes_block(expansion)}\n"
        f"{context_block}"
    )


@traceable(name="generate_stage_code", run_type="chain")
def generate_stage_code(
    visualization: Dict[str, Any],
    node: Dict[str, Any],
    expansion: Dict[str, Any] | None = None,
    article: Dict[str, Any] | None = None,
    stage_context: str = "",
    llm: Any = None,
    provider: str | None = None,
    model: str | None = None,
    previous_code: str | None = None,
    runtime_error: str | None = None,
    layout_report: Dict[str, Any] | None = None,
) -> tuple[Dict[str, Any], Dict[str, str]]:
    """Write Three.js code for ONE diagram node, with one repair attempt.

    See `generate_scene_code` for the `previous_code` / `runtime_error` /
    `layout_report` repair mode; it works identically here.
    """
    prompt = _build_stage_prompt(visualization, node, expansion, article, stage_context)
    resolved_model = _resolve_stage_model(model)
    client = llm or build_chat_model(
        provider=provider,
        model=resolved_model,
        temperature=0,
        **_scene_model_kwargs(resolved_model),
    )

    code = _generate_with_repair(
        client,
        prompt,
        previous_code=previous_code,
        runtime_error=runtime_error,
        layout_report=layout_report,
        failure_label="stage code",
    )

    document = _scene_document(code, visualization, article)
    document["node_id"] = str(node.get("id", ""))
    document["title"] = str(node.get("label") or node.get("id") or document["title"])
    document["algorithm_name"] = document["title"]
    return document, describe_model(client, provider)


# --- user-directed refinement ---------------------------------------------------

# A refinement either changes how the animation LOOKS or what it SHOWS. The
# second kind quietly turns an illustration of the paper into an illustration
# of something else, so the user is warned before it is applied. The model
# decides when a provider is available; these word lists are the offline
# fallback and the tie-breaker, and are deliberately conservative: a request
# that only names positions, sizes, colours or timing is cosmetic.
COSMETIC_MARKERS = (
    "overlap", "overlapping", "collide", "on top of", "move", "shift", "nudge",
    "spacing", "space out", "spread", "gap", "apart", "closer", "further",
    "left", "right", "above", "below", "higher", "lower", "up", "down",
    "font", "size", "bigger", "smaller", "larger", "tiny", "readable", "legible",
    "color", "colour", "brighter", "darker", "opacity", "fade",
    "slower", "faster", "speed", "pause", "longer", "shorter", "duration",
    "camera", "zoom", "angle", "rotate", "align", "center", "centre",
    "label", "caption", "title", "rename", "wording", "typo",
    "hide", "show", "highlight", "arrow", "line",
)
FUNDAMENTAL_MARKERS = (
    "add a step", "add step", "add another", "extra step", "new step",
    "remove the step", "remove step", "delete the step", "skip the",
    "instead of", "rather than", "replace the", "swap the", "swap out",
    "reorder", "change the order", "before the", "after the",
    "change the formula", "different formula", "equation", "compute",
    "calculate", "multiply", "divide", "sum", "average", "softmax", "normalize",
    "should use", "make it use", "use a different", "different algorithm",
    "different mechanism", "how it works", "the logic", "the math",
    "more layers", "fewer layers", "more heads", "fewer heads", "number of",
    "input should", "output should", "feed", "connect", "disconnect",
    "loop back", "feedback", "attention to", "attend to",
)


class RefinementClassification(BaseModel):
    """What kind of change a refinement request asks for."""

    kind: Literal["cosmetic", "fundamental"] = Field(
        description=(
            "'cosmetic' when the request only changes presentation: positions, "
            "spacing, overlaps, sizes, colours, timing, camera, label wording. "
            "'fundamental' when it changes what the animation shows about the "
            "method: steps, their order, what is computed, how data flows, the "
            "number or kind of components, the formula."
        )
    )
    reason: str = Field(default="", description="One sentence saying why, in plain language.")


def _marker_hits(text: str, markers: Sequence[str]) -> List[str]:
    # Whole words only: "up" must not match "update", nor "sum" "summary".
    return [m for m in markers if re.search(rf"\b{re.escape(m)}\b", text)]


def _heuristic_classification(instruction: str) -> Dict[str, Any]:
    text = " ".join(instruction.lower().split())
    fundamental_hits = _marker_hits(text, FUNDAMENTAL_MARKERS)
    cosmetic_hits = _marker_hits(text, COSMETIC_MARKERS)
    if fundamental_hits and len(fundamental_hits) >= len(cosmetic_hits):
        return {
            "kind": "fundamental",
            "reason": "The request changes what the animation shows about the method "
            f"(it mentions: {', '.join(fundamental_hits[:3])}).",
            "basis": "heuristic",
        }
    return {
        "kind": "cosmetic",
        "reason": "The request only changes how the animation is presented."
        if cosmetic_hits
        else "No sign that the request changes the mechanism; treated as a presentation change.",
        "basis": "heuristic",
    }


_CLASSIFY_PROMPT = """\
You decide whether a user's requested change to an educational animation of a
research paper's method is COSMETIC or FUNDAMENTAL.

COSMETIC: presentation only — positions, spacing, overlapping labels, sizes,
colours, opacity, timing/speed, camera, caption or label wording, hiding or
showing decoration. The animation still shows the same method, the same steps
in the same order, computing the same things.

FUNDAMENTAL: the animation would show a different method — a step added,
removed, reordered or skipped; a different operation, formula or data flow;
a different number or kind of components; different inputs or outputs.

The animation is titled: {title}

The user's request:
{instruction}
"""


def classify_refinement(
    instruction: str,
    *,
    title: str = "",
    llm: Any = None,
    provider: str | None = None,
    model: str | None = None,
) -> Dict[str, Any]:
    """Cosmetic or fundamental, with a reason and how the answer was reached.

    Uses the model when one is reachable, the marker heuristic otherwise, and
    the heuristic again if the model's answer cannot be parsed. `basis` says
    which, because the UI's warning should not claim more certainty than it has.
    """
    instruction = " ".join(str(instruction or "").split())
    if not instruction:
        return {"kind": "cosmetic", "reason": "Empty request.", "basis": "heuristic"}

    client = llm
    if client is None:
        try:
            client = build_chat_model(provider=provider, model=model, temperature=0)
        except Exception:
            return _heuristic_classification(instruction)

    prompt = _CLASSIFY_PROMPT.format(title=title or "the method", instruction=instruction)
    try:
        result = client.with_structured_output(RefinementClassification).invoke(prompt)
        if isinstance(result, RefinementClassification):
            return {"kind": result.kind, "reason": result.reason.strip(), "basis": "model"}
        if isinstance(result, dict) and result.get("kind") in {"cosmetic", "fundamental"}:
            return {"kind": result["kind"], "reason": str(result.get("reason") or "").strip(), "basis": "model"}
    except Exception:
        pass
    try:
        raw = _strip_fence(_response_text(client.invoke(
            prompt + '\nAnswer with JSON only: {"kind": "cosmetic" | "fundamental", "reason": "..."}'
        )))
        parsed = RefinementClassification.model_validate_json(raw)
        return {"kind": parsed.kind, "reason": parsed.reason.strip(), "basis": "model"}
    except Exception:
        return _heuristic_classification(instruction)


_REFINE_RULES = (
    """\
You are editing an existing self-contained Three.js animation that TEACHES a
research paper's method. The user has asked for ONE change. Apply exactly that
change and nothing else: keep the mechanism, phases, worked example, label
text, colours and timing identical wherever the request does not mention them.
Your code runs inside a sandboxed harness that owns the page; you only build
and animate the scene graph.

"""
    + _CONTRACT_RULES
    + _PRESENTATION_RULES
)


def refine_scene_code(
    previous_code: str,
    instruction: str,
    *,
    title: str = "",
    kind: str = "cosmetic",
    llm: Any = None,
    provider: str | None = None,
    model: str | None = None,
) -> tuple[str, Dict[str, str]]:
    """Rewrite a stored program to apply one user-described change.

    Returns the new code and the provider/model that produced it. Static
    checks and one static repair apply exactly as for a fresh generation.
    """
    instruction = " ".join(str(instruction or "").split())
    if not instruction:
        raise SceneCodingError("The refinement request is empty.")
    consequence = (
        "\nThe user has acknowledged that this changes what the animation shows "
        "about the method, so the result will no longer match the paper. Make the "
        "requested change faithfully and update ctx.setCaption text so a viewer "
        "can tell what is now being shown.\n"
        if kind == "fundamental"
        else "\nThis is a presentation change: the method shown must stay exactly the same.\n"
    )
    prompt = (
        f"{_REFINE_RULES}\n"
        f"ANIMATION: {title or 'Proposed method'}\n"
        f"{consequence}"
        f"\nREQUESTED CHANGE:\n{instruction}\n"
        f"\nCURRENT PROGRAM:\n{previous_code}\n"
        "\nReturn the complete updated JavaScript only."
    )
    resolved_model = _resolve_stage_model(model)
    client = llm or build_chat_model(
        provider=provider,
        model=resolved_model,
        temperature=0,
        **_scene_model_kwargs(resolved_model),
    )
    code = _generate_with_repair(
        client,
        prompt,
        previous_code=None,
        runtime_error=None,
        layout_report=None,
        failure_label="refined code",
    )
    return code, describe_model(client, provider)


# --- offline fallback ---------------------------------------------------------

# A deterministic template used when no provider is configured: the diagram's
# nodes and edges are embedded as data and animated generically. `__GRAPH__` is
# replaced with `json.dumps` output, which is valid JavaScript and contains
# nothing executable.
_DIAGRAM_TEMPLATE = """\
// Offline fallback: a generic animation of the stored diagram. No model call
// was involved; boxes are diagram nodes and pulses trace diagram edges.
const GRAPH = __GRAPH__;

const state = { nodes: {}, pulses: [], labels: [] };

function layoutLayers(nodes, edges) {
  const incoming = {};
  nodes.forEach((n) => { incoming[n.id] = 0; });
  edges.forEach((e) => { if (e.target in incoming) incoming[e.target] += 1; });
  const layer = {};
  nodes.forEach((n) => { layer[n.id] = 0; });
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    edges.forEach((e) => {
      if (e.source in layer && e.target in layer) {
        const wanted = layer[e.source] + 1;
        if (layer[e.target] < wanted && wanted < nodes.length) {
          layer[e.target] = wanted;
          changed = true;
        }
      }
    });
    if (!changed) break;
  }
  return layer;
}

function init(ctx) {
  const { THREE, scene } = ctx;
  const kindColors = {
    input: ctx.theme.data, output: ctx.theme.output, operation: ctx.theme.process,
    data: ctx.theme.data, component: ctx.theme.muted,
  };
  const nodes = GRAPH.nodes || [];
  const edges = GRAPH.edges || [];
  const layer = layoutLayers(nodes, edges);

  const byLayer = {};
  nodes.forEach((n) => {
    (byLayer[layer[n.id]] = byLayer[layer[n.id]] || []).push(n);
  });
  const layerCount = Object.keys(byLayer).length || 1;
  const spanX = Math.max(10, layerCount * 4);

  nodes.forEach((n) => {
    const siblings = byLayer[layer[n.id]];
    const row = siblings.indexOf(n);
    const x = (layer[n.id] / Math.max(1, layerCount - 1) - 0.5) * spanX;
    const y = (row - (siblings.length - 1) / 2) * 2.6;
    const color = kindColors[n.kind] || kindColors.component;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 1.2, 1.2),
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 })
    );
    box.position.set(x, y, 0);
    scene.add(box);
    state.nodes[n.id] = box;

    const label = ctx.makeLabel(n.label || n.id, { size: 0.6, color: ctx.theme.ink });
    label.position.set(x, y + 1.3, 0);
    scene.add(label);
  });

  const lineMaterial = new THREE.LineBasicMaterial({ color: ctx.theme.border });
  const pulseGeometry = new THREE.SphereGeometry(0.22, 16, 16);
  const pulseMaterial = new THREE.MeshBasicMaterial({ color: ctx.theme.data });
  edges.forEach((e, index) => {
    const from = state.nodes[e.source];
    const to = state.nodes[e.target];
    if (!from || !to) return;
    const geometry = new THREE.BufferGeometry().setFromPoints([
      from.position, to.position,
    ]);
    scene.add(new THREE.Line(geometry, lineMaterial));
    const pulse = new THREE.Mesh(pulseGeometry, pulseMaterial);
    scene.add(pulse);
    state.pulses.push({
      mesh: pulse,
      from: from.position,
      to: to.position,
      offset: index * 0.35,
    });
  });

  ctx.setCaption(
    "Offline fallback: animating the stored diagram without a model call."
  );
}

function update(ctx, t) {
  state.pulses.forEach((p) => {
    const k = (t * 0.5 + p.offset) % 1;
    p.mesh.position.lerpVectors(p.from, p.to, k);
  });
  Object.values(state.nodes).forEach((box, i) => {
    box.position.z = Math.sin(t * 0.8 + i) * 0.08;
  });
}
"""


def scene_code_from_diagram(visualization: Dict[str, Any]) -> Dict[str, Any]:
    """A scene document built from the stored diagram, with no model call.

    The offline path: it gives the API something playable when no provider is
    configured, and gives tests a deterministic scene. The graph is embedded
    as JSON data inside a fixed template, so nothing here depends on a model.
    """
    diagram = visualization.get("diagram") or {}
    graph = {
        "nodes": [
            {
                "id": str(node.get("id", "")),
                "label": str(node.get("label") or node.get("id") or ""),
                "kind": str(node.get("kind") or "component"),
            }
            for node in (diagram.get("nodes") or [])
        ],
        "edges": [
            {
                "source": str(edge.get("source", "")),
                "target": str(edge.get("target", "")),
            }
            for edge in (diagram.get("edges") or [])
        ],
    }
    code = _DIAGRAM_TEMPLATE.replace(
        "__GRAPH__", json.dumps(graph, ensure_ascii=False, indent=2)
    )
    findings = check_scene_code(code)
    if findings:  # pragma: no cover - the template is fixed; this is a tripwire
        raise SceneCodingError(
            "The diagram template no longer passes its own checks: "
            + "; ".join(findings)
        )
    document = _scene_document(code, visualization, article=None)
    document["summary"] = (
        "Derived from the stored diagram without a model call. Boxes are "
        "diagram nodes; pulses trace diagram edges."
    )
    return document

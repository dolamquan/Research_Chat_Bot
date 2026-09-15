# Paper to Scene

How Zoetrope turns an indexed research paper into an interactive Three.js
animation of its proposed method.

## The central design decision

**The language model writes the animation code directly.** One LLM call
produces a self-contained Three.js program — plain JavaScript defining
`function init(ctx)` and `function update(ctx, t)` — that the frontend
executes inside a locked-down sandboxed iframe.

This replaces the earlier declarative pipeline (`scene_ir` / `scene_planner` /
`scene_verifier`), in which the model emitted a validated data document that a
fixed registry of sixteen React primitives rendered. That pipeline could prove
every step against a quote from the paper, but its visual vocabulary was
capped at whatever the sixteen primitives could draw. The trade was made
knowingly, in both directions, and this section is the record of it:

| | Declarative (retired) | Code generation (current) |
|---|---|---|
| Visual vocabulary | 16 fixed primitives | unbounded |
| Verifiable against the paper | yes, per step | **no** |
| Failure surface | validation errors at generation time | runtime errors in the sandbox |
| Security model | nothing executable ever emitted | browser iframe sandbox |

Because scenes can no longer be verified, the UI labels every scene as
model-written and illustrative, and nothing in the product may present one as
evidence about the paper.

## Security model

The boundary is the browser, not our checks.

1. **The iframe sandbox.** `SceneFrame.tsx` mounts the code with
   `sandbox="allow-scripts"` and no other capability. The document gets an
   opaque origin: no cookies, no storage, no same-origin access to the app,
   no navigation of the parent, no popups, no forms. The only channel out is
   `postMessage`, and the parent listens solely for `scene-ready` /
   `scene-error` events filtered by source window.
2. **Static contract checks** (`check_scene_code` in `scene_coder.py`,
   mirrored in `sceneRuntime.ts`): required entry points, a size cap, and a
   forbidden-construct list (network APIs, `import`/`require`, `eval`,
   `new Function`, storage, `window.parent`/`top`/`open`/`location`,
   `postMessage`, script markup, direct DOM mutation). These run at generation
   time — failures become a named repair prompt — and again client-side before
   the frame mounts. They are honesty checks that catch contract violations
   early; the sandbox is what makes violations harmless.
3. **Injection-safe embedding.** The code is serialized into the iframe's
   `srcDoc` as JSON with every angle bracket escaped, so a closing script tag
   inside the code cannot terminate the harness script.
4. API errors name missing environment variables, never their values.

## Pipeline

```
PDF (indexed)
  │
  ├─ document_structure.extract_structured_paper
  │     Docling when installed → sections, figures, equations, page numbers
  │     otherwise → coarse structure recovered from existing Qdrant chunks
  │     records `extraction_strategy` either way
  │
  ├─ document_structure.select_architecture_evidence
  │     abstract + proposed method + architecture + training + inference,
  │     in PRIORITY order; related work and baselines are excluded
  │
  ├─ scene_coder.generate_scene_code                   [one LLM call]
  │     prompt = runtime contract + diagram nodes/edges + method excerpts
  │     static checks; one repair attempt naming each violation
  │
  ├─ scene_store.upsert_scene
  │     code document + check report + provider + model + strategy
  │     schema_version "code-1.0"
  │
  └─ frontend: checkSceneCode → SceneCodePlayer → SceneFrame (sandboxed iframe)
        harness provides ctx: THREE, scene, camera, controls, renderer,
        makeLabel(), setCaption(); play / pause / restart via postMessage
```

## Verification: a scene is ready only after the browser has run it

The static checks prove that the code parses and obeys the contract. They
cannot prove it runs: `TypeError: row.forEach is not a function` on the first
frame passes every one of them. The backend cannot execute Three.js, so the
browser closes the loop and reports back.

```
generate (or use the stored scene)
  │
  ├─ probe   sceneProbe.ts mounts the code in an OFF-SCREEN frame with the
  │          same `sandbox="allow-scripts"` boundary, in probe mode
  │          (`buildSceneSrcDoc(code, title, {probe: true})`): the harness
  │          runs init, sweeps update(ctx, t) over t = 0…24 s in 0.25 s steps,
  │          renders a sample every 3 s, and at each sample records the label
  │          pairs its own nudging pass could NOT separate. One
  │          `scene-verified {ok, error, samples}` message comes back.
  │
  ├─ repair  a crash → POST generate-*-scene {force, runtime_error}
  │          persistent overlaps (a pair colliding in ≥ 2 samples) →
  │          POST generate-*-scene {force, layout_report}
  │          Either turns the request into a REPAIR of the stored code — the
  │          model sees the previous program plus the real error text or the
  │          exact colliding pairs and the seconds they collide — instead of
  │          a fresh attempt. Budget: 2 repairs per scene (sceneVerification.ts).
  │
  └─ report  POST /visualizer/item/{viz_id}/runtime  or
             POST /visualizer/item/{viz_id}/stage-scenes/{node_id}/runtime
             `verification.runtime = {status: passed|failed, error, overlaps,
             samples, checked_at}` is stored on the record, so "ready"
             survives a reload and a failed scene is never counted prepared.
```

`verification.runtime.status` starts as `unverified` for every stored scene.
In the UI, **ready** means `passed`; **playable** only means the contract
check passes. "All stages ready" and the Prepare-all counter use ready. A
stage whose scene was saved before this existed shows as unprepared until
Prepare all has probed it — that costs a probe, not a model call. A crash in
the live player is also reported, and its **Repair animation** action sends
the stack back rather than regenerating blind.

Overlap avoidance is enforced twice: the prompt's LAYOUT rules (explicit grid
pitch, one label per anchor, value rows below baselines, captions via
`setCaption`) and the measured `layout_report` repair above. The player's own
label-collision pass still runs on every frame; the probe only reports what
that pass could not fix.

## Refinement: the user describes a change

`SceneRefinePanel` (in the stage caption bar and under the whole-method
player) takes free text — "the value labels overlap the bars, move them below
the baseline" — and calls

| Method | Path | Body |
|---|---|---|
| `POST` | `/visualizer/item/{viz_id}/refine` | `{instruction, acknowledge_fundamental}` |
| `POST` | `/visualizer/item/{viz_id}/stage-scenes/{node_id}/refine` | same |

The server first classifies the request (`classify_refinement`): **cosmetic**
changes presentation only; **fundamental** changes what the animation shows
about the method — a step added, removed or reordered, a different operation
or formula, different data flow or component counts. The model decides when a
provider is reachable; conservative whole-word marker lists decide offline,
and the result carries `basis: model | heuristic` so the UI does not overstate
its certainty.

A fundamental request without `acknowledge_fundamental` returns **409** with
`{code: "needs_acknowledgement", kind, reason, basis}` and generates nothing.
The panel shows the reason and offers "Change it anyway" / "Keep the paper's
version". Cosmetic or acknowledged requests go to `refine_scene_code`, which
rewrites the stored program under "apply exactly this change and nothing
else", then the usual static checks. The record keeps an `edits` trail
(`{instruction, kind, basis, at}`) so the UI can say "Edited by you" and,
after a fundamental edit, "Diverges from the paper" — claims that must
survive reloads. Refined code starts `unverified` and is probed like any
other scene.

## The runtime contract

Generated code sees exactly one object, `ctx`, built by the harness in
`sceneRuntime.ts`:

| Field | Meaning |
|---|---|
| `THREE` | the three.js module (pinned r170, loaded from jsDelivr inside the frame) |
| `scene` | a `THREE.Scene` with background and lights prepared |
| `camera` | a `PerspectiveCamera` with OrbitControls attached |
| `controls`, `renderer` | the OrbitControls and WebGLRenderer instances |
| `width`, `height` | live viewport size in pixels |
| `makeLabel(text, opts)` | a crisp text sprite, so code never needs the DOM |
| `makePanel(title, opts)` | a dark card with border and colored heading; returns a group |
| `makeBars(values, opts)` | signed numeric bars with a shared baseline and value labels; returns a group |
| `makeMatrix(values, opts)` | bracketed numeric/symbolic matrix; optional title, cell size and decimals; labels exposed in `group.userData.cells` |
| `makeNetwork(layerSizes, opts)` | layered neurons with thin connections; optional signed weights indexed by connection layer, destination, source; meshes in `group.userData.layers` |
| `theme` | the theatre palette; independent from the unchanged main 3D overview |
| `setCaption(text)` | the caption above the figure, for narrating phases |

The code must define `function init(ctx)` (build once) and
`function update(ctx, t)` (animate; `t` is seconds since start). The harness
owns the render loop, resizing, damping, error capture and restarts. A frame
that throws stops the loop, shows the error inside the frame, and reports it
to the player. Stage playback returns to the overview and offers an explicit
Regenerate animation action. Restart builds a new module scope, preventing
old arrays and objects from accumulating. The camera fits geometry and label
anchor points after initialization and resize. The theatre supplies typography,
label collision handling, annotation clearance, and outlines for existing blocks.

### Generation latency and scope validation

Stage preparation uses a shared five-request queue, prioritizing animations
ahead of written explanations. The scene coder can use existing notes and
stage-specific paper excerpts, so new notes are not a prerequisite. This
preserves five simultaneous scene requests when explanations are cached.
Identical scene requests share their pending promise in
the client and their pending build within each backend process. Independent
nodes remain concurrent; a failed build is removed so it can be retried.

The visualizer resolves saved storyboards and stage scenes together for the
active diagram before declaring readiness or automatically requesting a missing
animation. A stage counts as prepared only when both its storyboard and a
saved scene passing the client contract are present. During lookup the toolbar
shows "Checking saved stages"; lookup errors have a retry action. "Prepare all"
remains visible during playback while any stage is missing, uses the active
variant's node count, and leaves failed stages available to retry. Only a fully
prepared diagram displays "All stages ready". This avoids treating a
storyboard-only cache or an empty loading map as completed animation work.

In addition to the contract checks shared with the browser, the backend uses
Tree-sitter to parse modern JavaScript and check lexical references without
executing generated code. Undefined names such as an `init`-local `rightX`
used by `update` trigger the single repair attempt, which includes both the
original code and named findings. Cached code is checked before reuse;
invalid stage records are excluded from listings and regenerated on demand.
Validation results are cached by exact code (128 entries), with fresh lists
returned to callers so a caller cannot mutate the cached result.
Scope checks do not prove runtime behavior or scientific correctness.

The reusable panel and bar helpers reduce drawing boilerplate in generated
answers. Generation prompts specify a consistent palette, concise labels,
front-facing layouts and compact programs. Provider generation time still
depends on model and load; no live-provider latency benchmark is assumed.

Install the pinned `tree-sitter` and `tree-sitter-javascript` dependencies from
`backend/requirements.txt` when upgrading. Regression coverage includes the
Layer Normalization scope failure, repair prompts, cached-code validation,
concurrent requests and sandbox playback controls.

For responsive scenes, an optional `resize(ctx)` hook can reposition panels
and call `ctx.setContentHeight(pixels)` to use vertical scrolling. The reviewed
Layer Normalization example stacks panels below 760px width, preserving text
size instead of compressing three panels into a phone viewport. Scroll mode
disables orbit gestures so touch scrolling works normally.

## Scene document

Stored per `(viz_id, schema_version)` in the existing `algorithm_scenes`
table (the store is format-agnostic):

```json
{
  "format": "threejs-code@1",
  "language": "javascript",
  "runtime": "three@0.170",
  "title": "…", "algorithm_name": "…",
  "summary": "taken from the code's leading comment",
  "code": "function init(ctx) { … } function update(ctx, t) { … }"
}
```

The verification report is the static check result plus the browser's
verdict once it has run the code:
`{"valid": bool, "findings": [string], "checks": "static", "runtime": {"status": "unverified" | "passed" | "failed", …}}`.
`valid` and `runtime.status` are kept apart on purpose: a scene can be
contract-complete and still crash, and the UI says which.

## Per-stage scenes (the dynamic stage theater)

The same pipeline, scoped to one diagram node: `generate_stage_code` in
`scene_coder.py` gets the node, its immediate neighbours, and the stored
expansion text as source material, under the identical contract and checks.
Records live in `stage_scene_store` keyed `(viz_id, node_id, schema_version)`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/visualizer/generate-stage-scene` | `{viz_id, node_id, force, provider, model, runtime_error, layout_report}` — with `force`, evidence turns the rebuild into a repair of the stored code |
| `GET` | `/visualizer/item/{viz_id}/stage-scenes` | All stored stage scenes; empty list, never 404 |
| `POST` | `/visualizer/item/{viz_id}/stage-scenes/{node_id}/runtime` | The browser's verdict after probing: `{status, error, overlaps, samples}` |
| `POST` | `/visualizer/item/{viz_id}/stage-scenes/{node_id}/refine` | A user-described change; 409 until a fundamental one is acknowledged |

In the UI, **Prepare all stages** generates each node's dynamic scene right
after its expansion (the fresh mechanism text plus stage-targeted paper
excerpts are the scene's source material). The dynamic scene IS the stage:
it fills the canvas, and the playback bar drives it — pause pauses it, replay
restarts it from t=0, ✨ toggles it (Shift-click regenerates). Focusing a
stage that has no scene writes one on the spot; until it arrives the bar
shows progress over the bare machine room. There is no declarative fallback
any more: the actor-scene and scene-graph tiers (`scene_composer`,
`scene_graph`, `ProcessTheater`, `SceneStage`, `SceneGraphStage`) were
retired outright, and `expand-node` now stores only text — no composed
visuals.

## Provider configuration

```env
LLM_PROVIDER=openai        # or anthropic; unset means openai
OPENAI_API_KEY=
OPENAI_MODEL=              # app-wide default model (gpt-4o-mini if unset)
SCENE_MODEL=               # scene/stage CODE generation only; overrides the
                           # chain for this one task (weak models write
                           # Three.js that crashes at runtime)
STAGE_SCENE_MODEL=         # per-STAGE scenes only; falls back to SCENE_MODEL.
                           # Stages are smaller tasks — a mini model is
                           # several times faster there
SCENE_REASONING_EFFORT=    # deliberation cap for reasoning models writing
                           # scene code; default "low" (the big latency
                           # lever), "off" restores the model default
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=           # default claude-sonnet-4-5
```

`app/rag/llm_provider.py` centralises construction, exactly as before.
Anthropic support needs `pip install langchain-anthropic`.

## API endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/visualizer/generate-scene` | `{viz_id, force, provider, model, allow_offline_fallback}` |
| `GET` | `/visualizer/item/{viz_id}/scene` | Stored code document + check report |
| `POST` | `/visualizer/item/{viz_id}/verify-scene` | Re-runs static checks; no LLM call |
| `GET` | `/visualizer/providers` | Which providers are configured. Never returns keys |

Error mapping: `404` unknown visualization or no scene; `422` bad provider
name; `502` provider not configured, or code that still fails the checks after
one repair. Error text names a missing environment variable but never its
value.

## Fallback behaviour

| Failure | Behaviour |
|---|---|
| Docling missing or failing | Coarse structure from chunks; `extraction_strategy` records it |
| Code fails the static checks | One repair attempt quoting each violation |
| Repair also fails | `SceneCodingError` → `502`; nothing is persisted |
| No provider configured | `502`, or the offline path with `allow_offline_fallback` |
| Offline path | A fixed template animating the stored diagram's nodes and edges; no model call (`fallback: "diagram_template"`) |
| Stored code no longer passes the checks | The client refuses to run it and lists the reasons |
| Code throws at runtime | Error overlay in the frame + banner in the player; Restart recovers |

## Requirements at view time

The iframe loads three.js from jsDelivr (pinned to the version in
`package.json`), because a sandboxed opaque origin needs a CORS-enabled host
for module fetches. Viewing a scene therefore needs internet access; generating
one already did.

## What was retired

First wave: `scene_ir.py`, `scene_planner.py`, `scene_verifier.py`,
`evaluate_scene_generation.py`, the sixteen primitive components,
`SceneCompiler`, `Scene2DView`, `ScenePlayer`, `sceneValidation`, the scene
JSON fixtures, and `test_no_code_generation.py` — the suite whose entire
purpose was to keep model-written code out of this feature.

Second wave: the declarative stage-playback tiers — `scene_composer.py`,
`scene_graph.py`, `ProcessTheater`, `SceneStage`, `SceneGraphStage`, the
primitive library under `visualization/primitives/`, and their tests. Node
expansions still store text (overview, mechanism, storyboard captions): it
feeds the stage-scene prompt and the idle machinery inside each 3D chassis,
but nothing declarative is rendered as a stage animation any more.

If verifiability becomes a requirement again, the old architecture is fully
described in this file's git history.

## Current limitations

- **Nothing checks the animation against the paper.** A scene can be fluent
  and wrong; treat it as a sketch, not a source.
- **Quality varies with the model.** There is no eval harness for generated
  code beyond the contract checks; judging fidelity needs a human eye.
- **The offline template is deliberately plain** — labelled boxes and edge
  pulses derived from the diagram.
- **jsdom cannot execute the iframe**, so automated coverage stops at contract
  checks, srcDoc construction and player states; real WebGL behaviour needs a
  browser.

## How to run tests

```bash
# Backend
cd backend
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest

# Frontend
cd frontend
pnpm install
pnpm run test
pnpm run build
```

Every test runs offline. No test calls a provider, a vector store, or the
network.

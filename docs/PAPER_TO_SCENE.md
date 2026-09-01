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

## The runtime contract

Generated code sees exactly one object, `ctx`, built by the harness in
`sceneRuntime.ts`:

| Field | Meaning |
|---|---|
| `THREE` | the three.js module (pinned r170, loaded from jsDelivr inside the frame) |
| `scene` | a `THREE.Scene` with background and lights prepared |
| `camera` | a `PerspectiveCamera` with OrbitControls attached |
| `controls`, `renderer` | the OrbitControls and WebGLRenderer instances |
| `width`, `height` | live canvas size in pixels |
| `makeLabel(text, opts)` | a crisp text sprite, so code never needs the DOM |
| `setCaption(text)` | the caption bar under the canvas, for narrating phases |

The code must define `function init(ctx)` (build once) and
`function update(ctx, t)` (animate; `t` is seconds since start). The harness
owns the render loop, resizing, damping, error capture and restarts. A frame
that throws stops the loop, shows the error inside the frame, and reports it
to the player, which offers Restart.

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

The verification report is now the static check result:
`{"valid": bool, "findings": [string], "checks": "static"}`.

## Per-stage scenes (the dynamic stage theater)

The same pipeline, scoped to one diagram node: `generate_stage_code` in
`scene_coder.py` gets the node, its immediate neighbours, and the stored
expansion text as source material, under the identical contract and checks.
Records live in `stage_scene_store` keyed `(viz_id, node_id, schema_version)`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/visualizer/generate-stage-scene` | `{viz_id, node_id, force, provider, model}` |
| `GET` | `/visualizer/item/{viz_id}/stage-scenes` | All stored stage scenes; empty list, never 404 |

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

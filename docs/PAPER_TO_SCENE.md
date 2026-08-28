# Paper to Scene

How ResearchMind turns an indexed research paper into an interactive, evidence-grounded
2D/3D animation of its proposed method.

## The central constraint

**The language model never generates executable content.** No React, no JavaScript,
no Three.js, no HTML, no shaders, no code of any kind. It emits a validated data
document — an `AlgorithmScene` — whose every field is an enum from a closed
whitelist, an identifier that must resolve inside the same document, a number in a
checked range, or display text.

The frontend maps the one free-form-looking field, `primitive`, through a fixed
registry of React components. That string is only ever used as a lookup key.

This matters because an earlier iteration of this feature *did* have the model write
Three.js, run inside a sandboxed iframe. The isolation worked, but two problems did
not go away: the output could not be checked against the paper, and it failed at
runtime in ways no schema could catch. Emitting data instead converts both into
validation errors at generation time.

That path has been **removed**, not merely bypassed: `scene_coder.py`,
`sceneSandbox.ts`, `SceneFrame.tsx` and the vendored `three-sandbox.js` are gone,
along with the `StageAnimation` type and the `animation` field on node expansions.
`tests/test_no_code_generation.py` asserts it stays gone, and scans the shipped
visualization package for `eval`, `new Function`, `dangerouslySetInnerHTML`,
`srcDoc` and dynamic imports of variables.

The declarative scene DSL (`scene_composer` / `SceneStage`) is untouched and stays
as the middle fallback tier: it is data-only, so it satisfies the same constraint.

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
  │     abstract + proposed method + architecture + training + inference +
  │     implementation + architecture figure captions, in PRIORITY order
  │     related work, baselines, references, conclusions are excluded
  │
  ├─ scene_planner.generate_algorithm_scene            [one LLM call]
  │     structured output when the provider supports it
  │     JSON fallback + one repair attempt naming the validation error
  │     existing DiagramIR supplied as structural context
  │     entity ids reuse diagram node ids
  │
  ├─ scene_ir.AlgorithmScene                           [strict validation]
  │     unique ids, no dangling references, ranges, budgets
  │     construction fails rather than producing an invalid scene
  │
  ├─ scene_verifier.verify_scene                        [deterministic, no LLM]
  │     grounding ratios, dataflow order, connectivity, loops, complexity
  │
  ├─ scene_store.upsert_scene
  │     scene JSON + verification report + provider + model + strategy
  │
  └─ frontend: sanitizeScene → SceneCompiler → ScenePlayer
        2D (SVG) / 2.5D / 3D (r3f) from the SAME scene object
```

## Scene IR

Defined in `backend/app/rag/scene_ir.py`, mirrored in
`frontend/src/app/components/visualization/sceneTypes.ts`. Schema version `1.0`.

| Model | Purpose |
|---|---|
| `EvidenceRef` | A quote from the paper, with section and page. |
| `SceneEntity` | A participant: tensor, module, document set, population. |
| `SceneStep` | One animated beat, rendered by exactly one primitive. |
| `CameraCue` | Framing for a step. |
| `AlgorithmScene` | The whole document. |

Enforced at construction:

- All entity, step and evidence ids unique
- Every referenced entity, evidence id and step id resolves
- `confidence` in `0..1`; `duration_ms` in `200..20000`; `transition_ms` in `0..10000`
- At most 40 entities, 40 steps, 80 evidence refs
- `primitive` must be in the whitelist — an unknown value is rejected

Layered on top by `scene_verifier` as findings rather than exceptions: grounding
ratios, inputs consumed before production, orphan entities, impossible loops,
overconfident uncited steps, illustrative-versus-reported values.

## Supported primitives

Sixteen, and only sixteen. Adding a seventeenth requires touching four places
(see below).

| Primitive | Meaning |
|---|---|
| `token_stream` | A sequence of discrete items flowing in order |
| `vector_array` | A 1-D array of numbers |
| `matrix_transform` | A 2-D array being multiplied or projected |
| `attention_links` | Weighted connections between two sets |
| `split_parallel` | One input fanning into parallel branches |
| `merge_parallel` | Parallel branches combining |
| `elementwise_combine` | Two aligned collections combined position by position |
| `nonlinearity` | A pointwise function |
| `normalize` | Values rescaled to a common range |
| `distribution` | A probability or score distribution |
| `filter_select` | A subset chosen from candidates |
| `compare` | Two quantities scored against each other |
| `loop_repeat` | A block repeated a stated number of times |
| `data_transfer` | Something moving between components |
| `state_transition` | A component changing state |
| `note` | No mechanism asserted; also the fallback |

## Grounding and uncertainty

Every entity and step carries `evidence_ids` pointing at `EvidenceRef` entries.
The planner is given a **fixed menu** of citable ids built from the structured
paper; ids outside that menu are stripped after generation, and quote text is
filled in from our candidates rather than from the model, so a paraphrase cannot
be presented as a quotation.

Anything uncited is displayed as uncertain — dashed borders in both 2D and 3D, an
`uncertain` badge in the controls, and an explicit statement in the evidence panel.
`scene_verifier` fails a scene outright when fewer than 60% of steps are grounded.

Worked-example numbers are allowed and expected, but a step carrying `values` or
`items` without a citation is reported as `illustrative_values`, so invented
numbers are never shown with the authority of reported ones.

## Provider configuration

```env
LLM_PROVIDER=openai        # or anthropic; unset means openai
OPENAI_API_KEY=
OPENAI_MODEL=              # default gpt-4o-mini
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=           # default claude-sonnet-4-5
```

`app/rag/llm_provider.py` centralises construction. `generator.get_llm()` delegates
to it and keeps its original signature and default, so all existing call sites are
unaffected. Both providers return the same Pydantic models; the planner uses
structured output where available and the JSON path otherwise.

Anthropic support needs `pip install langchain-anthropic`. Without it,
`available_providers()` simply omits it and `GET /visualizer/providers` reports
what the deployment can actually reach.

## Docling setup

```bash
pip install docling
```

Optional. With it, `extract_structured_paper` recovers sections, figure captions,
equations and page numbers in reading order. Without it — or when it fails on a
particular PDF — the function returns a coarse structure rebuilt from existing
Qdrant chunks and sets `extraction_strategy` to `legacy_chunks`. Ingestion is
unaffected either way.

## API endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/visualizer/generate-scene` | `{viz_id, force, provider, model, allow_offline_fallback}` |
| `GET` | `/visualizer/item/{viz_id}/scene` | Stored scene + verification report |
| `POST` | `/visualizer/item/{viz_id}/verify-scene` | Re-runs deterministic checks; no LLM call |
| `GET` | `/visualizer/providers` | Which providers are configured. Never returns keys |

Error mapping: `404` unknown visualization or no scene; `422` bad provider name or
a generated scene that fails validation; `502` provider not configured or planning
failed. Error text names a missing environment variable but never its value.

## Fallback behaviour

| Failure | Behaviour |
|---|---|
| Docling missing or failing | Coarse structure from chunks; `extraction_strategy` records it |
| Structured output unsupported | JSON prompt with the schema appended |
| Invalid JSON or invalid scene | One repair attempt quoting the exact error |
| Repair also fails | `ScenePlanningError` → `502`; nothing is persisted |
| No provider configured | `502`, or the offline path with `allow_offline_fallback` |
| Offline path | Scene derived from stored `process_steps`, uncited, marked low-confidence |
| Unknown primitive reaches the client | `NoteScene` fallback; the step still plays |
| Malformed scene reaches the client | `sanitizeScene` repairs it and reports what it changed |

## Security constraints

1. The model emits data only. Nothing it returns is executed, imported, or rendered
   as markup.
2. `primitive` is used solely as a key into `primitiveRegistry`, which is built with
   `Object.create(null)` and read through a `hasOwnProperty` guard — so a string like
   `"toString"` or `"constructor"` cannot reach an inherited function.
3. No `eval`, no `new Function`, no generated JSX, no dynamic imports of
   model-supplied paths, no model-supplied shaders, no `dangerouslySetInnerHTML`.
4. `sanitizeScene` coerces every field to a known primitive type before render.
5. API errors name missing environment variables, never their values.

## How to add a primitive

Four edits, in this order:

1. `backend/app/rag/scene_ir.py` — add to the `ProcessPrimitive` Literal **and** to
   `SUPPORTED_PRIMITIVES`.
2. `frontend/.../visualization/sceneTypes.ts` — add to `SUPPORTED_PRIMITIVES`.
3. `frontend/.../visualization/primitives/YourScene.tsx` — a component taking
   `PrimitiveSceneProps`.
4. `frontend/.../visualization/SceneCompiler.tsx` — add the registry entry.

Then add a line to `PRIMITIVE_GUIDE` in `scene_planner.py` so the model knows when
to choose it. `sceneCompiler.test.tsx` asserts the whitelist and the registry agree,
so a missed step fails the suite rather than silently degrading to `note`.

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
pnpm run typecheck
pnpm run build
```

Every test runs offline. No test calls a provider, a vector store, or the network.

## Evaluation methodology

```bash
cd backend
python scripts/evaluate_scene_generation.py \
  --references tests/fixtures/scenes \
  --generated  path/to/generated \
  --json-out   eval_report.json
```

Reports node and edge precision/recall/F1, grounded entity and step ratios,
hallucinated entity and relationship counts, disconnected component counts, schema
validity, render readiness, provider, model and latency. Graph analysis uses
NetworkX.

Entities are compared on **normalised labels**, not ids: two correct scenes will not
agree on identifiers, so id comparison would report a total mismatch for a good
scene. A reference with no matching generated file counts as a total miss, so partial
coverage cannot flatter a score.

**No LLM judge**, by design. The failures this feature actually exhibited —
entities absent from the paper, steps consuming data before it exists,
disconnected architectures — are all decidable from the graph. An LLM judge could
be added for qualitative questions later, but must not be the only evaluator.

## Model-graph verification (optional scaffolding)

`backend/app/rag/model_graph.py` defines a `ModelGraphAdapter` protocol and a
common graph shape:

```python
{"format": "onnx", "nodes": [{"id", "op", "label"}], "edges": [{"source", "target"}]}
```

`OnnxGraphAdapter` is implemented behind an optional `onnx` import;
`TorchScriptGraphAdapter` and `SavedModelGraphAdapter` are seams that raise
`NotImplementedError` with a pointer here.

Where a paper ships an artifact, `compare_topology` reports overlap between the
paper-derived graph and the real one. **Netron** and **Google Model Explorer** are
the natural viewers for the artifact side: both consume ONNX/TFLite/SavedModel
directly, so the intended workflow is to export the released model, open it in
either tool to read the true topology, and use `compare_topology` to quantify where
the paper-derived scene and the shipped graph diverge.

This is supporting evidence, never a gate. Names in a paper diagram and operators in
a compiled graph rarely align one-for-one, and most papers ship no artifact at all.

## Current limitations

- **Scene quality is unverified against real papers at scale.** The pipeline,
  schema, verifier and renderers are tested; the *usefulness* of what a given
  model produces for a given paper is not, and needs a labelled reference set.
- **The 2D view uses a built-in longest-path layout**, not ELK or React Flow.
  Scenes are small and acyclic by construction, so this suffices; `layoutEntities`
  is the single function to replace if scenes grow.
- **`camera_cues` are carried and validated but not yet driven** by the player;
  the 3D view uses a fixed camera with orbit controls.
- **The Playwright browser smoke test is not present.** Playwright was not
  configured in this repository, and the equivalent coverage runs in jsdom
  (`scenePlayer.smoke.test.tsx`) with the r3f `Canvas` stubbed. A browser run
  would additionally cover real WebGL, actual 3D entity clicks, and genuine
  uncaught-error capture.
- **Docling is untested against a real PDF here** — the Docling mapping is covered
  by a stub document, and the fallback path is covered directly.
- **Token usage is reported only when the provider supplies it**; the LangChain
  callback plumbing to capture it consistently is not wired.

# Visualization benchmark — 2026-09-07

Local measurements support earlier availability of animations, less duplicate generation work, and a readable responsive example. They do **not** establish faster live model generation or usability with real participants. The live test remains pending approval.

The subsequent [full-library design audit](VISUALIZATION_DESIGN.md) covers all 27 currently playable saved programs and measures the shared label-layout optimization. The historical results below retain their original, narrower scope.

## Validation

- Backend: 175 tests passed, including validation-cache isolation.
- Frontend: 31 tests passed; production build succeeded.
- Repository typechecking remains blocked by the pre-existing missing tsconfig and React Three Fiber typing issues; a successful build is not a clean typecheck.
- Original screenshot error reproduced in Chromium. Original checks accepted the broken code; revised checks identified both undefined rightX references.
- Original code baseline: `980ef6474a3ac47067703b64ce1dbc6526dee5a2`. Revised results use the current working tree. Benchmarks were rerun sequentially after the test/build processes finished to reduce CPU contention.

## Time until animations are available

These are **controlled-delay tests, not live API times**. The script extracts and executes the actual original/revised prepareAllStages functions. Nine stages, five repetitions per scenario, median wall times. Artificial service delays: balanced = 60ms notes/60ms scene; scene-heavy = 5/120ms; notes-heavy = 120/5ms; cached notes = no notes call/120ms scene. Windows timer granularity adds overhead.

| Scenario | Original first scene | Revised first scene | Original all scenes | Revised all scenes | Reduction, all scenes |
|---|---:|---:|---:|---:|---:|
| balanced | 136.72ms | 74.70ms | 260.67ms | 136.65ms | 47.6% |
| scene_heavy | 136.73ms | 123.61ms | 276.09ms | 247.10ms | 10.5% |
| notes_heavy | 137.20ms | 13.43ms | 276.29ms | 29.47ms | 89.3% |
| notes_cached | 122.78ms | 121.71ms | 246.19ms | 244.52ms | 0.7% |

| Scenario | Original scenes + notes complete | Revised scenes + notes complete | Peak revised requests |
|---|---:|---:|---:|
| balanced | 260.69ms | 262.05ms | 5 |
| scene_heavy | 276.10ms | 263.08ms | 5 |
| notes_heavy | 276.30ms | 276.76ms | 5 |
| notes_cached | 246.19ms | 244.52ms | 5 |

The first revision had a regression: cached-note preparation took 371.65ms versus 249.03ms originally (49.2% longer). A scene-first shared queue now preserves five outstanding requests, rather than coupling each scene to a note task in three workers. It improves time-to-playable-scenes without claiming a comparable reduction in completion time for all explanations.

## Work avoided and validation overhead

Five simultaneous requests for one stage produced five expensive calls originally and one with request sharing, in every one of five runs: **80% less duplicated generation work**. The injected call lasts 80ms. Wall time is essentially unchanged because the original duplicate calls also ran concurrently. This does not imply 80% lower total API cost for normal use.

| Validation path | Median per scene | Samples |
|---|---:|---:|
| original | 4.915250ms | 260 |
| revised_cold | 11.359100ms | 260 |
| revised_warm | 0.000200ms | 260 |

The validation corpus contains 13 locally stored scenes. Cold revised checks include syntax/scope analysis and are intentionally more expensive than the original regex checks. A bounded 128-entry cache avoids repeating those checks on identical code. Warm timings are near timer resolution; treat them as “below 0.01ms”, not as literal zero or a precise huge speedup.

## Browser efficiency and readability

Headless Chromium, SwiftShader software WebGL, local pinned Three.js assets. Each case collects about 2.2 seconds of frames after initialization, samples update at 0–24 seconds, checks pause/resume, and restarts five times. One run per viewport is a smoke benchmark, not a robust cross-device percentile estimate. No CPU throttling or real mobile GPU was used.

The usable original comparison has only its rightX scope error corrected; otherwise the original scene and runtime are retained. The redesigned scene uses one six-feature token rather than three tokens, so geometry reductions include simplification of the example. They are not universal renderer gains.

| Scene / width | Median frame interval | p95 frame CPU | Draw calls | Triangles | Smallest label | Labels below 12px | Offscreen label centers |
|---|---:|---:|---:|---:|---:|---:|---:|
| original_scope_fixed / 1132px | 16.60ms | 1.00ms | 54 | 10554 | 14.53px | 0 | 1 |
| original_scope_fixed / 600px | 16.60ms | 1.10ms | 34 | 5754 | 14.52px | 0 | 3 |
| original_scope_fixed / 390px | 16.60ms | 0.80ms | 29 | 5744 | 14.53px | 0 | 9 |
| revised / 1132px | 16.70ms | 1.10ms | 58 | 284 | 12.46px | 0 | 0 |
| revised / 600px | 16.60ms | 1.70ms | 58 | 284 | 14.87px | 0 | 0 |
| revised / 390px | 16.60ms | 1.10ms | 58 | 284 | 14.16px | 0 | 0 |

The redesigned desktop example uses 97.3% fewer triangles. Draw calls increased from 54 to 58; additional labels increased textures from 9 to 31. Both scenes remain near the 60Hz frame cadence in this environment; there is no demonstrated FPS speedup.

Revised renderer resource counts are 13 geometries and 31 textures, unchanged after five restarts. This is evidence against a restart-related GPU-resource leak in this example, not a measurement of total browser memory or an endurance test.

The first visual revision shrank labels to 6.62px at 600px width and 4.31px at 390px width. The responsive example now stacks panels with vertical scrolling below 760px width. The runtime supports an optional resize hook and explicit scrollable content height, leaving existing scene contracts compatible. Orbit gestures are disabled while scrolling.

All revised widths passed pause, resume, phase updates and restart without a scene error. Narrow cases passed scrolling. Label sizes are calculated from sprite texture font size, world scale, camera projection and actual canvas height; the 12px threshold is an engineering readability target, not an accessibility certification.

- [Desktop screenshot](../benchmarks/results/revised-1132.png)
- [Phone screenshot](../benchmarks/results/revised-390.png)
- [Phone, scrolled down](../benchmarks/results/revised-390-bottom.png)

## What remains unproven

- Live model latency, token savings, actual API cost, repair rate, and generated-scene quality. Reusable drawing helpers do not by themselves prove shorter generated answers.
- Time to load the complete application on a slow network; browser tests use locally supplied Three.js, and the production build still warns about large bundles.
- Task success and comprehension by ordinary users. A practical next test is to ask nontechnical participants to open a stage, identify the input/output transformation, pause/restart, scroll through a phone layout, and recover from an error; record completion, assistance required and misunderstanding.
- Consistent readability across arbitrary future model-generated scenes. The measured responsive result is the reviewed Layer Normalization example; the new runtime helpers make the same approach available to other scenes.

## Pending live comparison

Automatic approval review rejected sending saved paper context to the external model. No live benchmark requests were sent. The prepared test alternates original/revised generation order for three pairs using the configured OpenAI gpt-5-mini model. Six generation runs, up to twelve calls if every run needs its single repair attempt. It records elapsed time, input/output token usage, source length and validation failures in local result files; it does not change saved scenes.

Payload: the saved Layer Normalization node details, diagram title and immediate connection labels, plus the respective generation instructions. No PDF chunks or expansion text. [Exact outbound prompt preview](../benchmarks/results/live-request-preview.json). Running it uses the configured API account and may incur API charges.

## Reproduce

From the repository root, with backend requirements and frontend dependencies installed:

```powershell
python backend/benchmarks/visualization_benchmark.py
python backend/benchmarks/visualization_benchmark.py --preview-live
cd frontend
node scripts/benchmark-preparation.mjs
# Set PLAYWRIGHT_MODULE to an installed playwright-core package if needed.
node scripts/benchmark-scenes.mjs
```

The scripts use the local saved-scene corpus and original backup. Raw JSON results are in benchmarks/results (gitignored). After collecting results, run `python backend/benchmarks/write_visualization_report.py` to regenerate this report. Run benchmarks sequentially without a simultaneous build/test workload.

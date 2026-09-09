# Visualization design verification

The presentation changes apply only inside the theatre/scene player used by every stage and whole-algorithm animation. Saved programs receive them when reopened; users do not need to regenerate them. The main 3D overview retains its original design.

Future papers use the same path. Both whole-paper and per-stage generation now include one shared presentation policy, also retained in repair prompts. The stage prompt's conflicting cyan/violet instructions were removed. The offline diagram template reads ctx.theme directly and creates matte materials. None of these choices branches on a paper title, article ID, or saved scene ID.

The follow-up future-paper checks passed: 68 offline coder/validation tests, including generation and repair with previously unseen paper and stage identities. The browser regression constructs a fresh scene without reading the paper database, requests conflicting source styles, and adds another mesh during playback. It verifies shared backgrounds, matte materials, readable label contrast, and restoration of the original source values at both 390 px and 830 px widths. These checks establish common policy and renderer coverage; they do not guarantee the scientific quality of every future model response.

## Shared presentation

The theatre follows the supplied mathematical-film reference: black negative space, a large serif heading, unboxed text with a subtle black halo, fine outlines, translucent block structures, and restrained semantic color. Matrix/network helpers provide bracketed values, layered neurons, and signed teal/coral connections for future generated mechanisms. No stored paper program is overwritten by this styling pass. The helper demonstration uses explicitly illustrative values, not paper data.

While the theatre is open, the paper picker and details panel are hidden to give the figure the full available workspace width. They return when playback closes. The underlying 3D overview is temporarily invisible so its floating labels cannot show through the theatre. Its renderer and palette remain byte-for-byte equal to HEAD.

Existing block geometry receives outlines through a single additional batched line pass, outside the authored scene graph. Original material opacity, transparency, depth-writing, color, and lighting values are restored after drawing. Source geometry, phases, and update functions remain intact.

Labels retain their aspect ratio, use 12–18 px body text and 18–26 px serif section headings, and stay upright. Labels move apart when their ink bounds collide; long explanatory annotations also avoid block geometry. Short tokens and values can remain inside their own cells. Direction glyphs retain authored rotation and are excluded from prose font-size checks. Leader lines connect displaced labels to source positions. Duplicate stage headings are suppressed during rendering. Camera fitting uses geometry and label anchor points, avoiding excessive zoom-out caused by oversized source sprites. Authored values are restored before each animation update.

Programs with a responsive resize hook retain their authored layout. Older wide diagrams get a scrollable 960 px canvas below a 640 px viewport width. The fixed header explains scrolling, and scrolling gestures take precedence over rotation. This preserves dense matrices at readable sizes on phones. It does not turn every mechanism into a three-panel diagram. Generation instructions expose ctx.theme and request matching presentation conventions.

The flat overview replacement was reverted at the user's direction. Visualizer3D.tsx and diagramPalette.ts match their original HEAD versions: perspective camera, depth-based chassis layout, NodeAssembly machinery, animated flow connections, reflective floor, bloom, and unrestricted azimuth orbit controls. The original overview layout, machinery legend, and canvas PNG export were also restored. These overview components do not import the theatre's presentation theme. Preparation readiness and cached scene playback fixes remain intact.

## Saved programs and repairs

The audit reads SQLite without modifying it. The verified snapshot contains **25 stage programs and 2 whole-algorithm programs**, spanning Transformer, DRAGIN, biological signaling, and hierarchical table retrieval. All 27 executable programs were visually inspected in the gallery and run in Chromium. One additional archived 1.0 data-format record is listed separately: the current API version lookup does not serve it to the code player. It is retained and is not counted as a playable program.

The audit found a hierarchy animation crash: THREE.Color.distanceTo does not exist. Two calls were replaced with RGB Euclidean distance using Math.hypot, preserving the comparison. The original full database row is backed up at backend/app/data/scene-repair-backups/hierarchical-index-before-color-distance.json. Reviewed code is in backend/tests/fixtures/hierarchical_index.js. No saved animations were deleted in this pass.

Earlier work rebuilt QFS and restyled Layer Normalization, with backups and fixtures for both. Those examples alone were insufficient evidence for a general presentation change; the checks below cover the full playable library.

## Verification

| Check | Current result |
|---|---|
| Frontend regression suite | 44 passed, including preparation readiness, cached playback, title escaping, matrix values, and signed network connections |
| Focused backend coder/validation regressions | 68 passed |
| Production build | Passed; existing large-bundle warning remains |
| Full saved-program audit | 27 programs × 2 widths × 33 sampled times = 1,782 frames |
| Times and viewports | Integer times 0–32 seconds; 900×650 and 390×650 browser viewports |
| Browser errors, intersecting or clipped label bounds, text below 12 px | Zero in all sampled frames |
| Theme and source values | Shared material treatment applied; authored material values restored in every sampled frame |
| Navigation | All programs reach horizontal and vertical scroll limits; header stays fixed |
| Restart resources | Geometry and texture counts unchanged after three additional restarts at the same phase |
| Synthetic label regression | Aspect, dynamic text, upright text, hidden state, separation, and resizing passed |

The application check uses cached API fixtures and blocks generation. It checks the restored DRAGIN and Transformer 3D overviews, orbit gestures, 2D switching, PNG export, opening the theatre, and returning to the overview. Results are in benchmarks/results/visuals/. Earlier screenshots of flat overview cards and zero-idle-draw measurements describe the reverted implementation and are not evidence about the restored 3D overview.

The complete scientific-theme gallery, including desktop, phone, and scrolled phone screenshots, is at benchmarks/results/library-scientific-final/index.html. Its audit.json records runtime, helper, and program SHA-256 hashes. The isolated primitive demonstration is at benchmarks/results/library-scientific-demo/ and is separate from the saved-paper audit.

## Measured layout optimization

The collision search now orders candidates by distance and stops at the nearest clear position. Previously it checked every candidate before sorting clear positions. The controlled browser comparison uses the same Feed-Forward Network, runtime, viewport, and animation phase, changing only this search. All label positions and scales are exactly equal between variants.

Historical comparison before the scientific-theme revision: three alternating rounds per variant, 20 warm-up and 100 measured iterations per round, Chromium with SwiftShader, 900×650 viewport. These timings do not measure the new geometry-avoidance and outline passes:

| Candidate search | Median layout time | p95 layout time | Samples |
|---|---:|---:|---:|
| Previous | 5.5 ms | 9.5 ms | 300 |
| Optimized | 4.6 ms | 7.3 ms | 300 |

This is **1.20× faster layout, or 16.4% less median layout time**, for this dense scene. It measures label layout, not full frame time, model generation, or a universal FPS improvement. Raw samples and placement comparisons are in benchmarks/results/label-layout-benchmark.json. Earlier preparation and request-deduplication measurements remain in VISUALIZATION_BENCHMARK.md.

## Reproduce

From frontend, set PLAYWRIGHT_MODULE if playwright-core is installed elsewhere, then run:

~~~powershell
pnpm test
pnpm build
node scripts/audit-scene-library.mjs scientific-final
node scripts/capture-scene-gallery.mjs scientific-final
node scripts/check-label-layout.mjs
node scripts/benchmark-label-layout.mjs
~~~

For the application check, serve the built frontend at http://127.0.0.1:5175, then run node scripts/check-visualization.mjs. VISUALIZATION_URL overrides that address. Run performance comparisons separately from builds and other browser tests to reduce CPU contention.

These local checks use pinned Three.js modules supplied from disk. They do not establish real-phone GPU performance, slow-network loading, participant comprehension, scientific correctness, or quality of arbitrary future generated programs. Repository-wide typechecking still has previously reported configuration/type issues; a build is not a clean typecheck. No live model generation or participant study was performed.


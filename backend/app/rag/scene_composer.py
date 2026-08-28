"""Compose per-paper mechanism animations as data rather than as code.

The walkthrough used to pick from a fixed library of hand-written scenes, so
every paper animated like the machine-learning papers those scenes were built
for: protein binding borrowed the elementwise-combine scene, cell
differentiation borrowed the matrix-transform scene. Renaming the primitives
did not help, because the geometry never changed.

Here the model instead describes *what moves and when* in a small declarative
vocabulary -- actors with a form, and a timeline of behaviours over them -- and
one generic interpreter in the frontend renders any such description. A new
paper produces a new composition without new code, and without executing
anything the model wrote.

The vocabulary is deliberately domain-neutral: `travel`, `bind`, `accumulate`
and `spread_along` describe a signalling cascade and a residual connection
equally well. Nothing here knows what a tensor is.
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Literal

from langsmith import traceable
from pydantic import BaseModel

# --- vocabulary -------------------------------------------------------------
#
# Kept small on purpose. Every entry has to be renderable as recognisable
# geometry with no domain knowledge, and the model has to be able to choose
# between entries without agonising. Expressiveness comes from *composition*
# (which actors, how many, in what order, with what timing), not from a long
# menu of special cases.

ActorForm = Literal[
    "particles",  # many discrete units: molecules, tokens, cells, samples
    "strand",     # a long flexible chain: RNA, DNA, a sequence, a polymer
    "array",      # an ordered list of numbers: an embedding, a score row, a profile
    "lattice",    # a regular 2-D grid: a matrix, a tissue sheet, a crystal
    "blob",       # an amorphous mass with no described internal structure
    "field",      # a continuous gradient: concentration, probability, force
    "vessel",     # a container or compartment with a boundary
    "beam",       # a directed flow: a signal, a projection, an applied force
    "marker",     # a small labelled indicator: a tag, a flag, a threshold
]

ActorTone = Literal[
    "primary",    # the thing the stage is fundamentally about
    "secondary",  # a supporting participant
    "signal",     # something that activates or carries information
    "inhibitor",  # something that suppresses or blocks
    "substrate",  # raw input consumed by the stage
    "product",    # what the stage yields
    "neutral",    # scaffolding, context, environment
]

BehaviorKind = Literal[
    "enter",         # appears or is produced
    "travel",        # moves from one place to another
    "bind",          # attaches onto another actor
    "correspond",    # unit i of one thing maps onto unit i of another
    "split",         # divides into parts
    "merge",         # combines into one
    "spread_along",  # propagates over another actor's extent
    "accumulate",    # builds up in place
    "deplete",       # diminishes or is consumed
    "oscillate",     # cycles back and forth
    "transform",     # changes form or identity in place
    "amplify",       # grows in number or intensity
    "threshold",     # only the part above a cutoff passes
    "scatter",       # disperses
    "exit",          # leaves or is removed
]

# Named stage positions instead of raw coordinates. The model reasons about
# arrangement ("upstream", "into the nucleus") far more reliably than about
# numbers, and the interpreter keeps the composition well-framed whatever it
# picks. "same" is the sentinel for behaviours that do not relocate anything.
Slot = Literal[
    "left", "center", "right",
    "upper", "lower",
    "front", "back",
    "offstage", "same",
]

ACTOR_FORM_HELP: Dict[str, str] = {
    "particles": "many discrete units (molecules, cells, tokens, samples)",
    "strand": "a long flexible chain (RNA, DNA, a sequence, a polymer)",
    "array": "an ordered list of numbers, drawn as bars (an embedding, a score "
             "row, a probability distribution, a measured profile)",
    "lattice": "a regular 2-D grid (a matrix, a tissue sheet, a crystal)",
    "blob": "an amorphous mass with no internal structure the paper describes "
            "(a cell body, a tissue region, a droplet)",
    "field": "a continuous gradient (concentration, probability, force)",
    "vessel": "a container or compartment with a boundary",
    "beam": "a directed flow (a signal, a projection, an applied force)",
    "marker": "a small labelled indicator (a tag, a flag, a threshold)",
}

# What `items` and `values` mean per form, so the model fills them with the
# paper's own units and numbers instead of leaving the geometry featureless.
ACTOR_FORM_DATA: Dict[str, str] = {
    "particles": "items = the name of each unit, in order; values = leave []",
    "strand": "items = names of positions along the chain; values = leave []",
    "array": "values = the numbers themselves, in order; items = the name of "
             "each slot",
    "lattice": "values = cell magnitudes, row-major; items = row or column "
               "names",
    "field": "values = the profile across the field, low to high; items = "
             "leave []",
    "blob": "leave items and values empty",
    "vessel": "leave items and values empty",
    "beam": "leave items and values empty",
    "marker": "items = the single thing it marks, or []",
}

BEHAVIOR_HELP: Dict[str, str] = {
    "enter": "appears or is produced",
    "travel": "moves from one place to another",
    "bind": "attaches onto another actor",
    "correspond": "each unit of one thing maps onto the matching unit of "
                  "another (token i becomes vector i, gene i drives protein i)",
    "split": "divides into parts",
    "merge": "combines into one",
    "spread_along": "propagates over another actor's extent",
    "accumulate": "builds up in place",
    "deplete": "diminishes or is consumed",
    "oscillate": "cycles back and forth",
    "transform": "changes form or identity in place",
    "amplify": "grows in number or intensity",
    "threshold": "only the part above a cutoff passes",
    "scatter": "disperses",
    "exit": "leaves or is removed",
}

MAX_ACTORS = 5
MAX_BEATS = 7
MAX_ACTOR_ITEMS = 6    # matches the process_steps items cap upstream
MAX_ACTOR_VALUES = 16  # matches the renderer's own per-actor unit cap
MAX_BEAT_WEIGHTS = 16

# Bumped when `SceneActor`/`SceneBeat` gain fields the renderer depends on.
# Stored expansions stamped with an older version regenerate exactly once per
# bump: the stamp records the composition *attempt*, not its outcome, so a
# stage whose composition keeps failing is not retried on every click.
# v2: actors carry `items`/`values`; beats carry `weights` and `correspond`.
# v3: the parametric scene-graph tier (`scene_graph` on the payload) exists.
# v4: the graph prompt forbids copying the worked example's arrangement and
#     the linter detects it; v3 rows are all example-parrots and regenerate.
SCENE_SCHEMA_VERSION = 4


# --- schema -----------------------------------------------------------------
#
# `with_structured_output(method="json_schema")` is OpenAI strict mode, which
# rejects `oneOf` and any field carrying a default. So these stay flat with
# every field required, and unused fields take sentinels ("" / 0.0) -- the same
# shape `ProcessStep` and `RawOp` already use.


class SceneActor(BaseModel):
    """One participant in the animation."""

    actor_id: str
    label: str
    form: ActorForm
    tone: ActorTone
    count: int          # how many units; 1 for singular forms
    at: Slot            # where it starts; "offstage" if it enters later
    note: str           # what it represents in the paper; "" if nothing to add
    items: List[str]    # short name of each unit, in order; [] when unnamed
    values: List[float] # magnitude of each unit, in order; [] when not numeric


class SceneBeat(BaseModel):
    """One thing that happens, over a slice of the timeline."""

    start: float        # 0..1 through the stage
    duration: float     # 0..1
    kind: BehaviorKind
    actor_id: str       # who acts
    target_id: str      # who it acts upon; "" when the behaviour is solitary
    to: Slot            # where it ends up; "same" when it does not relocate
    magnitude: float    # 0..1 strength, extent, or fraction affected
    caption: str        # what is happening, in the paper's own terms
    weights: List[float]  # per-pair strength for `correspond`; [] = uniform


class MechanismScene(BaseModel):
    """A complete animation for one stage of the diagram."""

    title: str
    summary: str
    actors: List[SceneActor]
    beats: List[SceneBeat]
    evidence: str    # grounding from the paper; "" when the paper is silent
    described: bool  # False -> render an admitted gap instead of inventing


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def normalize_scene(scene: MechanismScene) -> MechanismScene:
    """Make a model-authored scene safe to render.

    Drops beats that reference actors which do not exist, clamps timings into
    range, caps the cast, and guarantees the stage is never empty. Every repair
    is silent by design here -- the honesty guarantee lives in `described`,
    which the model sets and this never overrides.
    """
    actors = scene.actors[:MAX_ACTORS]
    known = {actor.actor_id for actor in actors}

    for actor in actors:
        actor.count = int(_clamp(float(actor.count), 1, 40))
        actor.items = [
            item.strip()[:24]
            for item in actor.items[:MAX_ACTOR_ITEMS]
            if isinstance(item, str) and item.strip()
        ]
        actor.values = [
            float(value)
            for value in actor.values[:MAX_ACTOR_VALUES]
            if isinstance(value, (int, float)) and math.isfinite(value)
        ]

    beats: List[SceneBeat] = []
    for beat in scene.beats:
        if beat.actor_id not in known:
            continue
        if beat.target_id and beat.target_id not in known:
            beat.target_id = ""
        # A correspondence with nothing to correspond to draws nothing;
        # dropping it keeps the timeline honest instead of leaving a beat
        # that silently no-ops.
        if beat.kind == "correspond" and not beat.target_id:
            continue
        beat.start = _clamp(beat.start, 0.0, 1.0)
        beat.duration = _clamp(beat.duration, 0.05, 1.0 - beat.start or 0.05)
        beat.magnitude = _clamp(beat.magnitude, 0.0, 1.0)
        # Clamped rather than rescaled: peak-normalizing a set of genuinely
        # weak weights would brighten them into a claim the paper never made.
        beat.weights = [
            _clamp(float(weight), 0.0, 1.0)
            for weight in beat.weights[:MAX_BEAT_WEIGHTS]
            if isinstance(weight, (int, float)) and math.isfinite(weight)
        ]
        beat.caption = beat.caption.strip()[:140]
        beats.append(beat)
        if len(beats) >= MAX_BEATS:
            break

    beats.sort(key=lambda b: b.start)

    # Repair degenerate timing rather than render it. Models routinely leave
    # the opening third empty and stack several beats at start=1.0, which
    # plays as a dead intro followed by an invisible pile-up in the final
    # frames. Shift a late-opening timeline forward, and give every beat a
    # start it can actually play from and a duration a viewer can see.
    if beats:
        earliest = min(beat.start for beat in beats)
        if earliest > 0.3:
            shift = earliest - 0.05
            for beat in beats:
                beat.start = max(0.0, beat.start - shift)
        for beat in beats:
            beat.start = min(beat.start, 0.85)
            beat.duration = _clamp(beat.duration, 0.15, max(0.15, 1.0 - beat.start))

    # An all-neutral cast renders as an all-grey picture that says nothing
    # about who does what. Only fires when the model ignored tones entirely;
    # any deliberate tone choice is left alone.
    if actors and all(actor.tone == "neutral" for actor in actors):
        cycle = ("primary", "secondary", "signal", "product", "substrate")
        for index, actor in enumerate(actors):
            actor.tone = cycle[index % len(cycle)]

    # A stage with no cast cannot be animated; say so rather than show a void.
    if not actors:
        scene.described = False

    scene.actors = actors
    scene.beats = beats
    return scene


def _vocabulary_block() -> str:
    forms = "\n".join(f"  - {name}: {help}" for name, help in ACTOR_FORM_HELP.items())
    data = "\n".join(f"  - {name}: {help}" for name, help in ACTOR_FORM_DATA.items())
    behaviors = "\n".join(f"  - {name}: {help}" for name, help in BEHAVIOR_HELP.items())
    slots = ", ".join(
        s for s in ("left", "center", "right", "upper", "lower", "front", "back", "offstage", "same")
    )
    return (
        f"FORMS (pick the one whose shape matches the real thing):\n{forms}\n\n"
        f"WHAT items AND values MEAN PER FORM:\n{data}\n\n"
        f"BEHAVIOURS:\n{behaviors}\n\n"
        f"LAYOUT (where each thing sits in the picture): {slots}\n"
    )


SCENE_RULES = f"""\
Describe what happens in this stage of the paper's method: which things are
involved, and what happens to each of them, in order.

Rules:
- At most {MAX_ACTORS} actors and {MAX_BEATS} beats. Fewer is better. One clear
  idea beats a busy picture.
- Choose each actor's form by the *shape of the real thing*, not by analogy.
  A chromosome is a `strand`. A cell population is `particles`. A concentration
  gradient is a `field`. An embedding, a score row, a probability distribution
  or a profile of measurements is an `array` -- an ordered list of numbers. A
  weight matrix, a tissue sheet or a pairwise table is a `lattice` -- something
  genuinely laid out in two dimensions. Never use `lattice` for a
  one-dimensional list, and never borrow either as a metaphor.
- `blob` is a last resort, not a default. If the paper names the thing's
  parts, gives it numbers, or says how many there are, it is not a blob -- it
  is `particles`, an `array`, a `lattice` or a `strand`.
- Fill `items` and `values` with the paper's own units and numbers per the
  table below. An actor whose data you know but do not include renders as a
  featureless shape.
- When one thing becomes another item by item -- tokens become vectors, genes
  become transcripts, candidates become scores -- emit a `correspond` beat
  with actor_id = the source and target_id = the result. This is what draws
  the connection between them; without it the reader sees two unrelated
  objects. Give both actors the same count, and start the beat between 0.25
  and 0.6 so the connection is visible for most of the walkthrough.
- Every label AND every caption must use the paper's own vocabulary and
  describe the paper's own objects. A caption says what happens to the thing
  ("each token is mapped to a vector by the embedding matrix"), never what
  happens in a picture. Never write "stage", "scene", "actor", "animation",
  "enters", "appears", or screen directions like "on the left".
- Place each actor at a DIFFERENT slot. Two actors may share a slot only when
  one is consumed by or becomes the other; anything else renders on top of
  each other and is unreadable.
- Give each distinct role a distinct tone. `neutral` is only for background
  scaffolding -- a picture where the main participants are all grey says
  nothing about who does what.
- Beats must not all start at 0. Stagger them so the process reads as a
  sequence, and let them overlap where the paper says things are simultaneous.
- `evidence` must paraphrase or quote the specific sentence of the paper that
  licenses this animation.
- Set described=true whenever the paper says anything concrete about what this
  stage does to its inputs: a formula, a procedure, an operation, a named
  technique, an ordering. You do NOT need a full derivation, and one clear
  sentence is enough. This is the normal case for a method paper.
- Set described=false ONLY when the paper never explains what happens here
  beyond naming it -- no operation, no formula, no procedure anywhere in the
  excerpts. Then leave actors and beats empty and say so in summary. An
  admitted gap is correct when it is real, but do not reach for it: refusing a
  stage the paper does explain is just as wrong as inventing one it does not.

{_vocabulary_block()}"""


MAX_DATA_BLOCK_STEPS = 6
MAX_DATA_BLOCK_CHARS = 1200


def _stage_data_block(
    process_steps: List[Dict[str, Any]] | None,
    worked_example: Dict[str, Any] | None,
) -> str:
    """The already-extracted units and numbers for this stage, quoted verbatim.

    The storyboard extraction upstream has usually pinned a worked example and
    concrete per-step values. Repeating them here keeps the composed scene on
    the same example (instead of a second invented one) and gives the model
    real numbers to put in `values` rather than none.
    """
    lines: List[str] = []

    example = worked_example or {}
    tokens = [
        str(token).strip()
        for token in (example.get("tokens") or [])
        if str(token).strip()
    ][:MAX_ACTOR_ITEMS]
    if tokens or example.get("input_text"):
        lines.append("The worked example carried through every stage:")
        if example.get("input_text"):
            lines.append(f"  input: {str(example['input_text'])[:120]}")
        if tokens:
            lines.append(f"  its units: {', '.join(tokens)}")
        if example.get("dimension"):
            lines.append(f"  main dimension: {str(example['dimension'])[:60]}")

    step_lines: List[str] = []
    for index, step in enumerate(process_steps or []):
        if len(step_lines) >= MAX_DATA_BLOCK_STEPS:
            break
        if not isinstance(step, dict):
            continue
        items = [str(item) for item in step.get("items") or [] if str(item).strip()]
        values = [
            value
            for value in step.get("values") or []
            if isinstance(value, (int, float)) and math.isfinite(value)
        ]
        if not items and not values:
            continue
        parts = [f'  {index + 1}. "{str(step.get("caption", "")).strip()[:100]}"']
        if items:
            parts.append(f"units: {', '.join(items)}")
        if values:
            parts.append(f"numbers: {', '.join(f'{v:.3g}' for v in values)}")
        step_lines.append("  ".join(parts))
    if step_lines:
        lines.append(
            "The storyboard captions shown beside your animation, in order:"
        )
        lines.extend(step_lines)

    if not lines:
        return ""
    block = (
        "CONCRETE DATA ALREADY EXTRACTED FOR THIS STAGE\n"
        "Use these exact units and these exact numbers -- do not invent "
        "different ones and do not round them off. Put the units in the "
        "`items` of whichever actor represents them and the numbers in that "
        "actor's `values`. Your captions are shown at the same time as the "
        "captions above, so they must agree with them and must not repeat "
        "them.\n" + "\n".join(lines)
    )
    return block[:MAX_DATA_BLOCK_CHARS]


def _seed_items_from_example(
    scene: MechanismScene, worked_example: Dict[str, Any] | None
) -> MechanismScene:
    """Fill unit names the model left blank, when the match is unambiguous.

    Only `items` are ever seeded, never `values`: a wrong label is cosmetic,
    but a wrong number on screen is a false claim about the paper. And only
    when exactly one actor could be the example's units -- two candidates
    means we cannot tell the input from the output, so both stay blank.
    """
    tokens = [
        str(token).strip()
        for token in (worked_example or {}).get("tokens") or []
        if str(token).strip()
    ][:MAX_ACTOR_ITEMS]
    if not tokens:
        return scene
    candidates = [
        actor
        for actor in scene.actors
        if not actor.items
        and actor.form in ("particles", "strand", "array")
        and actor.count == len(tokens)
    ]
    if len(candidates) == 1:
        candidates[0].items = [token[:24] for token in tokens]
    return scene


@traceable(name="compose_mechanism_scene", run_type="chain")
def compose_mechanism_scene(
    stage_label: str,
    stage_detail: str,
    algorithm_name: str,
    domain: str,
    context: str,
    process_steps: List[Dict[str, Any]] | None = None,
    worked_example: Dict[str, Any] | None = None,
    llm: Any = None,
) -> MechanismScene:
    """Ask the model to choreograph one stage, then make it safe to render.

    `process_steps` and `worked_example` are plain dicts (the caller's
    post-clamp payload), not pydantic models, so this module keeps no
    import-time dependency on its caller.
    """
    from .paper_visualizer import _structured_llm_call, get_llm

    llm = llm or get_llm()
    data_block = _stage_data_block(process_steps, worked_example)
    prompt = (
        f"{SCENE_RULES}\n"
        f"PAPER: {algorithm_name}\n"
        f"FIELD: {domain}\n"
        f"STAGE: {stage_label}\n"
        f"WHAT THE STAGE DOES: {stage_detail or '(not stated)'}\n\n"
        + (f"{data_block}\n\n" if data_block else "")
        + f"PAPER EXCERPTS:\n{context}\n"
    )
    scene = _structured_llm_call(llm, prompt, MechanismScene)
    return _seed_items_from_example(normalize_scene(scene), worked_example)


def scene_to_dict(scene: MechanismScene) -> Dict[str, Any]:
    payload = json.loads(scene.model_dump_json())
    # Stamped inside the stored dict as well as on the expansion payload, so
    # "how many stored scenes are old-shape?" is answerable with one query.
    payload["scene_schema_version"] = SCENE_SCHEMA_VERSION
    return payload

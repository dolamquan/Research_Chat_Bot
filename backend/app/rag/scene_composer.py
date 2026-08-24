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
    "lattice",    # a regular grid: a matrix, a tissue sheet, a crystal
    "blob",       # an amorphous mass: a cell, a cluster, a region
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
    "lattice": "a regular grid (a matrix, a tissue sheet, a crystal)",
    "blob": "an amorphous mass (a cell, a cluster, a region)",
    "field": "a continuous gradient (concentration, probability, force)",
    "vessel": "a container or compartment with a boundary",
    "beam": "a directed flow (a signal, a projection, an applied force)",
    "marker": "a small labelled indicator (a tag, a flag, a threshold)",
}

BEHAVIOR_HELP: Dict[str, str] = {
    "enter": "appears or is produced",
    "travel": "moves from one place to another",
    "bind": "attaches onto another actor",
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


# --- schema -----------------------------------------------------------------
#
# `with_structured_output(method="json_schema")` is OpenAI strict mode, which
# rejects `oneOf` and any field carrying a default. So these stay flat with
# every field required, and unused fields take sentinels ("" / 0.0) -- the same
# shape `ProcessStep` and `RawOp` already use.


class SceneActor(BaseModel):
    """One thing on stage."""

    actor_id: str
    label: str
    form: ActorForm
    tone: ActorTone
    count: int      # how many units; 1 for singular forms
    at: Slot        # where it starts; "offstage" if it enters later
    note: str       # what it represents in the paper; "" if nothing to add


class SceneBeat(BaseModel):
    """One thing that happens, over a slice of the stage's timeline."""

    start: float        # 0..1 through the stage
    duration: float     # 0..1
    kind: BehaviorKind
    actor_id: str       # who acts
    target_id: str      # who it acts upon; "" when the behaviour is solitary
    to: Slot            # where it ends up; "same" when it does not relocate
    magnitude: float    # 0..1 strength, extent, or fraction affected
    caption: str        # what is happening, in the paper's own terms


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

    beats: List[SceneBeat] = []
    for beat in scene.beats:
        if beat.actor_id not in known:
            continue
        if beat.target_id and beat.target_id not in known:
            beat.target_id = ""
        beat.start = _clamp(beat.start, 0.0, 1.0)
        beat.duration = _clamp(beat.duration, 0.05, 1.0 - beat.start or 0.05)
        beat.magnitude = _clamp(beat.magnitude, 0.0, 1.0)
        beats.append(beat)
        if len(beats) >= MAX_BEATS:
            break

    beats.sort(key=lambda b: b.start)

    # A stage with no cast cannot be animated; say so rather than show a void.
    if not actors:
        scene.described = False

    scene.actors = actors
    scene.beats = beats
    return scene


def _vocabulary_block() -> str:
    forms = "\n".join(f"  - {name}: {help}" for name, help in ACTOR_FORM_HELP.items())
    behaviors = "\n".join(f"  - {name}: {help}" for name, help in BEHAVIOR_HELP.items())
    slots = ", ".join(
        s for s in ("left", "center", "right", "upper", "lower", "front", "back", "offstage", "same")
    )
    return (
        f"ACTOR FORMS (pick the one whose shape matches the real thing):\n{forms}\n\n"
        f"BEHAVIOURS:\n{behaviors}\n\n"
        f"SLOTS (positions on stage): {slots}\n"
    )


SCENE_RULES = f"""\
Describe this stage as a short animation: who is on stage, and what happens.

Rules:
- At most {MAX_ACTORS} actors and {MAX_BEATS} beats. Fewer is better. One clear
  idea beats a busy stage.
- Choose the actor form by the *physical shape of the real thing*, not by
  analogy to computing. A chromosome is a strand. A cell population is
  particles. A concentration gradient is a field. Do not reach for `lattice`
  unless the paper's object really is a grid or an array.
- Every label must use the paper's own vocabulary.
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


@traceable(name="compose_mechanism_scene", run_type="chain")
def compose_mechanism_scene(
    stage_label: str,
    stage_detail: str,
    algorithm_name: str,
    domain: str,
    context: str,
    llm: Any = None,
) -> MechanismScene:
    """Ask the model to choreograph one stage, then make it safe to render."""
    from .paper_visualizer import _structured_llm_call, get_llm

    llm = llm or get_llm()
    prompt = (
        f"{SCENE_RULES}\n"
        f"PAPER: {algorithm_name}\n"
        f"FIELD: {domain}\n"
        f"STAGE: {stage_label}\n"
        f"WHAT THE STAGE DOES: {stage_detail or '(not stated)'}\n\n"
        f"PAPER EXCERPTS:\n{context}\n"
    )
    scene = _structured_llm_call(llm, prompt, MechanismScene)
    return normalize_scene(scene)


def scene_to_dict(scene: MechanismScene) -> Dict[str, Any]:
    return json.loads(scene.model_dump_json())

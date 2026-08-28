"""The Scene IR: a versioned, validated description of an algorithm animation.

This is the contract between the language model and the renderer, and its
central property is that it carries **no executable content**. Every field is
either an enum drawn from a closed whitelist, an identifier that must resolve
inside the same document, a number inside a checked range, or display text. The
frontend maps `primitive` through a fixed registry of React components; a
primitive outside the whitelist is rejected here and, if it somehow arrived
anyway, renders a placeholder rather than crashing.

That constraint is the whole design. An earlier iteration of this feature had
the model emit three.js source which ran in a sandboxed frame; it was isolated,
but the output could not be verified against the paper and could fail at
runtime in ways no schema could catch. Emitting data instead means malformed
output is a validation error at generation time rather than a broken animation
in front of the user.

Evidence is first-class for the same reason. Entities and steps carry
`evidence_ids` pointing at quotes from the paper, so anything on screen can be
traced to a sentence, and anything that cannot is visibly marked uncertain
rather than quietly presented as fact.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

SCHEMA_VERSION = "1.0"

# The complete set of things the renderer knows how to draw. Adding one here
# without adding the matching component in `primitives/` leaves a gap that the
# compiler renders as a fallback, so the two lists are kept in step and a test
# asserts they match.
ProcessPrimitive = Literal[
    "token_stream",
    "vector_array",
    "matrix_transform",
    "attention_links",
    "split_parallel",
    "merge_parallel",
    "elementwise_combine",
    "nonlinearity",
    "normalize",
    "distribution",
    "filter_select",
    "compare",
    "loop_repeat",
    "data_transfer",
    "state_transition",
    "note",
]

SUPPORTED_PRIMITIVES: tuple[str, ...] = (
    "token_stream",
    "vector_array",
    "matrix_transform",
    "attention_links",
    "split_parallel",
    "merge_parallel",
    "elementwise_combine",
    "nonlinearity",
    "normalize",
    "distribution",
    "filter_select",
    "compare",
    "loop_repeat",
    "data_transfer",
    "state_transition",
    "note",
)

# Mapping from the vocabulary already stored in `node_expansions.process_steps`
# to the Scene IR primitives, so scenes can be derived from records written
# before this module existed. Anything without a faithful counterpart becomes
# `note`, which states the caption without implying a mechanism.
LEGACY_PRIMITIVE_ALIASES: Dict[str, str] = {
    # domain-neutral core vocabulary
    "transport": "data_transfer",
    "transform": "matrix_transform",
    "combine": "elementwise_combine",
    "split": "split_parallel",
    "gate": "nonlinearity",
    "amplify": "distribution",
    "suppress": "nonlinearity",
    "accumulate": "distribution",
    "cycle": "loop_repeat",
    "compare": "compare",
    "select": "filter_select",
    "emit": "data_transfer",
    # biological extensions
    "bind": "elementwise_combine",
    "upregulate": "distribution",
    "downregulate": "distribution",
    "cascade": "data_transfer",
    "differentiate": "state_transition",
    "translocate": "data_transfer",
    "population_shift": "distribution",
    # explicit gap
    "not_described": "note",
}

# Budgets. These bound both prompt size and render cost, and they make
# "excessive complexity" a deterministic check rather than a judgement call.
MAX_ENTITIES = 40
MAX_STEPS = 40
MAX_EVIDENCE = 80
MIN_STEP_DURATION_MS = 200
MAX_STEP_DURATION_MS = 20_000
MAX_TRANSITION_MS = 10_000


class SceneIRError(ValueError):
    """A scene failed structural validation and must not be persisted."""


class EvidenceRef(BaseModel):
    """A quote from the paper that licenses part of the scene."""

    evidence_id: str
    chunk_id: str | None = None
    section: str = ""
    page: int | None = None
    quote: str = ""
    confidence: float = 0.5

    @field_validator("confidence")
    @classmethod
    def _confidence_in_range(cls, value: float) -> float:
        if not 0.0 <= value <= 1.0:
            raise ValueError(f"confidence must be within 0..1, got {value}")
        return value


class SceneEntity(BaseModel):
    """A named participant: a tensor, a module, a document set, a population."""

    id: str
    label: str
    kind: str = "component"
    semantic_role: str = ""
    group: str | None = None
    evidence_ids: List[str] = Field(default_factory=list)


class SceneStep(BaseModel):
    """One animated beat, rendered by exactly one whitelisted primitive."""

    id: str
    node_id: str | None = None
    primitive: ProcessPrimitive
    caption: str = ""
    detail: str = ""
    items: List[str] = Field(default_factory=list)
    values: List[float] = Field(default_factory=list)
    count: int = 0
    label_in: str = ""
    label_out: str = ""
    input_ids: List[str] = Field(default_factory=list)
    output_ids: List[str] = Field(default_factory=list)
    execution: Literal["sequential", "parallel", "loop"] = "sequential"
    duration_ms: int = 1200
    evidence_ids: List[str] = Field(default_factory=list)
    confidence: float = 0.5

    @field_validator("confidence")
    @classmethod
    def _confidence_in_range(cls, value: float) -> float:
        if not 0.0 <= value <= 1.0:
            raise ValueError(f"confidence must be within 0..1, got {value}")
        return value

    @field_validator("duration_ms")
    @classmethod
    def _duration_in_range(cls, value: int) -> int:
        if not MIN_STEP_DURATION_MS <= value <= MAX_STEP_DURATION_MS:
            raise ValueError(
                f"duration_ms must be within "
                f"{MIN_STEP_DURATION_MS}..{MAX_STEP_DURATION_MS}, got {value}"
            )
        return value

    @field_validator("count")
    @classmethod
    def _count_sane(cls, value: int) -> int:
        if value < 0:
            raise ValueError("count cannot be negative")
        return min(value, 512)


class CameraCue(BaseModel):
    """Where the camera should be while a step plays."""

    step_id: str
    focus_entity_ids: List[str] = Field(default_factory=list)
    framing: Literal["overview", "group", "detail"] = "overview"
    transition_ms: int = 800

    @field_validator("transition_ms")
    @classmethod
    def _transition_in_range(cls, value: int) -> int:
        if not 0 <= value <= MAX_TRANSITION_MS:
            raise ValueError(
                f"transition_ms must be within 0..{MAX_TRANSITION_MS}, got {value}"
            )
        return value


class AlgorithmScene(BaseModel):
    """A complete, self-consistent animation of one paper's method."""

    schema_version: Literal["1.0"] = SCHEMA_VERSION
    title: str = ""
    algorithm_name: str = ""
    visualization_mode: Literal["2d", "2_5d", "3d"] = "2d"
    summary: str = ""
    entities: List[SceneEntity] = Field(default_factory=list)
    evidence: List[EvidenceRef] = Field(default_factory=list)
    steps: List[SceneStep] = Field(default_factory=list)
    camera_cues: List[CameraCue] = Field(default_factory=list)

    # --- structural integrity ------------------------------------------------
    #
    # These run at construction, so an invalid scene cannot exist as an object,
    # let alone be persisted. `scene_verifier` layers softer, advisory findings
    # on top; anything that would make the scene unrenderable belongs here.

    @model_validator(mode="after")
    def _check_structure(self) -> "AlgorithmScene":
        if len(self.entities) > MAX_ENTITIES:
            raise ValueError(
                f"scene has {len(self.entities)} entities, over the "
                f"{MAX_ENTITIES} limit"
            )
        if len(self.steps) > MAX_STEPS:
            raise ValueError(
                f"scene has {len(self.steps)} steps, over the {MAX_STEPS} limit"
            )
        if len(self.evidence) > MAX_EVIDENCE:
            raise ValueError(
                f"scene has {len(self.evidence)} evidence refs, over the "
                f"{MAX_EVIDENCE} limit"
            )

        entity_ids = [entity.id for entity in self.entities]
        _reject_duplicates(entity_ids, "entity")

        step_ids = [step.id for step in self.steps]
        _reject_duplicates(step_ids, "step")

        evidence_ids = [ref.evidence_id for ref in self.evidence]
        _reject_duplicates(evidence_ids, "evidence")

        known_entities = set(entity_ids)
        known_steps = set(step_ids)
        known_evidence = set(evidence_ids)

        for entity in self.entities:
            _reject_dangling(
                entity.evidence_ids, known_evidence,
                f"entity {entity.id!r}", "evidence",
            )

        for step in self.steps:
            _reject_dangling(
                step.input_ids, known_entities, f"step {step.id!r}", "input entity"
            )
            _reject_dangling(
                step.output_ids, known_entities, f"step {step.id!r}", "output entity"
            )
            _reject_dangling(
                step.evidence_ids, known_evidence, f"step {step.id!r}", "evidence"
            )

        for cue in self.camera_cues:
            if cue.step_id not in known_steps:
                raise ValueError(
                    f"camera cue references unknown step {cue.step_id!r}"
                )
            _reject_dangling(
                cue.focus_entity_ids, known_entities,
                f"camera cue for {cue.step_id!r}", "focus entity",
            )

        return self

    # --- convenience ---------------------------------------------------------

    def entity_by_id(self, entity_id: str) -> SceneEntity | None:
        return next((e for e in self.entities if e.id == entity_id), None)

    def evidence_by_id(self, evidence_id: str) -> EvidenceRef | None:
        return next((e for e in self.evidence if e.evidence_id == evidence_id), None)

    def total_duration_ms(self) -> int:
        return sum(step.duration_ms for step in self.steps)


def _reject_duplicates(values: List[str], label: str) -> None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise ValueError(f"duplicate {label} id {value!r}")
        seen.add(value)


def _reject_dangling(
    referenced: List[str], known: set[str], owner: str, label: str
) -> None:
    for value in referenced:
        if value not in known:
            raise ValueError(f"{owner} references unknown {label} {value!r}")


def parse_scene(payload: Dict[str, Any]) -> AlgorithmScene:
    """Validate an untrusted mapping into a scene, or raise `SceneIRError`.

    Callers get one exception type regardless of whether pydantic rejected a
    field or a structural rule rejected the document.
    """
    try:
        return AlgorithmScene.model_validate(payload)
    except Exception as error:  # pydantic ValidationError or ValueError
        raise SceneIRError(str(error)) from error


def scene_to_dict(scene: AlgorithmScene) -> Dict[str, Any]:
    return scene.model_dump(mode="json")


def normalize_primitive(primitive: str) -> str:
    """Map a legacy or unknown primitive onto a supported one.

    Used when deriving a scene from `process_steps` written before this schema
    existed. An unrecognised value becomes `note`, which shows the caption
    without asserting a mechanism the renderer would be inventing.
    """
    if primitive in SUPPORTED_PRIMITIVES:
        return primitive
    return LEGACY_PRIMITIVE_ALIASES.get(primitive, "note")

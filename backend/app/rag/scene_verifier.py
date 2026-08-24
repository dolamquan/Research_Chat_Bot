"""Deterministic checks on a generated scene.

Everything here is computable from the scene itself: reachability, ordering,
grounding ratios, complexity. No model is consulted, because none is needed --
"this step consumes an entity nothing has produced yet" is a graph fact, and
asking a model to judge it would only add cost and variance.

`AlgorithmScene` already refuses to construct when a scene is structurally
impossible (duplicate ids, dangling references). This module is the softer
layer above that: it runs on a scene that *parsed*, and reports what is wrong
with it as findings the UI can display next to the animation. Severity
separates "this cannot be trusted" from "this is worth knowing".
"""

from __future__ import annotations

from typing import Dict, List, Literal, Set

from pydantic import BaseModel, Field

from app.rag.scene_ir import (
    MAX_ENTITIES,
    MAX_STEPS,
    SUPPORTED_PRIMITIVES,
    AlgorithmScene,
)

Severity = Literal["error", "warning", "info"]

# Below this share of grounded steps a scene is reporting more than the paper
# supports, and the UI should say so rather than present it as established.
LOW_GROUNDING_RATIO = 0.6
# A step claiming near-certainty while citing nothing is the specific failure
# this check exists to catch.
UNSUPPORTED_CONFIDENCE = 0.8


class SceneFinding(BaseModel):
    code: str
    severity: Severity
    message: str
    entity_ids: List[str] = Field(default_factory=list)
    step_ids: List[str] = Field(default_factory=list)
    evidence_ids: List[str] = Field(default_factory=list)


class SceneVerificationReport(BaseModel):
    valid: bool
    findings: List[SceneFinding] = Field(default_factory=list)
    entity_count: int = 0
    step_count: int = 0
    grounded_entity_ratio: float = 0.0
    grounded_step_ratio: float = 0.0

    def errors(self) -> List[SceneFinding]:
        return [f for f in self.findings if f.severity == "error"]

    def warnings(self) -> List[SceneFinding]:
        return [f for f in self.findings if f.severity == "warning"]


def _ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def verify_scene(scene: AlgorithmScene) -> SceneVerificationReport:
    """Run every deterministic check and summarise the result."""
    findings: List[SceneFinding] = []

    findings.extend(_check_empty(scene))
    findings.extend(_check_primitives(scene))
    findings.extend(_check_grounding(scene))
    findings.extend(_check_dataflow(scene))
    findings.extend(_check_connectivity(scene))
    findings.extend(_check_loops(scene))
    findings.extend(_check_complexity(scene))
    findings.extend(_check_confidence(scene))
    findings.extend(_check_illustrative_values(scene))

    grounded_entities = sum(1 for e in scene.entities if e.evidence_ids)
    grounded_steps = sum(1 for s in scene.steps if s.evidence_ids)

    return SceneVerificationReport(
        valid=not any(f.severity == "error" for f in findings),
        findings=findings,
        entity_count=len(scene.entities),
        step_count=len(scene.steps),
        grounded_entity_ratio=_ratio(grounded_entities, len(scene.entities)),
        grounded_step_ratio=_ratio(grounded_steps, len(scene.steps)),
    )


def _check_empty(scene: AlgorithmScene) -> List[SceneFinding]:
    findings: List[SceneFinding] = []
    if not scene.steps:
        findings.append(
            SceneFinding(
                code="empty_scene",
                severity="error",
                message="The scene has no steps, so there is nothing to animate.",
            )
        )
    if not scene.entities:
        findings.append(
            SceneFinding(
                code="no_entities",
                severity="error",
                message="The scene has no entities, so no step can reference data.",
            )
        )
    return findings


def _check_primitives(scene: AlgorithmScene) -> List[SceneFinding]:
    # Unreachable while the model validator holds, but kept because a scene can
    # also arrive from storage written by an older schema version.
    unsupported = [s for s in scene.steps if s.primitive not in SUPPORTED_PRIMITIVES]
    if not unsupported:
        return []
    return [
        SceneFinding(
            code="unsupported_primitive",
            severity="error",
            message=(
                "Steps use primitives the renderer does not implement: "
                + ", ".join(sorted({s.primitive for s in unsupported}))
            ),
            step_ids=[s.id for s in unsupported],
        )
    ]


def _check_grounding(scene: AlgorithmScene) -> List[SceneFinding]:
    findings: List[SceneFinding] = []

    ungrounded_steps = [s.id for s in scene.steps if not s.evidence_ids]
    if ungrounded_steps:
        findings.append(
            SceneFinding(
                code="ungrounded_steps",
                severity="warning",
                message=(
                    f"{len(ungrounded_steps)} step(s) cite no evidence and are "
                    "shown as uncertain."
                ),
                step_ids=ungrounded_steps,
            )
        )

    ungrounded_entities = [e.id for e in scene.entities if not e.evidence_ids]
    if ungrounded_entities:
        findings.append(
            SceneFinding(
                code="ungrounded_entities",
                severity="warning",
                message=(
                    f"{len(ungrounded_entities)} entit(y/ies) cite no evidence and "
                    "are shown as uncertain."
                ),
                entity_ids=ungrounded_entities,
            )
        )

    if scene.steps:
        ratio = _ratio(len(scene.steps) - len(ungrounded_steps), len(scene.steps))
        if ratio < LOW_GROUNDING_RATIO:
            findings.append(
                SceneFinding(
                    code="low_grounding",
                    severity="error",
                    message=(
                        f"Only {ratio:.0%} of steps are grounded in the paper, "
                        f"below the {LOW_GROUNDING_RATIO:.0%} threshold."
                    ),
                )
            )

    empty_quotes = [
        ref.evidence_id for ref in scene.evidence if not (ref.quote or "").strip()
    ]
    if empty_quotes:
        findings.append(
            SceneFinding(
                code="empty_evidence_quote",
                severity="warning",
                message=f"{len(empty_quotes)} evidence reference(s) carry no quote.",
                evidence_ids=empty_quotes,
            )
        )

    unused = {ref.evidence_id for ref in scene.evidence}
    for entity in scene.entities:
        unused -= set(entity.evidence_ids)
    for step in scene.steps:
        unused -= set(step.evidence_ids)
    if unused:
        findings.append(
            SceneFinding(
                code="unused_evidence",
                severity="info",
                message=f"{len(unused)} evidence reference(s) are never cited.",
                evidence_ids=sorted(unused),
            )
        )

    return findings


def _check_dataflow(scene: AlgorithmScene) -> List[SceneFinding]:
    """Entities must be produced before they are consumed.

    Steps play in list order, so an input first seen at step 5 but only
    produced at step 8 would animate data appearing from nowhere. Entities
    never produced by any step are treated as scene inputs, which is legitimate.
    """
    findings: List[SceneFinding] = []

    produced_anywhere: Set[str] = set()
    for step in scene.steps:
        produced_anywhere.update(step.output_ids)

    available: Set[str] = {
        entity.id for entity in scene.entities if entity.id not in produced_anywhere
    }

    premature: List[str] = []
    for step in scene.steps:
        missing = [eid for eid in step.input_ids if eid not in available]
        if missing:
            premature.append(step.id)
        available.update(step.output_ids)

    if premature:
        findings.append(
            SceneFinding(
                code="input_before_creation",
                severity="error",
                message=(
                    f"{len(premature)} step(s) consume an entity before any earlier "
                    "step produces it."
                ),
                step_ids=premature,
            )
        )

    consumed: Set[str] = set()
    for step in scene.steps:
        consumed.update(step.input_ids)
    dead_outputs = sorted(produced_anywhere - consumed)
    # The final step's outputs are the scene's result, so they are expected to
    # go unconsumed and are not reported.
    if scene.steps:
        dead_outputs = [
            eid for eid in dead_outputs if eid not in set(scene.steps[-1].output_ids)
        ]
    if dead_outputs:
        findings.append(
            SceneFinding(
                code="unused_output",
                severity="info",
                message=(
                    f"{len(dead_outputs)} produced entit(y/ies) are never used by a "
                    "later step."
                ),
                entity_ids=dead_outputs,
            )
        )

    return findings


def _check_connectivity(scene: AlgorithmScene) -> List[SceneFinding]:
    referenced: Set[str] = set()
    for step in scene.steps:
        referenced.update(step.input_ids)
        referenced.update(step.output_ids)
    orphans = sorted(e.id for e in scene.entities if e.id not in referenced)
    if not orphans:
        return []
    return [
        SceneFinding(
            code="disconnected_entity",
            severity="warning",
            message=(
                f"{len(orphans)} entit(y/ies) take part in no step and will not "
                "appear in the animation."
            ),
            entity_ids=orphans,
        )
    ]


def _check_loops(scene: AlgorithmScene) -> List[SceneFinding]:
    """A loop step must actually be able to repeat something."""
    findings: List[SceneFinding] = []
    for step in scene.steps:
        if step.execution != "loop" and step.primitive != "loop_repeat":
            continue
        if not step.input_ids and not step.output_ids:
            findings.append(
                SceneFinding(
                    code="impossible_loop",
                    severity="error",
                    message=(
                        f"Step {step.id!r} is a loop but neither consumes nor "
                        "produces anything, so it cannot iterate."
                    ),
                    step_ids=[step.id],
                )
            )
        elif step.count <= 1 and step.primitive == "loop_repeat":
            findings.append(
                SceneFinding(
                    code="degenerate_loop",
                    severity="info",
                    message=(
                        f"Step {step.id!r} repeats {step.count} time(s), which reads "
                        "the same as a single pass."
                    ),
                    step_ids=[step.id],
                )
            )
    return findings


def _check_complexity(scene: AlgorithmScene) -> List[SceneFinding]:
    findings: List[SceneFinding] = []
    if len(scene.entities) > MAX_ENTITIES * 0.75:
        findings.append(
            SceneFinding(
                code="high_entity_count",
                severity="info",
                message=(
                    f"{len(scene.entities)} entities may be hard to read at once."
                ),
            )
        )
    if len(scene.steps) > MAX_STEPS * 0.75:
        findings.append(
            SceneFinding(
                code="high_step_count",
                severity="info",
                message=f"{len(scene.steps)} steps make for a long walkthrough.",
            )
        )
    return findings


def _check_confidence(scene: AlgorithmScene) -> List[SceneFinding]:
    """High confidence without a citation is the claim this catches."""
    overconfident = [
        s.id
        for s in scene.steps
        if s.confidence >= UNSUPPORTED_CONFIDENCE and not s.evidence_ids
    ]
    if not overconfident:
        return []
    return [
        SceneFinding(
            code="unsupported_confidence",
            severity="warning",
            message=(
                f"{len(overconfident)} step(s) claim confidence "
                f">= {UNSUPPORTED_CONFIDENCE} while citing no evidence."
            ),
            step_ids=overconfident,
        )
    ]


def _check_illustrative_values(scene: AlgorithmScene) -> List[SceneFinding]:
    """Distinguish numbers taken from the paper from numbers made up to show.

    A worked example is useful and expected, but it has to be legible as an
    example. A step carrying concrete values while citing nothing is presenting
    invented numbers with the same authority as reported ones.
    """
    illustrative = [
        s.id
        for s in scene.steps
        if (s.values or s.items) and not s.evidence_ids
    ]
    if not illustrative:
        return []
    return [
        SceneFinding(
            code="illustrative_values",
            severity="info",
            message=(
                f"{len(illustrative)} step(s) show concrete values without citing "
                "the paper; these are illustrative, not reported results."
            ),
            step_ids=illustrative,
        )
    ]


def report_to_dict(report: SceneVerificationReport) -> Dict:
    return report.model_dump(mode="json")

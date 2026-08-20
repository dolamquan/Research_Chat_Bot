"""Verify a modified algorithm.

This module is deliberately honest about what it can know. Nothing here claims
a research idea is *correct* — that is not decidable. Every finding carries a
`basis` saying how it was reached, and the verdict is computed in Python from
severity counts, never asserted by a model.

Layer 0 (this file, today) is fully deterministic: it proves things about the
graph. Layers 1-3 (invariants, critic panel, prior art) are model judgment and
external evidence, and are added in later phases.
"""

from collections import defaultdict
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel

from app.rag.diagram_mutator import RepairNote, edge_key
from app.rag.paper_visualizer import DiagramIR, IREdge, _break_cycles


Severity = Literal["blocking", "major", "minor", "speculative"]
Basis = Literal["deterministic", "model_judgment", "external_evidence"]
Verdict = Literal["structurally_sound", "concerns", "likely_broken"]

Category = Literal[
    "structure",
    "reachability",
    "correctness",
    "complexity",
    "optimization",
    "paper_contradiction",
    "invariant_violation",
    "prior_art",
]

SEVERITY_RANK = {"blocking": 0, "major": 1, "minor": 2, "speculative": 3}
BASIS_RANK = {"deterministic": 0, "external_evidence": 1, "model_judgment": 2}
CONFIDENCE_RANK = {"high": 0, "medium": 1, "low": 2}

# Back edges of these kinds are how the paper's own structure expresses
# recurrence, so they are not defects.
LEGITIMATE_BACK_KINDS = {"feedback", "residual"}


class Finding(BaseModel):
    finding_id: str
    layer: Literal["L0", "L1", "L2", "L3"]
    basis: Basis
    category: Category
    severity: Severity
    confidence: Literal["low", "medium", "high"]
    title: str
    failure_scenario: str
    node_ids: List[str]
    edge_keys: List[str]
    invariant_id: Optional[str] = None
    critic: Optional[str] = None
    evidence: Optional[str] = None
    suggested_probe: Optional[str] = None
    # True when the parent diagram already had this problem, so the
    # modification did not cause it. Excluded from the verdict.
    inherited: bool = False


class LayerStatus(BaseModel):
    layer: str
    status: Literal["ok", "skipped", "unavailable", "failed"]
    detail: str
    seconds: float
    llm_calls: int


class VerificationReport(BaseModel):
    target_id: str
    target_kind: Literal["variant", "visualization"]
    verdict: Verdict
    headline: str
    findings: List[Finding]
    structural_delta: Dict[str, Any]
    layers: List[LayerStatus]
    model: str
    total_seconds: float


# ------------------------------------------------------------------ helpers

def _finding(
    code: str,
    *,
    severity: Severity,
    category: Category,
    title: str,
    failure_scenario: str,
    node_ids: List[str] | None = None,
    edge_keys: List[str] | None = None,
    suggested_probe: str | None = None,
) -> Finding:
    return Finding(
        finding_id=code,
        layer="L0",
        basis="deterministic",
        category=category,
        severity=severity,
        # A structural check is certain by construction.
        confidence="high",
        title=title,
        failure_scenario=failure_scenario,
        node_ids=sorted(node_ids or []),
        edge_keys=sorted(edge_keys or []),
        suggested_probe=suggested_probe,
    )


def _adjacency(
    ir: DiagramIR, skip_kinds: set[str] | None = None
) -> Tuple[Dict[str, List[str]], Dict[str, List[str]]]:
    forward: Dict[str, List[str]] = defaultdict(list)
    backward: Dict[str, List[str]] = defaultdict(list)
    for edge in ir.edges:
        if skip_kinds and edge.kind in skip_kinds:
            continue
        forward[edge.source].append(edge.target)
        backward[edge.target].append(edge.source)
    return forward, backward


def _reachable(seeds: List[str], adjacency: Dict[str, List[str]]) -> set[str]:
    seen = set(seeds)
    queue = list(seeds)
    while queue:
        current = queue.pop()
        for neighbour in adjacency.get(current, ()):
            if neighbour not in seen:
                seen.add(neighbour)
                queue.append(neighbour)
    return seen


def _cycle_members(ir: DiagramIR, back_edge: IREdge) -> List[str]:
    """Nodes on the loop the back edge closes."""
    forward, _ = _adjacency(ir)
    reachable_from_target = _reachable([back_edge.target], forward)
    _, backward = _adjacency(ir)
    reaches_source = _reachable([back_edge.source], backward)
    return sorted(reachable_from_target & reaches_source)


# ------------------------------------------------------------------- L0

def structural_findings(
    ir: DiagramIR, layout: Dict[str, Any], repairs: List[RepairNote] | None = None
) -> List[Finding]:
    """Deterministic checks over the graph. Reuses layout's layer/back output."""
    findings: List[Finding] = []
    node_ids = [node.id for node in ir.nodes]
    node_by_id = {node.id: node for node in ir.nodes}
    layer_of = {node["id"]: node["layer"] for node in layout.get("nodes", [])}

    # Repairs that normalization performed on its own.
    for repair in repairs or []:
        findings.append(
            _finding(
                repair.code,
                severity="major" if repair.code != "group_refs_cleared" else "minor",
                category="structure",
                title=repair.message.split(".")[0],
                failure_scenario=(
                    repair.message
                    + " The variant you are looking at is not exactly the patch you approved."
                ),
                node_ids=repair.node_ids,
                edge_keys=repair.edge_keys,
            )
        )

    # --- degeneracy ---------------------------------------------------------
    if len(node_ids) < 3:
        findings.append(
            _finding(
                "degenerate_diagram",
                severity="blocking",
                category="structure",
                title=f"Only {len(node_ids)} stages remain",
                failure_scenario=(
                    "An algorithm with fewer than three stages no longer describes a "
                    "method. The modification removed too much to reason about."
                ),
                node_ids=node_ids,
            )
        )
    if not ir.edges:
        findings.append(
            _finding(
                "no_edges",
                severity="blocking",
                category="structure",
                title="No stage is connected to any other",
                failure_scenario=(
                    "With no edges, nothing flows between stages: there is no algorithm "
                    "left, just a set of isolated components."
                ),
                node_ids=node_ids,
            )
        )
    elif len(set(layer_of.values())) <= 1 and len(node_ids) > 2:
        findings.append(
            _finding(
                "single_layer",
                severity="blocking",
                category="structure",
                title="Every stage sits at the same depth",
                failure_scenario=(
                    "No stage feeds another, so the algorithm has no sequence. Any "
                    "ordering the paper relied on has been lost."
                ),
                node_ids=node_ids,
            )
        )

    # --- orphans ------------------------------------------------------------
    degree: Dict[str, int] = {node_id: 0 for node_id in node_ids}
    for edge in ir.edges:
        degree[edge.source] = degree.get(edge.source, 0) + 1
        degree[edge.target] = degree.get(edge.target, 0) + 1
    orphans = [node_id for node_id in node_ids if degree.get(node_id, 0) == 0]
    if orphans and ir.edges:
        findings.append(
            _finding(
                "orphan_node",
                severity="blocking",
                category="structure",
                title=f"{len(orphans)} stage(s) participate in nothing",
                failure_scenario=(
                    "These stages have no inputs and no outputs, so they can neither "
                    "receive nor contribute anything: "
                    + ", ".join(node_by_id[n].label for n in orphans)
                    + ". Either wire them in or remove them."
                ),
                node_ids=orphans,
            )
        )

    # --- forward reachability ----------------------------------------------
    inputs = [node.id for node in ir.nodes if node.kind == "input"]
    if not inputs:
        in_degree: Dict[str, int] = {node_id: 0 for node_id in node_ids}
        for edge in ir.edges:
            in_degree[edge.target] = in_degree.get(edge.target, 0) + 1
        inputs = [node_id for node_id in node_ids if in_degree.get(node_id, 0) == 0]
        findings.append(
            _finding(
                "no_input_node",
                severity="minor",
                category="structure",
                title="No stage is marked as the input",
                failure_scenario=(
                    "Nothing declares where data enters, so the algorithm has no defined "
                    "starting point. Reachability below is computed from stages with no "
                    "incoming edges instead."
                ),
                node_ids=inputs,
            )
        )

    if inputs and ir.edges:
        forward, _ = _adjacency(ir, skip_kinds={"reference"})
        reached = _reachable(inputs, forward)
        unreachable = [node_id for node_id in node_ids if node_id not in reached]
        significant = [
            node_id
            for node_id in unreachable
            if node_by_id[node_id].kind in {"operation", "component", "output"}
        ]
        incidental = [n for n in unreachable if n not in significant and n not in orphans]
        if significant:
            findings.append(
                _finding(
                    "unreachable_from_input",
                    severity="major",
                    category="reachability",
                    title=f"{len(significant)} stage(s) can never run",
                    failure_scenario=(
                        "No path carries data from the input to "
                        + ", ".join(node_by_id[n].label for n in significant)
                        + ", so these stages are never reached on any input."
                    ),
                    node_ids=significant,
                )
            )
        if incidental:
            findings.append(
                _finding(
                    "unreachable_auxiliary",
                    severity="minor",
                    category="reachability",
                    title="Auxiliary stages are disconnected from the input path",
                    failure_scenario=(
                        ", ".join(node_by_id[n].label for n in incidental)
                        + " sit outside the data path. That can be intentional for "
                        "reference material, but nothing consumes them here."
                    ),
                    node_ids=incidental,
                )
            )

    # --- backward reachability ---------------------------------------------
    outputs = [node.id for node in ir.nodes if node.kind == "output"]
    if not outputs and ir.edges:
        findings.append(
            _finding(
                "no_output_node",
                severity="minor",
                category="structure",
                title="No stage is marked as the output",
                failure_scenario=(
                    "Nothing declares what the algorithm produces, so there is no way to "
                    "tell whether the computation reaches a result."
                ),
                node_ids=[],
            )
        )
    elif outputs and ir.edges:
        _, backward = _adjacency(ir, skip_kinds={"reference"})
        contributing = _reachable(outputs, backward)
        dead_ends = [
            node_id
            for node_id in node_ids
            if node_id not in contributing
            and node_id not in orphans
            and node_by_id[node_id].kind in {"operation", "component", "input"}
        ]
        if dead_ends:
            findings.append(
                _finding(
                    "dead_end",
                    severity="major",
                    category="reachability",
                    title=f"{len(dead_ends)} stage(s) compute something nothing uses",
                    failure_scenario=(
                        "No path leads from "
                        + ", ".join(node_by_id[n].label for n in dead_ends)
                        + " to any output, so whatever they compute is discarded. Either "
                        "the result should be consumed or the stage is now redundant."
                    ),
                    node_ids=dead_ends,
                )
            )

    # --- cycles -------------------------------------------------------------
    back_indices = _break_cycles(node_ids, ir.edges)
    unexpected = [
        ir.edges[index]
        for index in sorted(back_indices)
        if ir.edges[index].kind not in LEGITIMATE_BACK_KINDS
    ]
    if unexpected:
        members: List[str] = []
        for edge in unexpected:
            members.extend(_cycle_members(ir, edge))
        findings.append(
            _finding(
                "unexpected_cycle",
                severity="major" if ir.diagram_kind == "pipeline" else "minor",
                category="structure",
                title=f"{len(unexpected)} loop(s) not marked as feedback",
                failure_scenario=(
                    "These edges close a loop but are typed as ordinary flow: "
                    + ", ".join(f"{e.source}->{e.target}" for e in unexpected)
                    + ". Either the loop is unintended, or the edge should be typed "
                    "'feedback' so the recurrence is explicit."
                ),
                node_ids=sorted(set(members)),
                edge_keys=[edge_key(edge) for edge in unexpected],
            )
        )

    # --- edge-kind sanity ---------------------------------------------------
    attention_into_input = [
        edge for edge in ir.edges
        if edge.kind == "attention" and node_by_id.get(edge.target, None)
        and node_by_id[edge.target].kind == "input"
    ]
    if attention_into_input:
        findings.append(
            _finding(
                "attention_into_input",
                severity="minor",
                category="structure",
                title="An attention edge points back into the input",
                failure_scenario=(
                    "Attention writing into the input stage inverts the direction of "
                    "information flow the paper describes."
                ),
                edge_keys=[edge_key(edge) for edge in attention_into_input],
                node_ids=sorted({edge.target for edge in attention_into_input}),
            )
        )

    degenerate_residual = [
        edge
        for edge in ir.edges
        if edge.kind == "residual"
        and edge.source in layer_of
        and edge.target in layer_of
        and abs(layer_of[edge.target] - layer_of[edge.source]) <= 1
    ]
    if degenerate_residual:
        findings.append(
            _finding(
                "degenerate_residual",
                severity="minor",
                category="structure",
                title="A residual connection skips nothing",
                failure_scenario=(
                    "These residual edges span adjacent stages, so they bypass no "
                    "computation and are equivalent to an ordinary flow edge: "
                    + ", ".join(f"{e.source}->{e.target}" for e in degenerate_residual)
                    + "."
                ),
                edge_keys=[edge_key(edge) for edge in degenerate_residual],
            )
        )

    # --- group shape --------------------------------------------------------
    for group in ir.groups:
        member_layers = sorted(
            layer_of[node.id]
            for node in ir.nodes
            if node.group == group.id and node.id in layer_of
        )
        if len(member_layers) < 2:
            continue
        span = set(range(member_layers[0], member_layers[-1] + 1))
        outsiders = [
            node.id
            for node in ir.nodes
            if node.group != group.id
            and node.id in layer_of
            and layer_of[node.id] in span
        ]
        if outsiders:
            findings.append(
                _finding(
                    "group_not_contiguous",
                    severity="minor",
                    category="structure",
                    title=f"Group '{group.label}' is interrupted",
                    failure_scenario=(
                        f"Stages outside '{group.label}' sit between its members, so a "
                        "'repeat this block' reading of the group no longer holds."
                    ),
                    node_ids=sorted(outsiders),
                )
            )

    return findings


def structural_delta(parent: DiagramIR, variant: DiagramIR) -> Dict[str, Any]:
    """Cheap comparison numbers. Not findings — context for the reader."""

    def depth(ir: DiagramIR) -> int:
        layout_nodes = []
        try:
            from app.rag.paper_visualizer import layout_ir

            layout_nodes = layout_ir(ir).get("nodes", [])
        except Exception:
            return 0
        return max((node["layer"] for node in layout_nodes), default=0) + 1

    def fan(ir: DiagramIR) -> Tuple[int, int]:
        out_counts: Dict[str, int] = defaultdict(int)
        in_counts: Dict[str, int] = defaultdict(int)
        for edge in ir.edges:
            out_counts[edge.source] += 1
            in_counts[edge.target] += 1
        return max(in_counts.values(), default=0), max(out_counts.values(), default=0)

    parent_kinds = {edge.kind for edge in parent.edges}
    variant_kinds = {edge.kind for edge in variant.edges}
    parent_in, parent_out = fan(parent)
    variant_in, variant_out = fan(variant)

    return {
        "nodes": {"before": len(parent.nodes), "after": len(variant.nodes)},
        "edges": {"before": len(parent.edges), "after": len(variant.edges)},
        "groups": {"before": len(parent.groups), "after": len(variant.groups)},
        "depth": {"before": depth(parent), "after": depth(variant)},
        "max_fan_in": {"before": parent_in, "after": variant_in},
        "max_fan_out": {"before": parent_out, "after": variant_out},
        "edge_kinds_removed": sorted(parent_kinds - variant_kinds),
        "edge_kinds_added": sorted(variant_kinds - parent_kinds),
    }


# --------------------------------------------------------------- assembly

def _finding_signature(
    finding: Finding, common_nodes: set[str]
) -> Tuple[str, Tuple[str, ...]]:
    """Identity of a finding across parent and variant.

    Restricted to nodes present in both graphs, so a finding is recognised as
    the same problem even when the patch added or removed unrelated stages.
    """
    return (
        finding.finding_id,
        tuple(sorted(n for n in finding.node_ids if n in common_nodes)),
    )


def mark_inherited(
    variant_findings: List[Finding],
    parent_findings: List[Finding],
    parent_ir: DiagramIR,
    variant_ir: DiagramIR,
) -> List[Finding]:
    """Flag problems the parent diagram already had.

    Extraction quirks in the original diagram are not the modification's fault,
    and blaming a variant for them buries the findings the user can actually
    act on. Inherited findings stay visible but do not affect the verdict.
    """
    common = {node.id for node in parent_ir.nodes} & {
        node.id for node in variant_ir.nodes
    }
    parent_signatures = {
        _finding_signature(finding, common) for finding in parent_findings
    }
    return [
        finding.model_copy(update={"inherited": True})
        if _finding_signature(finding, common) in parent_signatures
        else finding
        for finding in variant_findings
    ]


def rank_findings(findings: List[Finding]) -> List[Finding]:
    """Stable, reproducible order. Also enforces the honesty guardrails."""
    guarded: List[Finding] = []
    for finding in findings:
        # Only deterministic checks may be blocking; judgment is capped at major.
        if finding.basis != "deterministic" and finding.severity == "blocking":
            finding = finding.model_copy(update={"severity": "major"})
        guarded.append(finding)

    return sorted(
        guarded,
        key=lambda f: (
            f.inherited,
            SEVERITY_RANK[f.severity],
            BASIS_RANK[f.basis],
            CONFIDENCE_RANK[f.confidence],
            f.finding_id,
        ),
    )


def compute_verdict(findings: List[Finding]) -> Tuple[Verdict, str]:
    """Verdict and headline are computed here, never written by a model."""
    # Only problems the modification introduced count toward the verdict.
    caused = [finding for finding in findings if not finding.inherited]
    inherited = len(findings) - len(caused)

    counts = {severity: 0 for severity in SEVERITY_RANK}
    for finding in caused:
        counts[finding.severity] += 1

    deterministic = sum(1 for f in caused if f.basis == "deterministic")
    judged = len(caused) - deterministic

    if counts["blocking"]:
        verdict: Verdict = "likely_broken"
        plural = counts["blocking"] != 1
        headline = (
            f"{counts['blocking']} structural problem{'s' if plural else ''} "
            f"{'make' if plural else 'makes'} this variant incoherent."
        )
    elif counts["major"]:
        verdict = "concerns"
        headline = (
            f"Structurally intact, with {counts['major']} significant concern"
            f"{'s' if counts['major'] != 1 else ''} to resolve."
        )
    else:
        verdict = "structurally_sound"
        headline = (
            "No structural problems found."
            if not caused
            else f"Structurally sound; {len(caused)} minor observation"
            f"{'s' if len(caused) != 1 else ''}."
        )

    if judged:
        headline += f" ({deterministic} checked, {judged} judged.)"
    if inherited:
        headline += (
            f" {inherited} pre-existing issue"
            f"{'s' if inherited != 1 else ''} carried over from the original diagram."
        )
    return verdict, headline

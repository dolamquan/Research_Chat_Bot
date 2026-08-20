"""Modify a paper's algorithm: typed patch operations over a diagram IR.

The stored diagram is the *laid out* form, so mutation is a round trip:
record -> DiagramIR -> apply ops -> normalize -> layout_ir -> record.

Every operation is validated before it touches the IR and a rejected operation
never partially applies. Repairs that `normalize_ir` performs silently are
surfaced explicitly, because a patch that quietly loses an edge is worse than
one that is refused.
"""

import re
from typing import Any, Dict, List, Literal, Optional, Tuple, get_args

from langsmith import traceable
from pydantic import BaseModel

from app.rag.generator import get_llm
from app.rag.paper_visualizer import (
    DIAGRAM_KINDS,
    MAX_EDGES,
    MAX_GROUPS,
    MAX_NODES,
    DiagramIR,
    EdgeKind,
    IREdge,
    IRGroup,
    IRNode,
    NodeKind,
    _article_header,
    _format_context,
    _string,
    _structured_llm_call,
    layout_ir,
    normalize_ir,
)


IR_NODE_FIELDS = ("id", "label", "kind", "detail", "group")
IR_EDGE_FIELDS = ("source", "target", "label", "kind")
IR_GROUP_FIELDS = ("id", "label", "repeat")

NODE_KINDS = set(get_args(NodeKind))
EDGE_KINDS = set(get_args(EdgeKind))

MAX_PATCH_OPS = 12
MAX_PROPOSAL_CONTEXT_CHARS = 20_000
ID_PATTERN = re.compile(r"^[a-z0-9_]{1,40}$")

OpKind = Literal[
    "add_node",
    "remove_node",
    "update_node",
    "add_edge",
    "remove_edge",
    "rewire_edge",
    "update_group",
    "update_meta",
]


# --------------------------------------------------------------- wire schema

class RawOp(BaseModel):
    """One patch operation.

    Deliberately flat with every field required: OpenAI strict structured
    output rejects `oneOf` (discriminated unions) and omits defaulted fields
    from `required`, which would silently push every call onto the JSON
    fallback path. Unused fields carry "" / false sentinels.
    """

    op: OpKind
    intent: str

    node_id: str
    label: str
    kind: str
    detail: str
    group: str

    source: str
    target: str
    edge_label: str
    edge_kind: str

    new_source: str
    new_target: str
    reconnect: str  # "bridge" | "drop" | ""

    group_label: str
    repeat: str
    create_group: bool

    title: str
    algorithm_name: str
    summary: str
    key_insight: str


class ModificationPatch(BaseModel):
    variant_title: str
    rationale: str
    expected_effect: str
    risks: str
    ops: List[RawOp]


# ------------------------------------------------------------ result schema

class AppliedOp(BaseModel):
    index: int
    op: RawOp
    summary: str
    node_ids: List[str]
    edge_keys: List[str]
    derived_edges: List[str]
    reversible: bool
    inverse_ops: List[RawOp]


class RedundantOpError(ValueError):
    """The op asked for something an earlier op in the same patch already did."""


class RejectedOp(BaseModel):
    index: int
    op: RawOp
    reason: str
    # Redundant ops are harmless: the intent was achieved by an earlier op.
    # Kept separate from genuine mistakes so review does not cry wolf.
    redundant: bool = False


class RepairNote(BaseModel):
    """Something `normalize_ir` changed on its own — never hidden."""

    code: str
    message: str
    node_ids: List[str]
    edge_keys: List[str]


class PatchResult(BaseModel):
    ir: DiagramIR
    applied: List[AppliedOp]
    rejected: List[RejectedOp]
    repairs: List[RepairNote]
    changed_node_ids: List[str]
    removed_node_ids: List[str]
    structurally_touched_node_ids: List[str]


# ------------------------------------------------------------- round trip

def edge_key(edge: IREdge) -> str:
    return f"{edge.source}->{edge.target}:{edge.kind}"


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", _string(value).strip().lower()).strip("_")
    return slug[:40]


def _coerce_node(raw: Dict[str, Any]) -> IRNode:
    kind = _string(raw.get("kind")).strip()
    group = raw.get("group")
    return IRNode(
        id=_string(raw.get("id")).strip(),
        label=_string(raw.get("label")).strip(),
        kind=kind if kind in NODE_KINDS else "operation",
        detail=_string(raw.get("detail")),
        group=_string(group).strip() or None if group else None,
    )


def _coerce_edge(raw: Dict[str, Any]) -> IREdge:
    kind = _string(raw.get("kind")).strip()
    return IREdge(
        source=_string(raw.get("source")).strip(),
        target=_string(raw.get("target")).strip(),
        label=_string(raw.get("label")),
        kind=kind if kind in EDGE_KINDS else "flow",
    )


def _coerce_group(raw: Dict[str, Any]) -> IRGroup:
    repeat = raw.get("repeat")
    return IRGroup(
        id=_string(raw.get("id")).strip(),
        label=_string(raw.get("label")).strip(),
        repeat=_string(repeat).strip() or None if repeat else None,
    )


def ir_from_record(record: Dict[str, Any]) -> DiagramIR:
    """Rebuild the IR from a stored (laid out) diagram record.

    Whitelists IR fields rather than deleting layout fields, so future layout
    additions cannot leak into the IR. Node order is preserved, which is what
    makes `layout_ir(ir_from_record(r)) == r["diagram"]` hold.
    """
    diagram = record.get("diagram") or {}
    nodes = [_coerce_node(node) for node in diagram.get("nodes") or []]
    edges = [_coerce_edge(edge) for edge in diagram.get("edges") or []]
    groups = [_coerce_group(group) for group in diagram.get("groups") or []]

    nodes = [node for node in nodes if node.id]
    if not nodes:
        raise ValueError("Diagram is malformed: no usable nodes")

    diagram_kind = _string(record.get("diagram_kind")).strip()
    return DiagramIR(
        title=_string(record.get("title")),
        algorithm_name=_string(record.get("algorithm_name")),
        diagram_kind=diagram_kind if diagram_kind in DIAGRAM_KINDS else "method_flow",
        summary=_string(record.get("summary")),
        key_insight=_string(record.get("key_insight")),
        groups=[group for group in groups if group.id],
        nodes=nodes,
        edges=edges,
    )


def render_diagram(ir: DiagramIR) -> Dict[str, Any]:
    """IR -> the laid-out shape the frontend and storage both expect."""
    return layout_ir(ir)


def id_table(ir: DiagramIR) -> str:
    """The graph as an explicit id table — the grounding an LLM patch needs."""
    lines = ["NODES (id | kind | label | group | detail)"]
    for node in ir.nodes:
        detail = node.detail.replace("\n", " ")[:120]
        lines.append(
            f"  {node.id} | {node.kind} | {node.label} | {node.group or '-'} | {detail}"
        )
    lines.append("EDGES (source -> target [kind] label)")
    for edge in ir.edges:
        lines.append(
            f"  {edge.source} -> {edge.target} [{edge.kind}]"
            + (f" {edge.label}" if edge.label else "")
        )
    if ir.groups:
        lines.append("GROUPS (id | label | repeat)")
        for group in ir.groups:
            lines.append(f"  {group.id} | {group.label} | {group.repeat or '-'}")
    return "\n".join(lines)


# --------------------------------------------------------------- apply ops

def _blank_op(op: OpKind, intent: str = "") -> RawOp:
    return RawOp(
        op=op,
        intent=intent,
        node_id="",
        label="",
        kind="",
        detail="",
        group="",
        source="",
        target="",
        edge_label="",
        edge_kind="",
        new_source="",
        new_target="",
        reconnect="",
        group_label="",
        repeat="",
        create_group=False,
        title="",
        algorithm_name="",
        summary="",
        key_insight="",
    )


def _find_edges(
    ir: DiagramIR, source: str, target: str, kind: str
) -> List[IREdge]:
    return [
        edge
        for edge in ir.edges
        if edge.source == source
        and edge.target == target
        and (not kind or edge.kind == kind)
    ]


def _apply_add_node(ir: DiagramIR, op: RawOp) -> Tuple[str, List[str], List[RawOp]]:
    node_id = _slug(op.node_id or op.label)
    if not node_id or not ID_PATTERN.match(node_id):
        raise ValueError(f"invalid node id {op.node_id!r}")
    if any(node.id == node_id for node in ir.nodes):
        raise ValueError(f"node {node_id!r} already exists")
    if len(ir.nodes) >= MAX_NODES:
        raise ValueError(f"node budget reached ({MAX_NODES})")
    kind = op.kind.strip() or "operation"
    if kind not in NODE_KINDS:
        raise ValueError(f"unknown node kind {op.kind!r}")
    group = op.group.strip() or None
    if group and not any(existing.id == group for existing in ir.groups):
        raise ValueError(f"group {group!r} does not exist")

    ir.nodes.append(
        IRNode(
            id=node_id,
            label=(op.label.strip() or node_id)[:60],
            kind=kind,
            detail=op.detail.strip(),
            group=group,
        )
    )
    inverse = _blank_op("remove_node", f"undo add of {node_id}")
    inverse.node_id = node_id
    inverse.reconnect = "drop"
    return f"added node {node_id}", [node_id], [inverse]


def _apply_remove_node(
    ir: DiagramIR, op: RawOp
) -> Tuple[str, List[str], List[str], List[RawOp]]:
    node_id = op.node_id.strip()
    node = next((n for n in ir.nodes if n.id == node_id), None)
    if node is None:
        raise ValueError(f"node {node_id!r} does not exist")
    if len(ir.nodes) <= 2:
        raise ValueError("removing this node would leave fewer than 2 nodes")

    incoming = [edge for edge in ir.edges if edge.target == node_id]
    outgoing = [edge for edge in ir.edges if edge.source == node_id]
    reconnect = (op.reconnect.strip() or "bridge").lower()

    derived: List[str] = []
    if reconnect == "bridge":
        # Stitch predecessors to successors so dropping a stage leaves a
        # connected pipeline instead of a hole.
        existing = {(e.source, e.target, e.kind) for e in ir.edges}
        for pred in incoming:
            for succ in outgoing:
                if pred.source == succ.target:
                    continue
                kind = (
                    pred.kind if pred.kind == succ.kind and pred.kind != "flow" else "flow"
                )
                key = (pred.source, succ.target, kind)
                if key in existing:
                    continue
                if len(ir.edges) >= MAX_EDGES:
                    break
                bridge = IREdge(
                    source=pred.source, target=succ.target, label="", kind=kind
                )
                ir.edges.append(bridge)
                existing.add(key)
                derived.append(edge_key(bridge))

    removed_edges = [edge for edge in ir.edges if node_id in (edge.source, edge.target)]
    ir.edges = [edge for edge in ir.edges if node_id not in (edge.source, edge.target)]
    ir.nodes = [n for n in ir.nodes if n.id != node_id]

    # Inverse: restore the node and every edge it participated in.
    inverse: List[RawOp] = []
    restore = _blank_op("add_node", f"restore {node_id}")
    restore.node_id = node.id
    restore.label = node.label
    restore.kind = node.kind
    restore.detail = node.detail
    restore.group = node.group or ""
    inverse.append(restore)
    for edge in removed_edges:
        add_edge = _blank_op("add_edge", f"restore edge into/out of {node_id}")
        add_edge.source = edge.source
        add_edge.target = edge.target
        add_edge.edge_label = edge.label
        add_edge.edge_kind = edge.kind
        inverse.append(add_edge)
    for key in derived:
        source, rest = key.split("->", 1)
        target, kind = rest.rsplit(":", 1)
        drop = _blank_op("remove_edge", "drop bridge edge")
        drop.source = source
        drop.target = target
        drop.edge_kind = kind
        inverse.append(drop)

    summary = f"removed node {node_id}"
    if derived:
        summary += f" (bridged {len(derived)} edge{'s' if len(derived) != 1 else ''})"
    return summary, [node_id], derived, inverse


def _apply_update_node(ir: DiagramIR, op: RawOp) -> Tuple[str, List[str], List[RawOp]]:
    node_id = op.node_id.strip()
    node = next((n for n in ir.nodes if n.id == node_id), None)
    if node is None:
        raise ValueError(f"node {node_id!r} does not exist")

    before = _blank_op("update_node", f"revert {node_id}")
    before.node_id = node_id
    before.label = node.label
    before.kind = node.kind
    before.detail = node.detail
    before.group = node.group or ""

    changed: List[str] = []
    if op.label.strip():
        node.label = op.label.strip()[:60]
        changed.append("label")
    if op.kind.strip():
        if op.kind.strip() not in NODE_KINDS:
            raise ValueError(f"unknown node kind {op.kind!r}")
        node.kind = op.kind.strip()
        changed.append("kind")
    if op.detail.strip():
        node.detail = op.detail.strip()
        changed.append("detail")
    if op.group.strip():
        group = op.group.strip()
        if group.lower() in {"none", "-"}:
            node.group = None
        else:
            if not any(existing.id == group for existing in ir.groups):
                raise ValueError(f"group {group!r} does not exist")
            node.group = group
        changed.append("group")

    if not changed:
        raise ValueError("no fields to update")
    return f"updated {node_id} ({', '.join(changed)})", [node_id], [before]


def _apply_add_edge(ir: DiagramIR, op: RawOp) -> Tuple[str, List[str], List[RawOp]]:
    source, target = op.source.strip(), op.target.strip()
    ids = {node.id for node in ir.nodes}
    if source not in ids:
        raise ValueError(f"edge source {source!r} does not exist")
    if target not in ids:
        raise ValueError(f"edge target {target!r} does not exist")
    kind = op.edge_kind.strip() or "flow"
    if kind not in EDGE_KINDS:
        raise ValueError(f"unknown edge kind {op.edge_kind!r}")
    if source == target and kind == "flow":
        raise ValueError("a flow edge cannot loop a node to itself")
    if _find_edges(ir, source, target, kind):
        raise ValueError(f"edge {source}->{target} [{kind}] already exists")
    if len(ir.edges) >= MAX_EDGES:
        raise ValueError(f"edge budget reached ({MAX_EDGES})")

    ir.edges.append(
        IREdge(source=source, target=target, label=op.edge_label.strip(), kind=kind)
    )
    inverse = _blank_op("remove_edge", f"undo edge {source}->{target}")
    inverse.source = source
    inverse.target = target
    inverse.edge_kind = kind
    return f"added edge {source}->{target} [{kind}]", [source, target], [inverse]


def _apply_remove_edge(ir: DiagramIR, op: RawOp) -> Tuple[str, List[str], List[RawOp]]:
    source, target = op.source.strip(), op.target.strip()
    kind = op.edge_kind.strip()
    matches = _find_edges(ir, source, target, kind)
    if not matches:
        present = {node.id for node in ir.nodes}
        missing = [node_id for node_id in (source, target) if node_id not in present]
        if missing:
            raise RedundantOpError(
                "already removed along with node " + ", ".join(missing)
            )
        raise ValueError(f"no edge {source}->{target}" + (f" [{kind}]" if kind else ""))

    keys = {edge_key(edge) for edge in matches}
    ir.edges = [edge for edge in ir.edges if edge_key(edge) not in keys]

    inverse: List[RawOp] = []
    for edge in matches:
        restore = _blank_op("add_edge", f"restore edge {edge.source}->{edge.target}")
        restore.source = edge.source
        restore.target = edge.target
        restore.edge_label = edge.label
        restore.edge_kind = edge.kind
        inverse.append(restore)
    return (
        f"removed {len(matches)} edge{'s' if len(matches) != 1 else ''} {source}->{target}",
        [source, target],
        inverse,
    )


def _apply_rewire_edge(ir: DiagramIR, op: RawOp) -> Tuple[str, List[str], List[RawOp]]:
    source, target = op.source.strip(), op.target.strip()
    kind = op.edge_kind.strip()
    matches = _find_edges(ir, source, target, kind)
    if not matches:
        raise ValueError(f"no edge {source}->{target} to rewire")
    if len(matches) > 1:
        raise ValueError(
            f"edge {source}->{target} is ambiguous ({len(matches)} kinds); specify edge_kind"
        )

    edge = matches[0]
    ids = {node.id for node in ir.nodes}
    new_source = op.new_source.strip() or edge.source
    new_target = op.new_target.strip() or edge.target
    if new_source not in ids:
        raise ValueError(f"new source {new_source!r} does not exist")
    if new_target not in ids:
        raise ValueError(f"new target {new_target!r} does not exist")
    if new_source == new_target and edge.kind == "flow":
        raise ValueError("a flow edge cannot loop a node to itself")
    if (new_source, new_target) == (edge.source, edge.target):
        raise ValueError("rewire does not change the endpoints")
    if _find_edges(ir, new_source, new_target, edge.kind):
        raise ValueError(f"edge {new_source}->{new_target} already exists")

    old_source, old_target = edge.source, edge.target
    edge.source, edge.target = new_source, new_target

    inverse = _blank_op("rewire_edge", "revert rewire")
    inverse.source = new_source
    inverse.target = new_target
    inverse.edge_kind = edge.kind
    inverse.new_source = old_source
    inverse.new_target = old_target
    return (
        f"rewired {old_source}->{old_target} to {new_source}->{new_target}",
        [old_source, old_target, new_source, new_target],
        [inverse],
    )


def _apply_update_group(ir: DiagramIR, op: RawOp) -> Tuple[str, List[str], List[RawOp]]:
    group_id = _slug(op.group or op.group_label)
    if not group_id:
        raise ValueError("group id is required")
    existing = next((g for g in ir.groups if g.id == group_id), None)

    if op.create_group:
        if existing is not None:
            raise ValueError(f"group {group_id!r} already exists")
        if len(ir.groups) >= MAX_GROUPS:
            raise ValueError(f"group budget reached ({MAX_GROUPS})")
        ir.groups.append(
            IRGroup(
                id=group_id,
                label=op.group_label.strip() or group_id,
                repeat=op.repeat.strip() or None,
            )
        )
        inverse = _blank_op("update_group", f"undo group {group_id}")
        inverse.group = group_id
        return f"created group {group_id}", [], [inverse]

    if existing is None:
        raise ValueError(f"group {group_id!r} does not exist")
    before = _blank_op("update_group", f"revert group {group_id}")
    before.group = group_id
    before.group_label = existing.label
    before.repeat = existing.repeat or ""
    if op.group_label.strip():
        existing.label = op.group_label.strip()
    if op.repeat.strip():
        existing.repeat = op.repeat.strip()
    return f"updated group {group_id}", [], [before]


def _apply_update_meta(ir: DiagramIR, op: RawOp) -> Tuple[str, List[str], List[RawOp]]:
    before = _blank_op("update_meta", "revert metadata")
    before.title = ir.title
    before.algorithm_name = ir.algorithm_name
    before.summary = ir.summary
    before.key_insight = ir.key_insight

    changed: List[str] = []
    if op.title.strip():
        ir.title = op.title.strip()[:200]
        changed.append("title")
    if op.algorithm_name.strip():
        ir.algorithm_name = op.algorithm_name.strip()[:120]
        changed.append("algorithm_name")
    if op.summary.strip():
        ir.summary = op.summary.strip()
        changed.append("summary")
    if op.key_insight.strip():
        ir.key_insight = op.key_insight.strip()
        changed.append("key_insight")
    if not changed:
        raise ValueError("no metadata fields to update")
    return f"updated {', '.join(changed)}", [], [before]


def _diff_repairs(before: DiagramIR, after: DiagramIR) -> List[RepairNote]:
    """Everything `normalize_ir` removed on its own, stated explicitly."""
    repairs: List[RepairNote] = []

    before_nodes = {node.id for node in before.nodes}
    after_nodes = {node.id for node in after.nodes}
    dropped_nodes = sorted(before_nodes - after_nodes)
    if dropped_nodes:
        repairs.append(
            RepairNote(
                code="nodes_dropped",
                message=(
                    "Normalization dropped "
                    + ", ".join(dropped_nodes)
                    + " (duplicate id or node budget)."
                ),
                node_ids=dropped_nodes,
                edge_keys=[],
            )
        )

    before_edges = {edge_key(edge) for edge in before.edges}
    after_edges = {edge_key(edge) for edge in after.edges}
    dropped_edges = sorted(before_edges - after_edges)
    if dropped_edges:
        repairs.append(
            RepairNote(
                code="edges_dropped",
                message=(
                    f"Normalization dropped {len(dropped_edges)} edge(s) whose endpoints "
                    "no longer exist, that duplicated another edge, or that exceeded the budget."
                ),
                node_ids=[],
                edge_keys=dropped_edges,
            )
        )

    before_groups = {group.id for group in before.groups}
    after_groups = {group.id for group in after.groups}
    dissolved = sorted(before_groups - after_groups)
    if dissolved:
        repairs.append(
            RepairNote(
                code="groups_dissolved",
                message=(
                    "Dissolved group(s) " + ", ".join(dissolved) + " with fewer than 2 members."
                ),
                node_ids=[],
                edge_keys=[],
            )
        )

    orphaned_group_refs = [
        node.id
        for node in after.nodes
        if node.group is None
        and next((n for n in before.nodes if n.id == node.id), None) is not None
        and next(n for n in before.nodes if n.id == node.id).group is not None
    ]
    if orphaned_group_refs:
        repairs.append(
            RepairNote(
                code="group_refs_cleared",
                message=(
                    "Cleared the group reference on "
                    + ", ".join(sorted(orphaned_group_refs))
                    + " because the group no longer exists."
                ),
                node_ids=sorted(orphaned_group_refs),
                edge_keys=[],
            )
        )
    return repairs


@traceable(name="apply_diagram_patch", run_type="chain")
def apply_patch(ir: DiagramIR, ops: List[RawOp]) -> PatchResult:
    """Apply ops in order. Invalid ops are rejected, never partially applied."""
    working = ir.model_copy(deep=True)
    before_nodes = {node.id: node.model_copy(deep=True) for node in working.nodes}
    before_edge_keys = {edge_key(edge) for edge in working.edges}

    applied: List[AppliedOp] = []
    rejected: List[RejectedOp] = []
    structurally_touched: set[str] = set()

    for index, op in enumerate(ops):
        snapshot = working.model_copy(deep=True)
        try:
            derived: List[str] = []
            if op.op == "add_node":
                summary, touched, inverse = _apply_add_node(working, op)
            elif op.op == "remove_node":
                summary, touched, derived, inverse = _apply_remove_node(working, op)
            elif op.op == "update_node":
                summary, touched, inverse = _apply_update_node(working, op)
            elif op.op == "add_edge":
                summary, touched, inverse = _apply_add_edge(working, op)
                structurally_touched.update(touched)
            elif op.op == "remove_edge":
                summary, touched, inverse = _apply_remove_edge(working, op)
                structurally_touched.update(touched)
            elif op.op == "rewire_edge":
                summary, touched, inverse = _apply_rewire_edge(working, op)
                structurally_touched.update(touched)
            elif op.op == "update_group":
                summary, touched, inverse = _apply_update_group(working, op)
            elif op.op == "update_meta":
                summary, touched, inverse = _apply_update_meta(working, op)
            else:  # pragma: no cover - OpKind is exhaustive
                raise ValueError(f"unsupported operation {op.op!r}")
        except ValueError as error:
            # Roll back to the pre-op state so a bad op cannot corrupt the IR.
            working = snapshot
            rejected.append(
                RejectedOp(
                    index=index,
                    op=op,
                    reason=str(error),
                    redundant=isinstance(error, RedundantOpError),
                )
            )
            continue

        reversible = 0 < len(inverse) <= 6
        applied.append(
            AppliedOp(
                index=index,
                op=op,
                summary=summary,
                node_ids=sorted(set(touched)),
                edge_keys=[],
                derived_edges=derived,
                reversible=reversible,
                inverse_ops=inverse if reversible else [],
            )
        )

    pre_normalize = working.model_copy(deep=True)
    normalized = normalize_ir(working.model_copy(deep=True))
    repairs = _diff_repairs(pre_normalize, normalized)

    after_nodes = {node.id: node for node in normalized.nodes}
    removed_node_ids = sorted(set(before_nodes) - set(after_nodes))
    changed_node_ids = sorted(
        node_id
        for node_id, node in after_nodes.items()
        if node_id not in before_nodes
        or (
            node.label,
            node.kind,
            node.detail,
            node.group,
        )
        != (
            before_nodes[node_id].label,
            before_nodes[node_id].kind,
            before_nodes[node_id].detail,
            before_nodes[node_id].group,
        )
    )

    after_edge_keys = {edge_key(edge) for edge in normalized.edges}
    for key in before_edge_keys ^ after_edge_keys:
        source, rest = key.split("->", 1)
        target = rest.rsplit(":", 1)[0]
        structurally_touched.update({source, target})

    return PatchResult(
        ir=normalized,
        applied=applied,
        rejected=rejected,
        repairs=repairs,
        changed_node_ids=changed_node_ids,
        removed_node_ids=removed_node_ids,
        structurally_touched_node_ids=sorted(
            node_id for node_id in structurally_touched if node_id in after_nodes
        ),
    )


# ---------------------------------------------------------------- proposal

def _build_proposal_prompt(
    ir: DiagramIR,
    intent: str,
    article: Dict[str, Any] | None,
    chunks: List[Dict[str, Any]],
    max_ops: int,
) -> str:
    return f"""You are helping a researcher modify the algorithm described by a paper, so they can explore a new idea.

Their requested modification:
{intent}

The algorithm as it stands:
{id_table(ir)}

Produce a patch of operations that realizes the request.

Hard rules:
- Every id you reference MUST appear in the table above. Inventing an id makes the operation invalid and it will be discarded. New nodes you create with add_node are the only exception, and their ids must be short snake_case.
- Available operations: add_node, remove_node, update_node, add_edge, remove_edge, rewire_edge, update_group, update_meta.
- Use at most {max_ops} operations, and prefer the FEWEST that realize the request. Do not tidy the diagram. Do not rename or restructure anything the request did not ask about.
- For remove_node set reconnect to "bridge" to stitch its predecessors to its successors (normally what you want), or "drop" to delete its edges outright. remove_node ALREADY deletes every edge touching that node, so never also emit remove_edge for those edges — that operation would be redundant and rejected.
- Only use remove_edge for an edge between two nodes you are both keeping.
- Set every field you are not using to "" (or false for create_group). Only fill the fields relevant to each operation.
- node kinds: {', '.join(sorted(NODE_KINDS))}. edge kinds: {', '.join(sorted(EDGE_KINDS))}.
- If the modification changes what the algorithm fundamentally is, include one update_meta operation revising algorithm_name and summary.

For each operation, `intent` is ONE sentence explaining the change in terms of the paper's own mechanism (e.g. "removes the O(n^2) score matrix computed in Eq. 1"), not a restatement of the edit.

Also provide:
- variant_title: a short noun phrase naming this variant (<= 70 characters).
- rationale: 2-4 sentences on what this modification is and why a researcher would try it.
- expected_effect: what should change about the algorithm's behaviour or cost if it works.
- risks: what YOUR OWN edit could plausibly break. Be honest and specific; this is used to check the modification, not to sell it.

Paper metadata:
{_article_header(article)}

Paper context:
{_format_context(chunks, max_chars=MAX_PROPOSAL_CONTEXT_CHARS)}
"""


@traceable(name="propose_diagram_patch", run_type="chain")
def propose_patch(
    ir: DiagramIR,
    intent: str,
    article: Dict[str, Any] | None = None,
    chunks: List[Dict[str, Any]] | None = None,
    max_ops: int = 8,
    llm: Any = None,
) -> ModificationPatch:
    """Turn a natural-language modification into a reviewable typed patch."""
    if not intent.strip():
        raise ValueError("Describe the modification you want to make")

    llm = llm or get_llm(temperature=0)
    prompt = _build_proposal_prompt(
        ir, intent.strip(), article, chunks or [], max_ops
    )
    patch = _structured_llm_call(llm, prompt, ModificationPatch)
    patch.ops = patch.ops[: min(max_ops, MAX_PATCH_OPS)]
    if not patch.ops:
        raise ValueError("The model proposed no operations for that modification")
    return patch

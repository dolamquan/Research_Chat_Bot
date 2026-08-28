"""A parametric scene graph the model composes freely -- as data, never code.

This is the fully dynamic tier above `scene_composer`'s fixed actor
vocabulary. Instead of picking from nine hand-drawn forms, the model emits a
flat list of nodes -- each a geometry primitive with a transform, material
role, optional instancing, and per-instance data -- plus keyframe tracks that
animate named properties over the stage timeline. One generic interpreter in
the frontend renders any such graph, so the expressible space is the
*composition* of primitives, not a menu of finished shapes.

The security invariant is unchanged from the rest of the pipeline: every field
is an enum from a closed whitelist, a bounded number, or display text. Nothing
the model returns is executed; a malformed graph fails validation at
generation time.

Freedom needs a quality gate, so `lint_graph` checks the *layout* the way a
reviewer would -- overlapping nodes, geometry outside the frame, an all-grey
cast, a static graph -- and `compose_scene_graph` feeds any errors back to the
model for one repair pass before the graph is stored.
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Literal, Tuple

from langsmith import traceable
from pydantic import BaseModel

# --- vocabulary -------------------------------------------------------------
#
# Geometry is atomic on purpose: like SVG offering only paths and rects, the
# expressiveness comes from composing primitives, not from a long menu of
# special cases the model must guess between.

GeometryKind = Literal[
    "box", "sphere", "cylinder", "cone", "torus", "plane", "ring", "capsule",
]

LayoutKind = Literal[
    "single",  # one instance at the node's position
    "row",     # instances spread along local x
    "column",  # instances spread along local y
    "ring",    # instances on a circle in the local xy plane
    "grid",    # instances on a near-square grid
    "arc",     # instances on a half circle, opening toward +y
]

TrackProperty = Literal[
    "position_x", "position_y", "position_z",
    "rotation_y", "rotation_z",
    "scale", "opacity", "emissive",
    "progress",  # 0..1 reveal: how many instances are shown so far
]

Easing = Literal["linear", "ease_in_out", "pulse"]

NodeTone = Literal[
    "primary", "secondary", "signal", "inhibitor", "substrate", "product",
    "neutral",
]

GEOMETRY_HELP: Dict[str, str] = {
    "box": "a rectangular block; bars, cells, chips, slabs",
    "sphere": "a ball; tokens, molecules, points, particles",
    "cylinder": "a rod or disc; axes, pillars, connectors",
    "cone": "a directional tip; arrows, emitters, funnels",
    "torus": "a ring with thickness; gates, loops, ports",
    "plane": "a flat sheet; membranes, layers, backdrops",
    "ring": "a flat annulus; halos, selection markers",
    "capsule": "a rounded rod; strands, links, segments",
}

LAYOUT_HELP: Dict[str, str] = {
    "single": "one instance at the node's position",
    "row": "instances left-to-right; sequences, token streams, bar arrays",
    "column": "instances bottom-to-top; stacks, rankings",
    "ring": "instances on a circle; cycles, pools, populations",
    "grid": "instances on a grid; matrices, tissues, feature maps",
    "arc": "instances on a half circle; fan-in, fan-out, alternatives",
}

TRACK_HELP: Dict[str, str] = {
    "position_x": "move along x (world units)",
    "position_y": "move along y",
    "position_z": "move along z",
    "rotation_y": "spin about y (degrees)",
    "rotation_z": "spin about z (degrees)",
    "scale": "uniform size multiplier",
    "opacity": "0 invisible .. 1 solid",
    "emissive": "glow strength 0..2",
    "progress": "0..1 fraction of instances revealed, in order",
}

# --- budgets ----------------------------------------------------------------

MAX_GRAPH_NODES = 24
MAX_GRAPH_DEPTH = 5
MAX_NODE_COUNT = 64          # instances on one node
MAX_TOTAL_INSTANCES = 400    # across the whole graph
MAX_GRAPH_TRACKS = 48
MAX_TRACK_KEYS = 8
MAX_NODE_ITEMS = 8
MAX_NODE_VALUES = 16

FRAME_X = 8.0   # |x| beyond this is out of frame at the default camera
FRAME_Y = 5.0


class GraphNode(BaseModel):
    """One primitive (or instanced set of primitives) in the scene."""

    node_id: str
    parent_id: str        # "" = a root node
    label: str            # what it is, in the paper's vocabulary; "" = none
    geometry: GeometryKind
    size: List[float]     # geometry dimensions in world units; [] = default
    tone: NodeTone
    opacity: float        # 0..1
    emissive: float       # glow 0..2
    position: List[float]      # [x, y, z] relative to parent; [] = origin
    rotation_deg: List[float]  # [x, y, z] degrees; [] = none
    count: int            # instances; 1 = single
    layout: LayoutKind
    spacing: float        # distance between instances, world units
    values: List[float]   # per-instance magnitude (bar heights, weights); []
    items: List[str]      # per-instance names; []


class GraphTrack(BaseModel):
    """Keyframes for one property of one node over the 0..1 stage timeline."""

    node_id: str
    prop: TrackProperty
    times: List[float]    # 0..1, ascending
    keys: List[float]     # same length as times
    easing: Easing


class MechanismGraph(BaseModel):
    """A complete stage visualization as a parametric scene graph."""

    title: str
    summary: str
    caption: str          # one sentence shown while the stage plays
    nodes: List[GraphNode]
    tracks: List[GraphTrack]
    evidence: str
    described: bool


GRAPH_SCHEMA_VERSION = 1


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _finite_floats(values: List[Any], limit: int, low: float, high: float) -> List[float]:
    out: List[float] = []
    for value in values[:limit]:
        if isinstance(value, (int, float)) and math.isfinite(value):
            out.append(_clamp(float(value), low, high))
    return out


def normalize_graph(graph: MechanismGraph) -> MechanismGraph:
    """Make a model-authored graph safe to store and render.

    Same philosophy as `normalize_scene`: silent, deterministic repair of
    anything that would render wrongly or expensively; honesty stays in
    `described`, which the model sets and this never overrides.
    """
    seen: set = set()
    nodes: List[GraphNode] = []
    for node in graph.nodes[:MAX_GRAPH_NODES]:
        node_id = node.node_id.strip()
        if not node_id or node_id in seen:
            continue
        seen.add(node_id)
        node.node_id = node_id
        nodes.append(node)

    known = {node.node_id for node in nodes}
    by_id = {node.node_id: node for node in nodes}

    # Parent links: unknown or self parents become roots; cycles are broken by
    # re-rooting the node where the walk first revisits itself; depth is
    # capped by re-rooting anything deeper.
    for node in nodes:
        if node.parent_id == node.node_id or node.parent_id not in known:
            node.parent_id = ""
    for node in nodes:
        walked: set = set()
        current = node
        depth = 0
        while current.parent_id:
            if current.parent_id in walked or depth >= MAX_GRAPH_DEPTH:
                node.parent_id = ""
                break
            walked.add(current.node_id)
            depth += 1
            current = by_id[current.parent_id]

    total_instances = 0
    for node in nodes:
        node.label = node.label.strip()[:48]
        node.size = _finite_floats(node.size, 3, 0.02, 8.0)
        node.opacity = _clamp(node.opacity, 0.0, 1.0) or 1.0
        node.emissive = _clamp(node.emissive, 0.0, 2.0)
        node.position = _finite_floats(node.position, 3, -12.0, 12.0)
        node.rotation_deg = _finite_floats(node.rotation_deg, 3, -360.0, 360.0)
        node.spacing = _clamp(node.spacing, 0.0, 5.0)
        node.count = int(_clamp(float(node.count), 1, MAX_NODE_COUNT))
        # The whole-graph instance budget is a GPU guardrail, not taste. Every
        # node still draws at least one instance, so the hard ceiling is
        # MAX_TOTAL_INSTANCES + MAX_GRAPH_NODES -- bounded either way.
        if total_instances + node.count > MAX_TOTAL_INSTANCES:
            node.count = max(1, MAX_TOTAL_INSTANCES - total_instances)
        total_instances += node.count
        node.values = _finite_floats(node.values, MAX_NODE_VALUES, -1e6, 1e6)
        node.items = [
            item.strip()[:24]
            for item in node.items[:MAX_NODE_ITEMS]
            if isinstance(item, str) and item.strip()
        ]

    tracks: List[GraphTrack] = []
    for track in graph.tracks[:MAX_GRAPH_TRACKS]:
        if track.node_id not in known:
            continue
        pairs = [
            (t, k)
            for t, k in zip(track.times[:MAX_TRACK_KEYS], track.keys[:MAX_TRACK_KEYS])
            if isinstance(t, (int, float)) and math.isfinite(t)
            and isinstance(k, (int, float)) and math.isfinite(k)
        ]
        if not pairs:
            continue
        pairs.sort(key=lambda p: p[0])
        track.times = [_clamp(float(t), 0.0, 1.0) for t, _ in pairs]
        track.keys = [float(k) for _, k in pairs]
        tracks.append(track)

    if not nodes:
        graph.described = False

    graph.caption = graph.caption.strip()[:140]
    graph.nodes = nodes
    graph.tracks = tracks
    return graph


# --- the layout linter --------------------------------------------------------


def _node_extent(node: GraphNode) -> Tuple[float, float]:
    """Approximate world half-extents (x, y) of a root node with its layout."""
    base = max(node.size) if node.size else 0.5
    half = base / 2
    if node.count <= 1 or node.layout == "single":
        return (half, half)
    span = node.spacing * (node.count - 1)
    if node.layout in ("row", "arc"):
        return (span / 2 + half, half + (span / 4 if node.layout == "arc" else 0))
    if node.layout == "column":
        return (half, span / 2 + half)
    if node.layout == "ring":
        radius = span / (2 * math.pi) if node.spacing else 1.0
        return (radius + half, radius + half)
    side = math.ceil(math.sqrt(node.count))
    return (side * node.spacing / 2 + half, side * node.spacing / 2 + half)


def lint_graph(graph: MechanismGraph) -> List[str]:
    """Layout problems a reviewer would flag, as prose the model can act on.

    Lines prefixed ERROR make `compose_scene_graph` run its repair pass;
    WARN lines ride along as advice but do not trigger one alone.
    """
    findings: List[str] = []
    roots = [n for n in graph.nodes if not n.parent_id]

    for node in roots:
        x = node.position[0] if len(node.position) > 0 else 0.0
        y = node.position[1] if len(node.position) > 1 else 0.0
        ex, ey = _node_extent(node)
        if abs(x) + ex > FRAME_X or abs(y) + ey > FRAME_Y:
            findings.append(
                f"ERROR node '{node.node_id}' extends outside the visible frame "
                f"(|x| must stay under {FRAME_X}, |y| under {FRAME_Y})"
            )

    for i, a in enumerate(roots):
        for b in roots[i + 1:]:
            ax = a.position[0] if a.position else 0.0
            ay = a.position[1] if len(a.position) > 1 else 0.0
            bx = b.position[0] if b.position else 0.0
            by = b.position[1] if len(b.position) > 1 else 0.0
            aex, aey = _node_extent(a)
            bex, bey = _node_extent(b)
            overlap_x = (aex + bex) - abs(ax - bx)
            overlap_y = (aey + bey) - abs(ay - by)
            if overlap_x > 0 and overlap_y > 0:
                smaller = min(min(aex, bex) * 2, min(aey, bey) * 2) or 1.0
                if min(overlap_x, overlap_y) > 0.6 * smaller:
                    findings.append(
                        f"ERROR nodes '{a.node_id}' and '{b.node_id}' overlap; "
                        "spread them apart so both read clearly"
                    )

    # Parroting detector: the worked example teaches the JSON format, but in
    # practice models copy its whole arrangement -- every stage becomes the
    # same row-gate-row picture with the example's exact keyframes. That
    # combination is too specific to arise honestly, so it lints as an error
    # and the repair pass demands a composition for this stage's mechanism.
    example_positions = {(-4.5, 0.0, 0.0), (0.0, 0.0, 0.0), (4.5, 0.0, 0.0)}
    root_positions = {tuple((n.position + [0.0, 0.0, 0.0])[:3]) for n in roots}
    example_keys = sum(
        1
        for t in graph.tracks
        if t.times == [0.35, 0.5, 0.65] and t.keys == [0.6, 2.0, 0.8]
    )
    if example_keys >= 1 and example_positions <= root_positions:
        findings.append(
            "ERROR this graph copies the worked example's arrangement verbatim "
            "(same positions, same keyframes); compose the picture from THIS "
            "stage's own mechanism instead"
        )

    if graph.nodes and all(n.tone == "neutral" for n in graph.nodes):
        findings.append(
            "WARN every node is neutral grey; give distinct roles distinct tones"
        )
    if graph.nodes and not graph.tracks:
        findings.append(
            "WARN the graph never moves; add tracks so the mechanism plays out "
            "over time instead of sitting still"
        )
    labelled = [n for n in roots if n.label]
    if roots and not labelled:
        findings.append("WARN no root node is labelled; the reader cannot tell what anything is")
    return findings


# --- composition ----------------------------------------------------------------


def _graph_vocabulary() -> str:
    geo = "\n".join(f"  - {k}: {v}" for k, v in GEOMETRY_HELP.items())
    lay = "\n".join(f"  - {k}: {v}" for k, v in LAYOUT_HELP.items())
    trk = "\n".join(f"  - {k}: {v}" for k, v in TRACK_HELP.items())
    return (
        f"GEOMETRY (the atoms; build everything by composing them):\n{geo}\n\n"
        f"LAYOUT (how a node's `count` instances arrange):\n{lay}\n\n"
        f"TRACK PROPERTIES (animatable over the 0..1 timeline):\n{trk}\n"
    )


_EXAMPLE_GRAPH = {
    "nodes": [
        {"node_id": "tokens", "parent_id": "", "label": "Input Tokens",
         "geometry": "sphere", "size": [0.35], "tone": "substrate",
         "opacity": 1.0, "emissive": 0.8, "position": [-4.5, 0, 0],
         "rotation_deg": [], "count": 5, "layout": "row", "spacing": 0.9,
         "values": [], "items": ["the", "cat", "sat", "on", "mat"]},
        {"node_id": "embed_gate", "parent_id": "", "label": "Embedding Matrix",
         "geometry": "torus", "size": [1.1, 0.05], "tone": "signal",
         "opacity": 0.9, "emissive": 1.2, "position": [0, 0, 0],
         "rotation_deg": [], "count": 1, "layout": "single", "spacing": 0,
         "values": [], "items": []},
        {"node_id": "vectors", "parent_id": "", "label": "Dense Vectors",
         "geometry": "box", "size": [0.3, 1.4, 0.3], "tone": "product",
         "opacity": 1.0, "emissive": 0.6, "position": [4.5, 0, 0],
         "rotation_deg": [], "count": 5, "layout": "row", "spacing": 0.9,
         "values": [0.42, -0.13, 0.87, 0.31, -0.55],
         "items": ["the", "cat", "sat", "on", "mat"]},
    ],
    "tracks": [
        {"node_id": "tokens", "prop": "position_x", "times": [0.1, 0.45],
         "keys": [-4.5, -0.6], "easing": "ease_in_out"},
        {"node_id": "embed_gate", "prop": "emissive", "times": [0.35, 0.5, 0.65],
         "keys": [0.6, 2.0, 0.8], "easing": "pulse"},
        {"node_id": "vectors", "prop": "progress", "times": [0.45, 0.8],
         "keys": [0.0, 1.0], "easing": "ease_in_out"},
    ],
}

GRAPH_RULES = f"""\
Build a 3D picture of what happens in this stage of the paper's method, as a
scene graph: a list of nodes (geometry primitives, possibly instanced) and
keyframe tracks that animate them across the stage's 0..1 timeline.

Rules:
- Show the MECHANISM: inputs on the left, what they become on the right, and
  the thing that transforms them in between. Motion carries the meaning --
  move the inputs through the operator, reveal the outputs as they form.
- At most {MAX_GRAPH_NODES} nodes. Compose primitives into structures via
  parent_id (children inherit the parent's position); do not model decoration.
- Keep everything inside |x| < {FRAME_X:.0f} and |y| < {FRAME_Y:.0f}, and keep
  nodes from overlapping unless one genuinely contains the other.
- Use the paper's own units and numbers: `items` names each instance, `values`
  gives real magnitudes (bar heights, weights, probabilities). Never invent
  placeholder names like "Item 1" when real ones are given below.
- Give distinct roles distinct tones; neutral is only for scaffolding.
- Labels and the caption use the paper's vocabulary and describe the paper's
  objects, never the picture ("each token is mapped to a vector", not "spheres
  move right"). Never write "scene", "node", "animation", or "stage".
- Tracks: stagger starts across the timeline so the process reads as a
  sequence; every important node should move, glow, or reveal at some point.
- `evidence` quotes or paraphrases the paper sentence that licenses this.
- Set described=false ONLY when the paper never explains this stage; then
  leave nodes and tracks empty and say so in summary.

A worked example of the expected FORMAT (an embedding stage):
{json.dumps(_EXAMPLE_GRAPH, ensure_ascii=False, indent=1)}

The example shows the JSON shape only -- do NOT copy its arrangement. Every
mechanism has its own natural picture, and reusing the example's
row-gate-row template for a different mechanism is wrong. For instance:
- attention: two facing rows with the strongly-attended pairs pulled close or
  bridged by thin capsules; weights in `values`.
- normalization or softmax: one bar row whose heights visibly redistribute
  (animate `scale` or use two rows, raw then normalized).
- positional or periodic structure: a row with a wave in it (children offset
  in y, or a `rotation_z` track on an arc).
- aggregation: many instances converging (`ring` or `arc` collapsing via
  position tracks) into one product.
- recurrence or loops: a `ring` layout the signal travels around
  (`rotation_z` track on the parent).
Pick the picture from THIS stage's mechanism, not from the example.

{_graph_vocabulary()}"""


@traceable(name="compose_scene_graph", run_type="chain")
def compose_scene_graph(
    stage_label: str,
    stage_detail: str,
    algorithm_name: str,
    domain: str,
    context: str,
    process_steps: List[Dict[str, Any]] | None = None,
    worked_example: Dict[str, Any] | None = None,
    llm: Any = None,
) -> MechanismGraph:
    """Compose, normalize, lint, and (once) repair a stage's scene graph."""
    from .paper_visualizer import _structured_llm_call, get_llm
    from .scene_composer import _stage_data_block

    llm = llm or get_llm()
    data_block = _stage_data_block(process_steps, worked_example)
    prompt = (
        f"{GRAPH_RULES}\n"
        f"PAPER: {algorithm_name}\n"
        f"FIELD: {domain}\n"
        f"STAGE: {stage_label}\n"
        f"WHAT THE STAGE DOES: {stage_detail or '(not stated)'}\n\n"
        + (f"{data_block}\n\n" if data_block else "")
        + f"PAPER EXCERPTS:\n{context}\n"
    )
    graph = normalize_graph(_structured_llm_call(llm, prompt, MechanismGraph))

    # The quality gate: deterministic layout review, one repair pass on
    # errors. The repaired graph is only kept if it actually lints better.
    findings = lint_graph(graph)
    if any(f.startswith("ERROR") for f in findings):
        repair_prompt = (
            prompt
            + "\n\nYour previous graph had layout problems:\n"
            + "\n".join(f"- {f}" for f in findings)
            + "\nReturn the corrected graph only."
        )
        try:
            repaired = normalize_graph(
                _structured_llm_call(llm, repair_prompt, MechanismGraph)
            )
            if len([f for f in lint_graph(repaired) if f.startswith("ERROR")]) < len(
                [f for f in findings if f.startswith("ERROR")]
            ):
                graph = repaired
        except Exception:
            pass  # keep the original; it is valid, just imperfect

    return graph


def graph_to_dict(graph: MechanismGraph) -> Dict[str, Any]:
    payload = json.loads(graph.model_dump_json())
    payload["graph_schema_version"] = GRAPH_SCHEMA_VERSION
    return payload

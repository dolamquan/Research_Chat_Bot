"""Extract a paper's core algorithm/architecture into a constrained diagram IR.

Pipeline: LLM structured extraction (Pydantic-validated JSON) -> normalize ->
deterministic layered layout (x/y coordinates) -> persist per paper.
The LLM never writes drawing syntax; Mermaid output is derived deterministically.
"""

import json
import logging
import re
from collections import defaultdict
from typing import Any, Dict, List, Literal, Optional

from langsmith import traceable

from .scene_composer import SCENE_SCHEMA_VERSION, compose_mechanism_scene, scene_to_dict
from .scene_graph import compose_scene_graph, graph_to_dict
from pydantic import BaseModel, ValidationError

from app.rag.generator import DEFAULT_MODEL, get_llm
from app.rag.retriever import retrieve, retrieve_document_chunks
from app.storage.article_store import get_article
from app.storage.visualization_store import (
    expansion_content_is_current,
    get_node_expansion,
    set_mechanism_domain,
    get_visualization,
    get_visualization_by_id,
    list_visualizations,
    set_worked_example,
    upsert_node_expansion,
    upsert_visualization,
)


logger = logging.getLogger(__name__)

MAX_VIZ_CHUNKS = 80
MAX_VIZ_CONTEXT_CHARS = 45_000
MAX_NODES = 28
MAX_EDGES = 48
MAX_GROUPS = 8

NODE_W = 180
NODE_H = 48
LAYER_GAP = 130
COLUMN_GAP = 220
GROUP_PADDING = 26
GROUP_LABEL_SPACE = 30

JSON_BLOCK_PATTERN = re.compile(r"```(?:json)?\s*(.*?)```", re.IGNORECASE | re.DOTALL)

NodeKind = Literal[
    "input", "output", "operation", "component", "data", "decision", "loop", "state"
]
EdgeKind = Literal["flow", "data", "residual", "attention", "feedback", "reference"]
DiagramKind = Literal["architecture", "method_flow", "pipeline"]

DIAGRAM_KINDS = ("architecture", "method_flow", "pipeline")


class IRNode(BaseModel):
    id: str
    label: str
    kind: NodeKind
    detail: str
    group: Optional[str]


class IREdge(BaseModel):
    source: str
    target: str
    label: str
    kind: EdgeKind


class IRGroup(BaseModel):
    id: str
    label: str
    repeat: Optional[str]


class DiagramIR(BaseModel):
    title: str
    algorithm_name: str
    diagram_kind: DiagramKind
    summary: str
    key_insight: str
    groups: List[IRGroup]
    nodes: List[IRNode]
    edges: List[IREdge]


class ExpansionStep(BaseModel):
    label: str
    detail: str


# The vocabulary a stage's internal mechanism is described with.
#
# Originally this was a single ML-flavoured list, which was a category error:
# it encoded what neural architectures do rather than what *mechanisms* do, so
# a biology paper had nothing correct to choose and every stage collapsed to
# the same generic triple. It is now a domain-neutral core plus per-domain
# extensions, and the prompt only offers the sets that fit the paper.

CORE_PRIMITIVES = (
    "transport",      # something moves from one place to another
    "transform",      # something is converted into another form
    "combine",        # two or more things merge into one
    "split",          # one thing divides into several
    "gate",           # a condition decides whether it proceeds
    "amplify",        # magnitude increases
    "suppress",       # magnitude decreases or is blocked
    "accumulate",     # builds up over repeated steps
    "cycle",          # repeats
    "compare",        # two things are measured against each other
    "select",         # candidates are scored and only some survive
    "emit",           # a result is produced
)

COMPUTATIONAL_PRIMITIVES = (
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
    "loop_repeat",
)

BIOLOGICAL_PRIMITIVES = (
    "bind",           # molecules or receptors bind
    "upregulate",     # expression or activity increases
    "downregulate",   # expression or activity decreases
    "cascade",        # a signal propagates along a chain
    "differentiate",  # an entity changes type or fate
    "translocate",    # moves between compartments
    "population_shift",  # the makeup of a population changes
)

# Used when the paper simply does not describe a stage's internals. Rendering
# an explicit unknown is better than inventing a plausible mechanism.
UNKNOWN_PRIMITIVE = "not_described"

MechanismDomain = Literal["computational", "biological", "general"]

DOMAIN_EXTENSIONS: Dict[str, tuple] = {
    "computational": COMPUTATIONAL_PRIMITIVES,
    "biological": BIOLOGICAL_PRIMITIVES,
    "general": (),
}

ProcessPrimitive = Literal[
    # core
    "transport", "transform", "combine", "split", "gate", "amplify",
    "suppress", "accumulate", "cycle", "compare", "select", "emit",
    # computational
    "token_stream", "vector_array", "matrix_transform", "attention_links",
    "split_parallel", "merge_parallel", "elementwise_combine", "nonlinearity",
    "normalize", "distribution", "filter_select", "loop_repeat",
    # biological
    "bind", "upregulate", "downregulate", "cascade", "differentiate",
    "translocate", "population_shift",
    # neither described nor inferable
    "not_described",
    # retained so storyboards stored before this change still load
    "note",
]


def primitives_for_domain(domain: str) -> tuple:
    """Core plus the extension for this paper's domain, and the unknown marker."""
    extension = DOMAIN_EXTENSIONS.get(domain, ())
    return CORE_PRIMITIVES + extension + (UNKNOWN_PRIMITIVE,)


class ProcessStep(BaseModel):
    """One animatable beat of a component's internal process."""

    primitive: ProcessPrimitive
    caption: str
    items: List[str]
    values: List[float]
    count: int
    label_in: str
    label_out: str
    detail: str


class WorkedExample(BaseModel):
    """One concrete input carried through every stage of the algorithm."""

    input_text: str
    tokens: List[str]
    dimension: str
    output_text: str
    note: str


class NodeExpansionContent(BaseModel):
    overview: str
    mechanism: str
    role: str
    substeps: List[ExpansionStep]
    example: str
    process_steps: List[ProcessStep]


def _string(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _format_context(chunks: List[Dict[str, Any]], max_chars: int = MAX_VIZ_CONTEXT_CHARS) -> str:
    parts: List[str] = []
    total = 0
    for index, chunk in enumerate(chunks, start=1):
        text = _string(chunk.get("text")).strip()
        if not text:
            continue
        title = chunk.get("title") or chunk.get("source") or "Unknown source"
        page = chunk.get("page")
        label = f"[{index}] {title}"
        if page:
            label += f", p.{page}"
        item = f"{label}\n{text}"
        if total + len(item) > max_chars:
            break
        parts.append(item)
        total += len(item)
    return "\n\n".join(parts)


def _article_header(article: Dict[str, Any] | None) -> str:
    if not article:
        return ""
    fields = [
        f"Title: {article.get('title', '')}",
        f"Authors: {', '.join(article.get('authors', [])[:12])}",
        f"Published: {article.get('published_at', '')}",
        f"Domain: {article.get('domain', '')}",
        f"Category: {article.get('category', '')}",
    ]
    abstract = article.get("abstract")
    if abstract:
        fields.append(f"Abstract: {abstract}")
    return "\n".join(field for field in fields if not field.endswith(": "))


def _strip_json_fence(text: str) -> str:
    match = JSON_BLOCK_PATTERN.search(text.strip())
    return match.group(1).strip() if match else text.strip()


def normalize_ir(ir: DiagramIR) -> DiagramIR:
    """Forgiving post-pass: dedupe ids, drop dangling references, cap sizes."""
    seen_ids: set[str] = set()
    nodes: List[IRNode] = []
    for node in ir.nodes[:MAX_NODES]:
        node_id = node.id.strip()
        if not node_id or node_id in seen_ids:
            continue
        seen_ids.add(node_id)
        node.id = node_id
        node.label = node.label.strip()[:60] or node_id
        nodes.append(node)

    group_ids = set()
    groups: List[IRGroup] = []
    for group in ir.groups[:MAX_GROUPS]:
        group_id = group.id.strip()
        if not group_id or group_id in group_ids:
            continue
        group_ids.add(group_id)
        group.id = group_id
        groups.append(group)

    for node in nodes:
        if node.group and node.group not in group_ids:
            node.group = None

    # Drop groups with fewer than 2 members back to ungrouped.
    member_counts: Dict[str, int] = defaultdict(int)
    for node in nodes:
        if node.group:
            member_counts[node.group] += 1
    kept_groups = [group for group in groups if member_counts[group.id] >= 2]
    kept_group_ids = {group.id for group in kept_groups}
    for node in nodes:
        if node.group and node.group not in kept_group_ids:
            node.group = None

    edges: List[IREdge] = []
    seen_edges: set[tuple[str, str, str]] = set()
    for edge in ir.edges[:MAX_EDGES]:
        source = edge.source.strip()
        target = edge.target.strip()
        if source not in seen_ids or target not in seen_ids:
            continue
        if source == target and edge.kind == "flow":
            continue
        key = (source, target, edge.kind)
        if key in seen_edges:
            continue
        seen_edges.add(key)
        edge.source = source
        edge.target = target
        edges.append(edge)

    ir.nodes = nodes
    ir.groups = kept_groups
    ir.edges = edges
    return ir


def _build_extraction_prompt(header: str, context: str, diagram_kind: str) -> str:
    if diagram_kind in DIAGRAM_KINDS:
        kind_rule = f'Set diagram_kind to "{diagram_kind}".'
    else:
        kind_rule = (
            'Choose diagram_kind yourself: "architecture" for papers proposing a '
            'model or system architecture, "method_flow" for papers whose core '
            'contribution is an algorithm or training/inference procedure, '
            '"pipeline" for multi-stage systems.'
        )

    return f"""You are extracting the core algorithm/architecture of a research paper into a strict diagram intermediate representation.

First identify the paper's own core method (algorithm_name), then decompose it into nodes and edges.

{kind_rule}

Rules:
- Nodes are components/steps of the paper's OWN proposed method, not related work or baselines.
- Use 8-20 nodes. Node ids are short snake_case and unique. Labels are at most 60 characters.
- Each node's detail is 1-3 sentences grounded ONLY in the provided context. Do not invent claims.
- For repeated blocks (e.g. stacked layers), create ONE group with repeat set (e.g. "x N layers") containing the block's nodes once - never duplicate the nodes.
- A node's group must be null or the id of a defined group. Only use groups when they clarify structure.
- Every edge's source and target must be defined node ids. Use edge kind "flow" for main data/control flow, "residual" for skip connections, "attention" for attention links, "feedback" for loops back to earlier steps, "data" for auxiliary data inputs, "reference" for weak/annotation links.
- summary is 2-4 sentences describing the method. key_insight is the single idea that makes the method work.

Paper metadata:
{header}

Paper context:
{context}
"""


def _structured_llm_call(llm: Any, prompt: str, model_cls: type) -> Any:
    """Structured-output call with a plain-JSON fallback and one validation retry."""
    try:
        structured_llm = llm.with_structured_output(model_cls, method="json_schema")
        result = structured_llm.invoke(prompt)
        if result is not None:
            return result
    except Exception as error:
        # The exception text is the only way to tell "provider lacks strict
        # mode" from "our schema is strict-mode illegal"; don't discard it.
        logger.warning(
            "strict structured output unavailable for %s, falling back to "
            "plain JSON: %s",
            model_cls.__name__,
            error,
        )

    schema_hint = json.dumps(model_cls.model_json_schema(), ensure_ascii=False)
    fallback_prompt = (
        prompt
        + "\n\nReturn ONLY a JSON object matching this JSON schema, without markdown fences:\n"
        + schema_hint
    )
    raw = llm.invoke(fallback_prompt)
    text = raw.content if hasattr(raw, "content") else str(raw)
    try:
        return model_cls.model_validate_json(_strip_json_fence(_string(text)))
    except ValidationError as error:
        retry = llm.invoke(
            fallback_prompt
            + f"\n\nYour previous output failed validation:\n{error}\n\nFix it and return ONLY valid JSON."
        )
        retry_text = retry.content if hasattr(retry, "content") else str(retry)
        try:
            return model_cls.model_validate_json(_strip_json_fence(_string(retry_text)))
        except ValidationError as retry_error:
            raise ValueError(
                f"LLM could not produce valid structured output: {retry_error}"
            ) from retry_error


@traceable(name="extract_diagram_ir", run_type="chain")
def extract_diagram_ir(
    article: Dict[str, Any] | None,
    chunks: List[Dict[str, Any]],
    diagram_kind: str = "auto",
    llm: Any = None,
) -> DiagramIR:
    if not chunks and not article:
        raise ValueError("No paper context found to visualize")

    llm = llm or get_llm(temperature=0)
    prompt = _build_extraction_prompt(
        header=_article_header(article),
        context=_format_context(chunks),
        diagram_kind=diagram_kind,
    )

    ir = _structured_llm_call(llm, prompt, DiagramIR)
    ir = normalize_ir(ir)
    if len(ir.nodes) < 2:
        raise ValueError("Extracted diagram has too few valid nodes to visualize")
    return ir


def _break_cycles(node_ids: List[str], edges: List[IREdge]) -> set[int]:
    """Return indices of back edges found via iterative DFS (excluded from layering)."""
    adjacency: Dict[str, List[tuple[str, int]]] = defaultdict(list)
    for index, edge in enumerate(edges):
        adjacency[edge.source].append((edge.target, index))

    WHITE, GRAY, BLACK = 0, 1, 2
    color = {node_id: WHITE for node_id in node_ids}
    back_edges: set[int] = set()

    in_degree = {node_id: 0 for node_id in node_ids}
    for edge in edges:
        in_degree[edge.target] += 1
    roots = [node_id for node_id in node_ids if in_degree[node_id] == 0] or node_ids[:1]

    for root in [*roots, *node_ids]:
        if color[root] != WHITE:
            continue
        stack: List[tuple[str, int]] = [(root, 0)]
        color[root] = GRAY
        while stack:
            node_id, child_index = stack[-1]
            children = adjacency[node_id]
            if child_index >= len(children):
                color[node_id] = BLACK
                stack.pop()
                continue
            stack[-1] = (node_id, child_index + 1)
            target, edge_index = children[child_index]
            if color[target] == GRAY:
                back_edges.add(edge_index)
            elif color[target] == WHITE:
                color[target] = GRAY
                stack.append((target, 0))
    return back_edges


def layout_ir(ir: DiagramIR) -> Dict[str, Any]:
    """Deterministic layered (Sugiyama-lite) layout. Returns JSON-ready diagram."""
    node_ids = [node.id for node in ir.nodes]
    back_edges = _break_cycles(node_ids, ir.edges)
    forward_edges = [
        edge for index, edge in enumerate(ir.edges) if index not in back_edges
    ]

    # Layer assignment: longest path from sources (Kahn over forward edges).
    successors: Dict[str, List[str]] = defaultdict(list)
    in_degree = {node_id: 0 for node_id in node_ids}
    for edge in forward_edges:
        successors[edge.source].append(edge.target)
        in_degree[edge.target] += 1

    layer = {node_id: 0 for node_id in node_ids}
    queue = [node_id for node_id in node_ids if in_degree[node_id] == 0]
    remaining = dict(in_degree)
    while queue:
        node_id = queue.pop(0)
        for target in successors[node_id]:
            layer[target] = max(layer[target], layer[node_id] + 1)
            remaining[target] -= 1
            if remaining[target] == 0:
                queue.append(target)

    # Within-layer ordering: stable sort by (group, predecessor barycenter, id), 2 sweeps.
    predecessors: Dict[str, List[str]] = defaultdict(list)
    for edge in forward_edges:
        predecessors[edge.target].append(edge.source)

    layers: Dict[int, List[str]] = defaultdict(list)
    for node_id in node_ids:
        layers[layer[node_id]].append(node_id)

    group_order = {group.id: index for index, group in enumerate(ir.groups)}
    node_group = {node.id: node.group for node in ir.nodes}
    position: Dict[str, int] = {}
    for layer_index in sorted(layers):
        for order, node_id in enumerate(layers[layer_index]):
            position[node_id] = order

    for _ in range(2):
        for layer_index in sorted(layers):
            members = layers[layer_index]

            def sort_key(node_id: str) -> tuple:
                preds = predecessors[node_id]
                barycenter = (
                    sum(position.get(pred, 0) for pred in preds) / len(preds)
                    if preds
                    else position.get(node_id, 0)
                )
                group_id = node_group.get(node_id)
                return (
                    group_order.get(group_id, -1) if group_id else -1,
                    barycenter,
                    node_id,
                )

            members.sort(key=sort_key)
            for order, node_id in enumerate(members):
                position[node_id] = order

    # Coordinates: top-down flow, columns centered per layer.
    coordinates: Dict[str, tuple[float, float]] = {}
    for layer_index, members in layers.items():
        count = len(members)
        for order, node_id in enumerate(members):
            x = (order - (count - 1) / 2) * COLUMN_GAP
            y = layer_index * LAYER_GAP
            coordinates[node_id] = (x, y)

    nodes_json = []
    for node in ir.nodes:
        x, y = coordinates[node.id]
        nodes_json.append(
            {
                "id": node.id,
                "label": node.label,
                "kind": node.kind,
                "detail": node.detail,
                "group": node.group,
                "x": round(x, 1),
                "y": round(y, 1),
                "layer": layer[node.id],
            }
        )

    edges_json = []
    for index, edge in enumerate(ir.edges):
        edges_json.append(
            {
                "source": edge.source,
                "target": edge.target,
                "label": edge.label,
                "kind": edge.kind,
                "back": index in back_edges,
            }
        )

    groups_json = []
    for group in ir.groups:
        member_coords = [
            coordinates[node.id] for node in ir.nodes if node.group == group.id
        ]
        if not member_coords:
            continue
        min_x = min(x for x, _ in member_coords) - NODE_W / 2 - GROUP_PADDING
        max_x = max(x for x, _ in member_coords) + NODE_W / 2 + GROUP_PADDING
        min_y = min(y for _, y in member_coords) - NODE_H / 2 - GROUP_PADDING - GROUP_LABEL_SPACE
        max_y = max(y for _, y in member_coords) + NODE_H / 2 + GROUP_PADDING
        groups_json.append(
            {
                "id": group.id,
                "label": group.label,
                "repeat": group.repeat,
                "x": round(min_x, 1),
                "y": round(min_y, 1),
                "w": round(max_x - min_x, 1),
                "h": round(max_y - min_y, 1),
            }
        )

    return {"nodes": nodes_json, "edges": edges_json, "groups": groups_json}


def _mermaid_label(text: str) -> str:
    return text.replace('"', "'").strip() or "node"


def ir_to_mermaid(ir: DiagramIR) -> str:
    """Deterministic Mermaid flowchart from the IR. No LLM involved."""
    lines = ["flowchart TD"]

    grouped: Dict[str, List[IRNode]] = defaultdict(list)
    ungrouped: List[IRNode] = []
    for node in ir.nodes:
        if node.group:
            grouped[node.group].append(node)
        else:
            ungrouped.append(node)

    def node_line(node: IRNode, indent: str) -> str:
        label = _mermaid_label(node.label)
        if node.kind in ("input", "output"):
            return f'{indent}{node.id}(["{label}"])'
        if node.kind == "decision":
            return f'{indent}{node.id}{{"{label}"}}'
        return f'{indent}{node.id}["{label}"]'

    for group in ir.groups:
        members = grouped.get(group.id)
        if not members:
            continue
        title = _mermaid_label(group.label)
        if group.repeat:
            title += f" ({_mermaid_label(group.repeat)})"
        lines.append(f'    subgraph {group.id}["{title}"]')
        for node in members:
            lines.append(node_line(node, "        "))
        lines.append("    end")

    for node in ungrouped:
        lines.append(node_line(node, "    "))

    for edge in ir.edges:
        arrow = "-.->" if edge.kind in ("feedback", "reference") else "-->"
        if edge.label:
            lines.append(
                f"    {edge.source} {arrow}|{_mermaid_label(edge.label)}| {edge.target}"
            )
        else:
            lines.append(f"    {edge.source} {arrow} {edge.target}")

    return "\n".join(lines)


@traceable(name="generate_paper_visualization", run_type="chain")
def generate_paper_visualization(
    article_id: str,
    diagram_kind: str = "auto",
    force: bool = False,
) -> Dict[str, Any]:
    """Orchestrate: load chunks -> extract IR -> layout -> persist -> return record."""
    article = get_article(article_id)
    document_source = _string(article.get("source")).strip()
    if not document_source:
        raise ValueError("Article has no indexed document source")

    if not force:
        if diagram_kind in DIAGRAM_KINDS:
            existing = get_visualization(article_id, diagram_kind)
            if existing:
                return existing
        else:
            saved = list_visualizations(article_id)
            if saved:
                return saved[0]

    chunks = retrieve_document_chunks(
        document_source=document_source, limit=MAX_VIZ_CHUNKS
    )
    ir = extract_diagram_ir(article, chunks, diagram_kind=diagram_kind)
    diagram = layout_ir(ir)

    return upsert_visualization(
        article_id=article_id,
        document_source=document_source,
        diagram_kind=ir.diagram_kind,
        title=ir.title or article.get("title", ""),
        algorithm_name=ir.algorithm_name,
        diagram=diagram,
        summary=ir.summary,
        key_insight=ir.key_insight,
        model=DEFAULT_MODEL,
        source_count=len(chunks),
    )


@traceable(name="build_worked_example", run_type="chain")
def build_worked_example(
    record: Dict[str, Any],
    article: Dict[str, Any] | None,
    chunks: List[Dict[str, Any]],
    llm: Any = None,
) -> WorkedExample:
    """Invent one small, concrete input to carry through every stage."""
    llm = llm or get_llm(temperature=0)
    prompt = f"""Choose ONE small concrete example input to carry through every stage of this algorithm, so a reader can follow the same data end to end.

Algorithm: {record.get('algorithm_name', '')}
Summary: {record.get('summary', '')}
Stages: {', '.join(node.get('label', '') for node in record.get('diagram', {}).get('nodes', []))}

Rules, grounded in the paper's actual domain:
- input_text: a short, realistic input this algorithm would receive (e.g. a 4-6 word sentence for a language model, a short query for a retrieval system, one small table row for a table method). Keep it under 60 characters.
- tokens: how the algorithm's FIRST stage would break that input into discrete units (4-6 of them). Use the paper's own unit (word-pieces, tokens, sentences, documents, candidates).
- dimension: the paper's main size/shape constant if it states one (e.g. "d_model = 512", "k = 5"); "" if the paper gives none.
- output_text: what this algorithm would plausibly produce for that exact input, per the paper.
- note: one sentence on why this example is representative.

Paper metadata:
{_article_header(article)}

Paper context:
{_format_context(chunks)}
"""
    example = _structured_llm_call(llm, prompt, WorkedExample)
    example.tokens = [token for token in example.tokens if token.strip()][:6]
    return example


def ensure_worked_example(
    record: Dict[str, Any],
    article: Dict[str, Any] | None,
    chunks: List[Dict[str, Any]],
    llm: Any = None,
) -> Dict[str, Any] | None:
    """Return the visualization's stored worked example, generating it once."""
    existing = record.get("worked_example")
    if isinstance(existing, dict) and existing.get("tokens"):
        return existing

    try:
        example = build_worked_example(record, article, chunks, llm=llm).model_dump()
    except Exception:
        return None  # the storyboard is still useful without a shared example

    set_worked_example(record["viz_id"], example)
    record["worked_example"] = example
    return example


def _worked_example_block(example: Dict[str, Any] | None) -> str:
    if not example:
        return ""
    lines = [
        "A single worked example is being carried through EVERY stage of this algorithm.",
        f"Example input: {example.get('input_text', '')}",
        f"Its units/tokens: {', '.join(example.get('tokens') or [])}",
    ]
    if example.get("dimension"):
        lines.append(f"Main dimension: {example['dimension']}")
    if example.get("output_text"):
        lines.append(f"Expected final output: {example['output_text']}")
    lines.append(
        "Use THESE exact units in your process_steps items wherever the step handles "
        "the flowing data, so the reader follows the same example across stages. "
        "Do not invent different placeholder tokens."
    )
    return "\n".join(lines)



class MechanismDomainGuess(BaseModel):
    domain: MechanismDomain
    reason: str


@traceable(name="classify_mechanism_domain", run_type="chain")
def classify_mechanism_domain(
    record: Dict[str, Any],
    article: Dict[str, Any] | None,
    chunks: List[Dict[str, Any]],
    llm: Any = None,
) -> MechanismDomainGuess:
    """Which family of mechanism does this paper's method belong to?

    Decides which vocabulary the storyboards may draw on, so a biology paper is
    never described in terms of matrices and attention.
    """
    llm = llm or get_llm(temperature=0)
    stages = ", ".join(
        node.get("label", "") for node in record.get("diagram", {}).get("nodes", [])
    )
    prompt = f"""Classify the KIND of mechanism this paper's method is, so it can be described with appropriate vocabulary.

Algorithm: {record.get('algorithm_name', '')}
Paper: {record.get('title', '')}
Summary: {record.get('summary', '')}
Stages: {stages}

Choose exactly one:
- "computational": the mechanism is computation over data — neural networks, retrieval, search, optimisation, signal processing, algorithms on data structures.
- "biological": the mechanism is a biological or biochemical process — gene expression, signalling, cell fate, protein interaction, physiology.
- "general": anything else, or a mechanism that does not clearly sit in either (physical systems, economics, a workflow, a mixed method).

Pick "general" rather than forcing a poor fit. reason: one short sentence.

Paper metadata:
{_article_header(article)}

Paper context:
{_format_context(chunks, max_chars=12_000)}
"""
    return _structured_llm_call(llm, prompt, MechanismDomainGuess)


def ensure_mechanism_domain(
    record: Dict[str, Any],
    article: Dict[str, Any] | None,
    chunks: List[Dict[str, Any]],
    llm: Any = None,
) -> str:
    """The paper's stored mechanism domain, classified once."""
    existing = _string(record.get("mechanism_domain")).strip()
    if existing in DOMAIN_EXTENSIONS:
        return existing

    try:
        guess = classify_mechanism_domain(record, article, chunks, llm=llm)
        domain = guess.domain
    except Exception:
        # A failed classification must not block the storyboard; the neutral
        # core alone still describes any mechanism.
        return "general"

    # The domain is a property of the paper, so a classification triggered
    # through a variant persists onto the root visualization -- the variants
    # table has no mechanism_domain column, and writing to the variant id
    # would silently update zero rows.
    viz_id = record.get("viz_id") or record.get("root_viz_id")
    if viz_id:
        try:
            set_mechanism_domain(viz_id, domain)
        except Exception:
            pass
    record["mechanism_domain"] = domain
    return domain

def _node_neighborhood(diagram: Dict[str, Any], node_id: str) -> str:
    """Describe a node's incoming/outgoing edges for the expansion prompt."""
    labels = {node["id"]: node["label"] for node in diagram.get("nodes", [])}
    lines: List[str] = []
    for edge in diagram.get("edges", []):
        connector = f" ({edge['label']})" if edge.get("label") else ""
        if edge.get("target") == node_id:
            lines.append(f"- receives {edge.get('kind', 'flow')}{connector} from \"{labels.get(edge.get('source'), edge.get('source'))}\"")
        elif edge.get("source") == node_id:
            lines.append(f"- sends {edge.get('kind', 'flow')}{connector} to \"{labels.get(edge.get('target'), edge.get('target'))}\"")
    return "\n".join(lines) or "- no connections recorded"


PRIMITIVE_HELP: Dict[str, str] = {
    # core — describe any mechanism
    "transport": "something moves from one place or stage to another",
    "transform": "something is converted into a different form",
    "combine": "two or more things merge into one",
    "split": "one thing divides into several",
    "gate": "a condition or threshold decides whether it proceeds",
    "amplify": "a quantity increases",
    "suppress": "a quantity is reduced or blocked",
    "accumulate": "something builds up over repeated steps",
    "cycle": "the preceding steps repeat",
    "compare": "two things are measured against each other",
    "select": "candidates are scored and only some survive",
    "emit": "a final result is produced",
    # computational
    "token_stream": "discrete items (tokens, documents, candidates) flow through",
    "vector_array": "a set of vectors or embeddings, shown as columns of cells",
    "matrix_transform": "data passes through a learned matrix, projection or layer",
    "attention_links": "elements exchange information via weighted pairwise links",
    "split_parallel": "one stream splits into parallel branches such as heads",
    "merge_parallel": "parallel branches recombine",
    "elementwise_combine": "two inputs combine element-wise",
    "nonlinearity": "values pass through an activation or gate",
    "normalize": "values are rescaled to a standard range",
    "distribution": "a probability or score distribution over options appears",
    "filter_select": "candidates are scored and only some survive",
    "loop_repeat": "the preceding steps repeat",
    # biological
    "bind": "molecules, receptors or factors bind to each other",
    "upregulate": "expression or activity of something increases",
    "downregulate": "expression or activity of something decreases",
    "cascade": "a signal propagates along a chain of intermediates",
    "differentiate": "a cell or entity changes type or fate",
    "translocate": "something moves between compartments or locations",
    "population_shift": "the composition of a population changes",
    "not_described": "the paper does not describe this stage's internals",
}


def _primitive_menu(domain: str) -> str:
    lines = []
    for name in primitives_for_domain(domain):
        lines.append(f"  * {name} - {PRIMITIVE_HELP.get(name, '')}")
    return "\n".join(lines)


def _build_expansion_prompt(
    record: Dict[str, Any],
    node: Dict[str, Any],
    article: Dict[str, Any] | None,
    chunks: List[Dict[str, Any]],
    worked_example: Dict[str, Any] | None = None,
    domain: str = "general",
) -> str:
    example_block = _worked_example_block(worked_example)
    return f"""You are writing a focused deep-dive explanation of ONE component of a research paper's algorithm, for a reader who clicked on that component in a diagram.

Algorithm: {record.get('algorithm_name', '')}
Paper: {record.get('title', '')}
Algorithm summary: {record.get('summary', '')}

{example_block}

The component to explain:
- Label: {node.get('label', '')}
- Kind: {node.get('kind', '')}
- Current short description: {node.get('detail', '')}
- Connections in the diagram:
{_node_neighborhood(record.get('diagram', {}), node.get('id', ''))}

Write, grounded ONLY in the provided paper context (do not invent claims):
- overview: what this component is and why the paper needs it (2-3 sentences).
- mechanism: how it works internally - the actual computation, procedure, or logic the paper describes (3-6 sentences; include concrete formulas or thresholds from the context when present).
- role: its inputs and outputs and how it connects to the neighboring components above (2-3 sentences).
- substeps: the ordered internal steps of this component as short label + 1-2 sentence detail pairs. Use 2-6 substeps when the component decomposes naturally; use an empty list when it does not.
- example: a concrete worked example or intuitive analogy that makes the mechanism click (2-3 sentences); empty string if nothing grounded is possible.
- process_steps: an animated storyboard of this stage's internal process, as 2-6 ordered steps. Each step uses exactly ONE primitive from the vocabulary below — the vocabulary offered is chosen for this paper's kind of mechanism, so do not reach for terms that are not listed.
{_primitive_menu(domain)}
  For every step: caption = one short sentence narrating the beat (shown while it animates); label_in / label_out = what enters and leaves the step ("" if not meaningful); count = how many things are involved when that is meaningful, else 0; items = 3-6 short concrete names for those things when the paper implies them, else []; detail = the governing rule, formula, gene, molecule or threshold the paper gives for this step, else "".
  If the paper does NOT describe how this stage works internally, emit a single step with primitive "not_described" and say in its caption what the paper does and does not tell us. Do not invent a mechanism to fill space, and never use a primitive from another field to approximate one.
  Order the steps as things actually happen.
  Also fill "values" with concrete numbers whenever the step displays magnitudes, so the animation shows real data instead of placeholders:
  * distribution - the probabilities/scores, one per item, summing to about 1.0 (e.g. [0.62, 0.21, 0.11, 0.06]).
  * attention_links - the attention weights FROM the most interesting query unit TO each unit of the worked example, one per unit, summing to about 1.0. Put the units in "items".
  * vector_array - a few representative component values of one embedding, in roughly -1..1 (e.g. [0.42, -0.13, 0.87, -0.55]).
  * nonlinearity - the pre-activation values including some negatives so the reader sees which get clipped or squashed (e.g. [1.2, -0.8, 0.4, -1.5, 0.9]).
  * normalize - the values BEFORE normalizing (any scale), so the animation can show them being rescaled.
  * filter_select - a score per candidate, with "items" naming the candidates.
  Leave "values" as [] for primitives where magnitudes are not meaningful. Keep every list at most 8 numbers, and make them plausible for this paper rather than round placeholders.

Paper metadata:
{_article_header(article)}

Paper context:
{_format_context(chunks)}
"""



STAGE_CONTEXT_CHUNKS = 30
STAGE_CONTEXT_CHARS = 18_000


def _stage_context(
    record: Dict[str, Any],
    node: Dict[str, Any],
    fallback_chunks: List[Dict[str, Any]],
) -> str:
    """Excerpts about THIS stage, rather than the paper's opening pages.

    `retrieve_document_chunks` returns a document in reading order, and
    `_format_context` fills from the front until it hits its character cap. So
    every stage of a paper was being shown the same thing: title, abstract,
    introduction, related work. A stage described in section 4 had the text
    describing it sitting outside the window entirely, and the model was left
    animating a label with no mechanism behind it -- which is exactly what an
    animation unrelated to its stage looks like.

    Searching the same document semantically, using the stage's own label and
    detail as the query, puts the passages that actually describe it in front
    of the model. Reading order is restored afterwards so the excerpt still
    flows as prose.
    """
    query = " ".join(
        part
        for part in (
            _string(node.get("label")),
            _string(node.get("detail")),
            _string(record.get("diagram", {}).get("title")),
        )
        if part
    ).strip()

    if not query:
        return _format_context(fallback_chunks, max_chars=STAGE_CONTEXT_CHARS)

    try:
        hits = retrieve(
            query=query,
            limit=STAGE_CONTEXT_CHUNKS,
            document_source=record["document_source"],
        )
    except Exception:
        # Retrieval is best-effort: a vector-store hiccup must not cost the
        # user the whole expansion.
        hits = []

    if not hits:
        return _format_context(fallback_chunks, max_chars=STAGE_CONTEXT_CHARS)

    # The store holds near-duplicate chunks for the same passage, so a
    # relevance search returns the best-matching paragraph several times over.
    # Left in, they burn the whole budget restating one sentence, and the model
    # concludes the mechanism is undescribed when in fact it was shown a third
    # of the evidence three times.
    unique: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for chunk in hits:
        text = " ".join(_string(chunk.get("text")).split()).lower()
        if not text:
            continue
        fingerprint = text[:400]
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        unique.append(chunk)
    hits = unique

    hits.sort(
        key=lambda chunk: (
            chunk.get("parent_index") if chunk.get("parent_index") is not None else 0,
            chunk.get("chunk_index") if chunk.get("chunk_index") is not None else 0,
        )
    )
    return _format_context(hits, max_chars=STAGE_CONTEXT_CHARS)


def _expansion_is_current(cached: Dict[str, Any], domain: str = "general") -> bool:
    """False for expansions stored before the current storyboard schema.

    The criteria live in `expansion_content_is_current`, shared with the
    prepared-stages listing so the UI's notion of "ready" cannot drift from
    the regeneration gate's.
    """
    content = cached.get("content") or {}
    return expansion_content_is_current(
        content, allowed_primitives=set(primitives_for_domain(domain))
    )


def _resolve_diagram_record(diagram_id: str) -> Dict[str, Any] | None:
    """A storyboard target may be an original diagram or a modified variant."""
    record = get_visualization_by_id(diagram_id)
    if record is not None:
        return record
    # Imported lazily: variant_store is a sibling storage module and this keeps
    # the dependency one-directional at import time.
    from app.storage.variant_store import get_variant

    variant = get_variant(diagram_id)
    if variant is not None and not _string(variant.get("mechanism_domain")).strip():
        # The variants table has no mechanism_domain column, and the domain is
        # a property of the paper, not of one diagram. Without this, every
        # variant resolved to "general", whose vocabulary excludes the
        # computational primitives -- so every click on a variant node
        # regenerated the expansion and re-classified the domain, forever.
        root = get_visualization_by_id(_string(variant.get("root_viz_id")))
        if root:
            variant["mechanism_domain"] = root.get("mechanism_domain") or ""
    return variant


@traceable(name="expand_diagram_node", run_type="chain")
def expand_node(
    viz_id: str,
    node_id: str,
    force: bool = False,
    llm: Any = None,
) -> Dict[str, Any]:
    """Deep-dive explanation of one diagram node, cached per (viz_id, node_id)."""
    record = _resolve_diagram_record(viz_id)
    if record is None:
        raise ValueError(f"Diagram not found: {viz_id}")

    if not force:
        cached = get_node_expansion(viz_id, node_id)
        stored_domain = _string(record.get("mechanism_domain")).strip() or "general"
        if cached and _expansion_is_current(cached, stored_domain):
            return cached

    node = next(
        (n for n in record.get("diagram", {}).get("nodes", []) if n.get("id") == node_id),
        None,
    )
    if node is None:
        raise ValueError(f"Node not found in diagram: {node_id}")

    try:
        article = get_article(record["article_id"])
    except ValueError:
        article = None
    chunks = retrieve_document_chunks(
        document_source=record["document_source"], limit=MAX_VIZ_CHUNKS
    )

    llm = llm or get_llm(temperature=0)
    worked_example = ensure_worked_example(record, article, chunks, llm=llm)
    # Which vocabulary this paper's mechanisms may be described with. Without
    # this, every paper was described in machine-learning terms.
    domain = ensure_mechanism_domain(record, article, chunks, llm=llm)
    prompt = _build_expansion_prompt(
        record,
        node,
        article,
        chunks,
        worked_example=worked_example,
        domain=domain,
    )
    content = _structured_llm_call(llm, prompt, NodeExpansionContent)
    content.substeps = content.substeps[:8]
    content.process_steps = content.process_steps[:7]
    for step in content.process_steps:
        step.items = step.items[:6]
        step.values = [
            value for value in step.values[:8] if isinstance(value, (int, float))
        ]
        step.count = max(0, min(step.count, 24))

    payload = content.model_dump()
    # Marks this expansion as grounded in stage-specific excerpts; older rows
    # lack it and regenerate.
    payload["stage_grounded"] = True
    # Stamped before the composition attempt, deliberately: a compose failure
    # below stores scene=None but still records that this schema version was
    # tried, so a stage that keeps failing regenerates once per schema bump
    # rather than once per click.
    payload["scene_schema_version"] = SCENE_SCHEMA_VERSION

    # Choreograph this stage from scratch rather than mapping it onto one of a
    # fixed set of hand-written scenes. A failure here must not cost the user
    # the explanation they already paid for, so the scene is best-effort and
    # the renderer falls back to the primitive library when it is absent.
    # Both generators below describe this one stage, so both get excerpts
    # chosen for this stage rather than the front of the paper.
    stage_context = _stage_context(record, node, chunks)

    # The fully dynamic tier: a parametric scene graph the model composes
    # freely from geometry primitives and keyframe tracks. Best-effort like
    # the actor scene below; the renderer prefers it and falls back tier by
    # tier (graph -> actor scene -> primitive library) when absent.
    try:
        payload["scene_graph"] = graph_to_dict(
            compose_scene_graph(
                stage_label=node.get("label", ""),
                stage_detail=_string(node.get("detail")) or content.mechanism,
                algorithm_name=_string(record.get("diagram", {}).get("title"))
                or _string(record.get("algorithm_name")),
                domain=domain,
                context=stage_context,
                process_steps=payload["process_steps"],
                worked_example=worked_example,
                llm=llm,
            )
        )
    except Exception:
        payload["scene_graph"] = None

    composed_scene = None
    try:
        payload["scene"] = scene_to_dict(
            compose_mechanism_scene(
                stage_label=node.get("label", ""),
                stage_detail=_string(node.get("detail")) or content.mechanism,
                algorithm_name=_string(record.get("diagram", {}).get("title"))
                or _string(record.get("algorithm_name")),
                domain=domain,
                context=stage_context,
                # The storyboard's own units and numbers, already clamped
                # above; without them the composer invents a second worked
                # example and its actors render as featureless shapes.
                process_steps=payload["process_steps"],
                worked_example=worked_example,
                llm=llm,
            )
        )
        composed_scene = payload["scene"]
    except Exception:
        payload["scene"] = None

    return upsert_node_expansion(
        viz_id=viz_id,
        node_id=node_id,
        node_label=node.get("label", ""),
        content=payload,
        model=DEFAULT_MODEL,
    )

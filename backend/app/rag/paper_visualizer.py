"""Extract a paper's core algorithm/architecture into a constrained diagram IR.

Pipeline: LLM structured extraction (Pydantic-validated JSON) -> normalize ->
deterministic layered layout (x/y coordinates) -> persist per paper.
The LLM never writes drawing syntax; Mermaid output is derived deterministically.
"""

import json
import re
from collections import defaultdict
from typing import Any, Dict, List, Literal, Optional

from langsmith import traceable
from pydantic import BaseModel, ValidationError

from app.rag.generator import DEFAULT_MODEL, get_llm
from app.rag.retriever import retrieve_document_chunks
from app.storage.article_store import get_article
from app.storage.visualization_store import (
    get_node_expansion,
    get_visualization,
    get_visualization_by_id,
    list_visualizations,
    set_worked_example,
    upsert_node_expansion,
    upsert_visualization,
)


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
    "note",
]


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
    except Exception:
        pass

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


def _build_expansion_prompt(
    record: Dict[str, Any],
    node: Dict[str, Any],
    article: Dict[str, Any] | None,
    chunks: List[Dict[str, Any]],
    worked_example: Dict[str, Any] | None = None,
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
- process_steps: an animated storyboard of this component's internal process, as 2-6 ordered steps. Each step uses exactly ONE primitive from this vocabulary (pick the closest match; these drive a 3D animation):
  * token_stream - discrete items (tokens, documents, candidates, samples) flow through. Put 3-6 short concrete example items in "items" when the paper implies them (e.g. example tokens); set count to how many flow.
  * vector_array - a set of vectors/embeddings shown as columns of cells. count = number of vectors; detail = dimension label like "d_model=512" when known.
  * matrix_transform - data passes through a learned matrix/projection/layer. detail = the matrix or layer name (e.g. "W_Q", "FFN W_1").
  * attention_links - elements exchange information via weighted pairwise links. count = number of elements; detail = the scoring formula if given (e.g. "softmax(QK^T/sqrt(d_k))").
  * split_parallel - one stream splits into parallel branches. count = number of branches (e.g. heads).
  * merge_parallel - parallel branches recombine. detail = "concat" or "sum".
  * elementwise_combine - two inputs combine element-wise. detail = the operator ("+", "x", "concat"); label_in = what joins in.
  * nonlinearity - values pass through an activation or gate. detail = the function ("ReLU", "GELU", "sigmoid").
  * normalize - values are rescaled to a standard range. detail = the kind ("LayerNorm", "softmax", "L2 norm").
  * distribution - a probability/score distribution over options appears, optionally with one selected. count = number of bars; items = option labels if concrete.
  * filter_select - candidates are scored and only some survive. count = candidates in; detail = the rule ("top-k", "threshold 0.5").
  * compare - two representations are compared for similarity/relevance. detail = the metric ("cosine", "dot product").
  * loop_repeat - the previous steps repeat. count = iterations if known; detail = what repeats ("per layer", "until converged").
  * note - a plain narration beat with no specific animation.
  For every step: caption = one short sentence narrating the beat (shown while it animates); label_in / label_out = what enters and leaves the step ("" if not meaningful); set unused fields to "" / [] / 0. Order the steps as the data actually moves.
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


def _expansion_is_current(cached: Dict[str, Any]) -> bool:
    """False for expansions stored before the current storyboard schema."""
    content = cached.get("content") or {}
    steps = content.get("process_steps")
    if steps is None:
        return False
    # Storyboards predating concrete `values` are regenerated so animations
    # show real numbers rather than placeholders.
    return all(isinstance(step, dict) and "values" in step for step in steps)


@traceable(name="expand_diagram_node", run_type="chain")
def expand_node(
    viz_id: str,
    node_id: str,
    force: bool = False,
    llm: Any = None,
) -> Dict[str, Any]:
    """Deep-dive explanation of one diagram node, cached per (viz_id, node_id)."""
    if not force:
        cached = get_node_expansion(viz_id, node_id)
        if cached and _expansion_is_current(cached):
            return cached

    record = get_visualization_by_id(viz_id)
    if record is None:
        raise ValueError(f"Visualization not found: {viz_id}")
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
    prompt = _build_expansion_prompt(
        record, node, article, chunks, worked_example=worked_example
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

    return upsert_node_expansion(
        viz_id=viz_id,
        node_id=node_id,
        node_label=node.get("label", ""),
        content=content.model_dump(),
        model=DEFAULT_MODEL,
    )

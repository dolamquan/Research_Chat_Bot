"""Turn a paper's evidence into a validated `AlgorithmScene`.

The model's entire output is data conforming to `AlgorithmScene`; it never
writes code, and nothing it returns is executed. Structured output is used when
the provider supports it, with a JSON fallback and exactly one repair attempt
whose prompt names the specific validation error -- the same shape as
`paper_visualizer._structured_llm_call`, reimplemented here because the scene
path needs provider selection and that function is hardwired to `get_llm()`.

The existing `DiagramIR` for the paper is supplied as structural context rather
than being re-derived, so the scene animates the diagram the user is already
looking at instead of quietly proposing a different architecture. Entity ids
are asked to match diagram node ids wherever they correspond, which is what
lets 2D and 3D highlight the same component.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Sequence

from langsmith import traceable

from app.rag.document_structure import (
    StructuredPaper,
    evidence_candidates,
    select_architecture_evidence,
)
from app.rag.llm_provider import build_chat_model, describe_model
from app.rag.scene_ir import (
    MAX_ENTITIES,
    MAX_STEPS,
    SUPPORTED_PRIMITIVES,
    AlgorithmScene,
    SceneIRError,
    parse_scene,
)

logger = logging.getLogger(__name__)

MAX_DIAGRAM_NODES_IN_PROMPT = 30


class ScenePlanningError(RuntimeError):
    """The model could not produce a scene that validates."""


PRIMITIVE_GUIDE: Dict[str, str] = {
    "token_stream": "a sequence of discrete items flowing in order",
    "vector_array": "a 1-D array of numbers, shown as bars or cells",
    "matrix_transform": "a 2-D array being multiplied or projected",
    "attention_links": "weighted connections between two sets of items",
    "split_parallel": "one input fanning out into parallel branches",
    "merge_parallel": "parallel branches combining back into one",
    "elementwise_combine": "two aligned collections combined position by position",
    "nonlinearity": "a pointwise function applied to every element",
    "normalize": "values rescaled to a common range or unit norm",
    "distribution": "a probability or score distribution over candidates",
    "filter_select": "a subset chosen from a larger candidate set",
    "compare": "two quantities placed side by side and scored",
    "loop_repeat": "a block repeated a stated number of times",
    "data_transfer": "something moving between components or stores",
    "state_transition": "a component changing from one state to another",
    "note": "no mechanism is asserted; the caption stands alone",
}


def _primitive_menu() -> str:
    return "\n".join(f"  - {name}: {help}" for name, help in PRIMITIVE_GUIDE.items())


def _diagram_block(visualization: Dict[str, Any]) -> str:
    """The existing diagram as an id table, so entity ids can line up with it."""
    diagram = visualization.get("diagram") or {}
    nodes = (diagram.get("nodes") or [])[:MAX_DIAGRAM_NODES_IN_PROMPT]
    edges = diagram.get("edges") or []
    if not nodes:
        return "(no existing diagram)"

    lines = ["NODES (id | kind | label):"]
    for node in nodes:
        lines.append(
            f"  {node.get('id', '')} | {node.get('kind', '')} | {node.get('label', '')}"
        )
    known = {n.get("id") for n in nodes}
    edge_lines = [
        f"  {e.get('source')} -> {e.get('target')}"
        for e in edges
        if e.get("source") in known and e.get("target") in known
    ]
    if edge_lines:
        lines.append("EDGES:")
        lines.extend(edge_lines[:40])
    return "\n".join(lines)


def _evidence_block(candidates: Sequence[Dict[str, Any]]) -> str:
    if not candidates:
        return "(no structured evidence available)"
    lines = []
    for candidate in candidates[:24]:
        page = f", p.{candidate['page']}" if candidate.get("page") else ""
        quote = re.sub(r"\s+", " ", str(candidate.get("quote", "")))[:700]
        lines.append(
            f"[{candidate['evidence_id']}] ({candidate.get('section', '')}{page})\n"
            f"  {quote}"
        )
    return "\n".join(lines)


SCENE_RULES = f"""\
You are describing an animation of ONE research paper's proposed method, as
structured data. You are not writing code, and nothing you return is executed.

Visualize only the method this paper PROPOSES. Do not depict related work,
baselines, or prior systems unless the proposed method directly contains them.

Ground everything. Every entity and every step should cite one or more
evidence_ids from the EVIDENCE list below. Use only ids that appear there --
never invent one. If you genuinely cannot support a step, still include it but
leave evidence_ids empty and set confidence below 0.5; it will be shown to the
reader as uncertain. That is far better than citing evidence that does not
support it.

Separate fact from illustration. `values` and `items` may carry a small worked
example so the animation shows something concrete. Keep such examples tiny
(4-8 elements). If the numbers are invented for illustration rather than
reported by the paper, say so in the step's `detail`.

Represent the actual control flow: use `execution` to mark steps that run in
parallel or repeat, and `loop_repeat` with a `count` for iteration.

Choose `visualization_mode` on semantic grounds:
  - "2d"   : the method is a flow of stages; depth would add nothing.
  - "2_5d" : mostly a flow, but with layered or stacked structure worth showing.
  - "3d"   : depth carries real meaning -- tensor depth, layer stacks, parallel
             branches, hierarchy, agents, or spatial data.
Never choose 3d for decoration. If depth encodes nothing, choose 2d.

Entity ids MUST reuse the diagram node ids given below wherever an entity
corresponds to a node, so the 2D and 3D views can highlight the same component.

Budgets: at most {MAX_ENTITIES} entities and {MAX_STEPS} steps. Fewer, clearer
steps are better than exhaustive ones.

PRIMITIVES (choose exactly one per step; no others exist):
{_primitive_menu()}
"""


def _build_prompt(
    visualization: Dict[str, Any],
    article: Dict[str, Any] | None,
    structured_paper: StructuredPaper,
    candidates: Sequence[Dict[str, Any]],
    chunks: Sequence[Dict[str, Any]],
) -> str:
    diagram = visualization.get("diagram") or {}
    title = (
        (article or {}).get("title")
        or diagram.get("title")
        or structured_paper.title
        or "Unknown paper"
    )
    evidence_text = select_architecture_evidence(structured_paper)
    if not evidence_text and chunks:
        # Structure recovery failed entirely; fall back to raw chunk text so the
        # planner still has something method-shaped to read.
        evidence_text = "\n\n".join(
            str(chunk.get("text", ""))[:1500] for chunk in chunks[:8]
        )

    return (
        f"{SCENE_RULES}\n"
        f"PAPER: {title}\n\n"
        f"EXISTING DIAGRAM (reuse these node ids):\n{_diagram_block(visualization)}\n\n"
        f"EVIDENCE (cite these ids):\n{_evidence_block(candidates)}\n\n"
        f"METHOD EXCERPTS:\n{evidence_text}\n"
    )


def _strip_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    return stripped.strip()


def _response_text(response: Any) -> str:
    content = getattr(response, "content", response)
    if isinstance(content, list):
        # Anthropic returns a list of content blocks.
        parts = [
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content
        ]
        return "".join(parts)
    return str(content)


def _structured_scene_call(llm: Any, prompt: str) -> AlgorithmScene:
    """Ask for a scene, preferring structured output, with one repair attempt."""
    try:
        structured = llm.with_structured_output(AlgorithmScene)
        result = structured.invoke(prompt)
        if isinstance(result, AlgorithmScene):
            return result
        if isinstance(result, dict):
            return parse_scene(result)
    except SceneIRError:
        raise
    except Exception:
        # Provider does not support structured output, or the call shape
        # differs. Fall through to plain JSON.
        logger.info("structured output unavailable; falling back to JSON")

    schema = json.dumps(AlgorithmScene.model_json_schema(), ensure_ascii=False)
    json_prompt = (
        prompt
        + "\n\nReturn ONLY a JSON object matching this schema, with no markdown "
        "fences and no commentary:\n"
        + schema
    )
    raw = _response_text(llm.invoke(json_prompt))

    try:
        return parse_scene(json.loads(_strip_fence(raw)))
    except (json.JSONDecodeError, SceneIRError) as first_error:
        repair_prompt = (
            json_prompt
            + f"\n\nYour previous answer was rejected:\n{first_error}\n"
            "Return corrected JSON only. Every id must be unique, and every "
            "referenced entity and evidence id must exist in the same document."
        )
        repaired = _response_text(llm.invoke(repair_prompt))
        try:
            return parse_scene(json.loads(_strip_fence(repaired)))
        except (json.JSONDecodeError, SceneIRError) as second_error:
            raise ScenePlanningError(
                f"The model could not produce a valid scene: {second_error}"
            ) from second_error


def _attach_evidence_text(
    scene: AlgorithmScene, candidates: Sequence[Dict[str, Any]]
) -> AlgorithmScene:
    """Fill quote/section/page from the candidate list the model was shown.

    The model only needs to emit ids; the authoritative text comes from what we
    supplied. That removes any opportunity to paraphrase a quote into something
    the paper did not say.
    """
    by_id = {c["evidence_id"]: c for c in candidates}
    for ref in scene.evidence:
        source = by_id.get(ref.evidence_id)
        if not source:
            continue
        ref.quote = str(source.get("quote", "")) or ref.quote
        ref.section = str(source.get("section", "")) or ref.section
        if source.get("page") is not None:
            ref.page = source["page"]
    return scene


@traceable(name="generate_algorithm_scene", run_type="chain")
def generate_algorithm_scene(
    visualization: Dict[str, Any],
    article: Dict[str, Any] | None,
    structured_paper: StructuredPaper,
    chunks: Sequence[Dict[str, Any]] | None = None,
    llm: Any = None,
    force: bool = False,
    provider: str | None = None,
    model: str | None = None,
) -> tuple[AlgorithmScene, Dict[str, str]]:
    """Plan a scene for one paper.

    Returns the scene together with the provider/model that produced it, so the
    record can say how it was made. `force` is accepted for symmetry with the
    other generators and to let callers bypass caching upstream; planning
    itself holds no cache.
    """
    chunks = list(chunks or [])
    candidates = evidence_candidates(structured_paper)
    prompt = _build_prompt(visualization, article, structured_paper, candidates, chunks)

    client = llm or build_chat_model(provider=provider, model=model, temperature=0)
    scene = _structured_scene_call(client, prompt)

    # Drop citations to ids we never offered: the model occasionally invents
    # one, and an unresolvable citation is worse than an honest gap.
    offered = {c["evidence_id"] for c in candidates}
    known = {ref.evidence_id for ref in scene.evidence} & offered
    for entity in scene.entities:
        entity.evidence_ids = [e for e in entity.evidence_ids if e in known]
    for step in scene.steps:
        step.evidence_ids = [e for e in step.evidence_ids if e in known]
    scene.evidence = [ref for ref in scene.evidence if ref.evidence_id in known]

    scene = _attach_evidence_text(scene, candidates)

    if not scene.algorithm_name:
        scene.algorithm_name = (
            (visualization.get("diagram") or {}).get("title")
            or (article or {}).get("title")
            or "Proposed method"
        )

    return scene, describe_model(client, provider)


def scene_from_process_steps(
    visualization: Dict[str, Any],
    expansions: Sequence[Dict[str, Any]],
) -> AlgorithmScene:
    """Build a scene from already-stored `process_steps`, without an LLM call.

    Backward compatibility: papers explored before this schema existed already
    have per-node storyboards. Deriving a scene from them means the new player
    works on those papers immediately, and gives an offline path for tests.
    Nothing here is grounded in quotes, so every step is left uncited and the
    verifier will correctly flag the scene as low-confidence.
    """
    from app.rag.scene_ir import (
        AlgorithmScene as _Scene,
        SceneEntity,
        SceneStep,
        normalize_primitive,
    )

    diagram = visualization.get("diagram") or {}
    nodes = diagram.get("nodes") or []

    entities: List[SceneEntity] = []
    for node in nodes[:MAX_ENTITIES]:
        entities.append(
            SceneEntity(
                id=str(node.get("id")),
                label=str(node.get("label") or node.get("id")),
                kind=str(node.get("kind") or "component"),
                semantic_role=str(node.get("detail") or "")[:200],
                group=node.get("group"),
                evidence_ids=[],
            )
        )
    known_entities = {entity.id for entity in entities}

    steps: List[SceneStep] = []
    for expansion in expansions:
        node_id = str(expansion.get("node_id") or "")
        content = expansion.get("content") or {}
        for index, raw in enumerate(content.get("process_steps") or []):
            if len(steps) >= MAX_STEPS:
                break
            values = [
                float(v)
                for v in (raw.get("values") or [])
                if isinstance(v, (int, float))
            ]
            steps.append(
                SceneStep(
                    id=f"step_{node_id}_{index}",
                    node_id=node_id or None,
                    primitive=normalize_primitive(str(raw.get("primitive") or "note")),
                    caption=str(raw.get("caption") or "")[:400],
                    detail=str(raw.get("detail") or "")[:600],
                    items=[str(i) for i in (raw.get("items") or [])][:8],
                    values=values[:8],
                    count=int(raw.get("count") or 0),
                    label_in=str(raw.get("label_in") or ""),
                    label_out=str(raw.get("label_out") or ""),
                    input_ids=[node_id] if node_id in known_entities else [],
                    output_ids=[],
                    execution="sequential",
                    duration_ms=1200,
                    evidence_ids=[],
                    confidence=0.3,
                )
            )

    return _Scene(
        schema_version="1.0",
        title=str(diagram.get("title") or ""),
        algorithm_name=str(diagram.get("title") or ""),
        visualization_mode="2d",
        summary=(
            "Derived from stored per-node storyboards, which carry no paper "
            "citations. Treat every step as unverified."
        ),
        entities=entities,
        evidence=[],
        steps=steps,
        camera_cues=[],
    )

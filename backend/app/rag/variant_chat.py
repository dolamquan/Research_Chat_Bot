"""Conversation about a diagram, or about a modification made to one.

Grounded in four things at once: the algorithm's structure before and after,
the operations that were applied and why, what the structural checks proved,
and the paper itself. The prompt keeps those sources distinct, because the
useful part of this conversation is knowing which claims rest on the paper,
which on a proof about the graph, and which are just inference.
"""

from typing import Any, Dict, List

from langsmith import traceable
from pydantic import BaseModel

from app.rag.diagram_mutator import id_table, ir_from_record
from app.rag.generator import DEFAULT_MODEL, get_llm
from app.rag.paper_visualizer import (
    DiagramIR,
    _format_context,
    _structured_llm_call,
)
from app.rag.variant_lab import _paper_context, resolve_target
from app.storage.variant_store import (
    append_message,
    clear_messages,
    latest_run,
    list_messages,
)


MAX_DISCUSSION_CONTEXT_CHARS = 18_000
HISTORY_TURNS = 8


class DiscussionReply(BaseModel):
    answer: str
    referenced_node_ids: List[str]
    suggested_questions: List[str]


def _ops_block(record: Dict[str, Any], kind: str) -> str:
    """What the modification actually did."""
    if kind != "variant":
        return (
            "This is the original algorithm as published. "
            "Nothing has been modified yet."
        )

    patch = record.get("patch") or {}
    result = record.get("patch_result") or {}
    lines = [
        f"Requested change: {record.get('intent', '')}",
        f"Variant name: {record.get('variant_title', '')}",
    ]
    if patch.get("rationale"):
        lines.append(f"Stated rationale: {patch['rationale']}")
    if patch.get("expected_effect"):
        lines.append(f"Expected effect: {patch['expected_effect']}")
    if patch.get("risks"):
        lines.append(f"Risks flagged when it was proposed: {patch['risks']}")

    applied = result.get("applied") or []
    if applied:
        lines.append("Operations applied:")
        for item in applied:
            intent = (item.get("op") or {}).get("intent", "")
            lines.append(f"  - {item.get('summary', '')} :: {intent}")
            for derived in item.get("derived_edges") or []:
                lines.append(f"      (bridging edge {derived} was added automatically)")

    refused = [op for op in (result.get("rejected") or []) if not op.get("redundant")]
    if refused:
        lines.append("Operations that were refused:")
        for item in refused:
            lines.append(
                f"  - {(item.get('op') or {}).get('op', '')}: {item.get('reason', '')}"
            )

    for label, key in (
        ("Stages changed", "changed_node_ids"),
        ("Stages removed", "removed_node_ids"),
    ):
        values = result.get(key) or []
        if values:
            lines.append(f"{label}: {', '.join(values)}")
    return "\n".join(lines)


def _findings_block(report: Dict[str, Any] | None) -> str:
    if not report:
        return "This has not been verified yet."

    findings = report.get("findings") or []
    caused = [item for item in findings if not item.get("inherited")]
    inherited = [item for item in findings if item.get("inherited")]

    lines = [
        f"Verdict (computed from the checks, never asserted by a model): "
        f"{report.get('verdict')}",
        f"Summary: {report.get('headline')}",
    ]
    if caused:
        lines.append("Problems this modification introduced:")
        for item in caused:
            basis = (
                "proved by a structural check"
                if item.get("basis") == "deterministic"
                else "model judgment, not a proof"
            )
            lines.append(
                f"  - [{item.get('severity')}, {basis}] {item.get('title')}: "
                f"{item.get('failure_scenario')}"
            )
    else:
        lines.append(
            "The structural checks found no problems introduced by this modification."
        )

    if inherited:
        lines.append(
            "Problems the ORIGINAL diagram already had, which this change did not cause:"
        )
        for item in inherited:
            lines.append(f"  - [{item.get('severity')}] {item.get('title')}")

    delta = report.get("structural_delta") or {}
    shape = ", ".join(
        f"{key} {value.get('before')}->{value.get('after')}"
        for key, value in delta.items()
        if isinstance(value, dict)
    )
    if shape:
        lines.append(f"Shape change: {shape}")
    return "\n".join(lines)


def _build_prompt(
    record: Dict[str, Any],
    kind: str,
    parent_ir: DiagramIR,
    variant_ir: DiagramIR,
    report: Dict[str, Any] | None,
    chunks: List[Dict[str, Any]],
    history: List[Dict[str, Any]],
    message: str,
) -> str:
    transcript = (
        "\n".join(
            f"{item['role'].upper()}: {item['content']}"
            for item in history[-HISTORY_TURNS:]
        )
        or "(this is the first message)"
    )

    label = "modified variant" if kind == "variant" else "as published"
    diagram_section = f"CURRENT ALGORITHM ({label}):\n{id_table(variant_ir)}"
    if kind == "variant":
        diagram_section += (
            "\n\nTHE ALGORITHM IT WAS MODIFIED FROM:\n" + id_table(parent_ir)
        )

    rules = """How to answer:
- Be specific to THIS algorithm and THIS change. Name stages by their labels.
- Keep three things distinct and say which one you are doing: what the paper states, what the structural checks proved, and what is your own inference.
- NEVER claim the modification is correct, will work, or is publishable. That is not knowable from here. Discuss consequences, trade-offs, what would have to be true for it to work, and what evidence would settle it.
- If the checks found nothing, say so plainly but do not present it as validation. A structurally coherent algorithm can still be a bad idea; say what would make this one bad.
- When you do not know, say so, and name what would have to be measured or read to find out.
- Be concise: at most 2-4 short paragraphs. No headings. Use a list only if the answer genuinely is one.
- referenced_node_ids: at most 3 ids, only the stages your answer is genuinely centred on. These become clickable chips that focus a stage in the diagram, so listing every stage you mentioned in passing makes them useless. Empty list is correct when the answer is about the algorithm as a whole.
- suggested_questions: up to 3 short follow-ups specific to this change. Not generic."""

    return f"""You are a research collaborator discussing a modification a researcher is making to a published algorithm. Answer their question.

Algorithm: {record.get('algorithm_name', '')}
Paper: {record.get('title', '')}
Summary: {record.get('summary', '')}

{diagram_section}

WHAT WAS CHANGED:
{_ops_block(record, kind)}

WHAT THE CHECKS FOUND:
{_findings_block(report)}

{rules}

Paper context:
{_format_context(chunks, max_chars=MAX_DISCUSSION_CONTEXT_CHARS)}

Conversation so far:
{transcript}

Their question: {message}
"""


@traceable(name="discuss_change", run_type="chain")
def discuss_change(target_id: str, message: str) -> Dict[str, Any]:
    """Answer a question about a diagram or a modification to it."""
    question = message.strip()
    if not question:
        raise ValueError("Ask a question about the change")

    record, kind = resolve_target(target_id)
    variant_ir = ir_from_record(record)

    parent_ir = variant_ir
    if kind == "variant":
        parent_id = record.get("parent_variant_id") or record["root_viz_id"]
        try:
            parent_record, _ = resolve_target(parent_id)
            parent_ir = ir_from_record(parent_record)
        except ValueError:
            parent_ir = variant_ir

    run = latest_run(target_id)
    report = (run or {}).get("report")
    _, chunks = _paper_context(record)
    history = list_messages(target_id)

    # Persist the question before answering, so a failed reply still leaves a
    # readable transcript rather than losing what was asked.
    append_message(target_id=target_id, role="user", content=question)

    prompt = _build_prompt(
        record, kind, parent_ir, variant_ir, report, chunks, history, question
    )
    reply = _structured_llm_call(get_llm(temperature=0.2), prompt, DiscussionReply)

    # Drop invented ids so a chip can never point at a stage that isn't there.
    valid_ids = {node.id for node in variant_ir.nodes} | {
        node.id for node in parent_ir.nodes
    }
    # Capped as well as filtered: an answer "about" seven of eight stages gives
    # the reader nothing to click.
    referenced = [
        node_id for node_id in reply.referenced_node_ids if node_id in valid_ids
    ][:3]

    stored = append_message(
        target_id=target_id,
        role="assistant",
        content=reply.answer,
        node_ids=referenced,
        suggestions=[q for q in reply.suggested_questions if q.strip()][:3],
        model=DEFAULT_MODEL,
    )
    return {"message": stored, "history": list_messages(target_id)}


def discussion_history(target_id: str) -> List[Dict[str, Any]]:
    return list_messages(target_id)


def reset_discussion(target_id: str) -> int:
    return clear_messages(target_id)

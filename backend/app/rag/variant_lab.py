"""Orchestration for the variant lab: propose, apply, verify.

Keeps `diagram_mutator` and `variant_verifier` free of storage concerns so both
stay pure and testable. This module is the only place that knows a target may
be either an original visualization or a variant of one.
"""

import time
from typing import Any, Dict, List, Tuple

from langsmith import traceable

from app.rag.diagram_mutator import (
    ModificationPatch,
    PatchResult,
    RawOp,
    apply_patch,
    ir_from_record,
    propose_patch,
    render_diagram,
)
from app.rag.generator import DEFAULT_MODEL
from app.rag.paper_visualizer import MAX_VIZ_CHUNKS, layout_ir
from app.rag.retriever import retrieve_document_chunks
from app.rag.variant_verifier import (
    LayerStatus,
    VerificationReport,
    compute_verdict,
    mark_inherited,
    rank_findings,
    structural_delta,
    structural_findings,
)
from app.storage.article_store import get_article
from app.storage.variant_store import (
    create_run,
    create_variant,
    delete_variants,
    descendant_ids,
    finish_run,
    get_variant,
    latest_run,
    lineage_of,
    list_variants_for_visualization,
)
from app.storage.visualization_store import (
    copy_node_expansions,
    delete_node_expansions,
    get_visualization_by_id,
)


def resolve_target(target_id: str) -> Tuple[Dict[str, Any], str]:
    """Load a diagram by id, whether it is an original or a variant."""
    record = get_visualization_by_id(target_id)
    if record is not None:
        record = dict(record)
        record.setdefault("record_kind", "visualization")
        return record, "visualization"

    variant = get_variant(target_id)
    if variant is not None:
        return variant, "variant"

    raise ValueError(f"Diagram not found: {target_id}")


def _root_viz_id(record: Dict[str, Any], kind: str) -> str:
    return record["viz_id"] if kind == "visualization" else record["root_viz_id"]


def _paper_context(record: Dict[str, Any]) -> Tuple[Dict[str, Any] | None, List[Dict[str, Any]]]:
    try:
        article = get_article(record["article_id"])
    except ValueError:
        article = None
    chunks: List[Dict[str, Any]] = []
    source = record.get("document_source")
    if source:
        try:
            chunks = retrieve_document_chunks(
                document_source=source, limit=MAX_VIZ_CHUNKS
            )
        except Exception:
            chunks = []
    return article, chunks


def _parent_findings(parent_ir) -> List[Any]:
    return structural_findings(parent_ir, layout_ir(parent_ir))


def _assess(
    parent_ir, variant_ir, repairs, target_id: str, target_kind: str, seconds: float
) -> VerificationReport:
    """Layer 0 assessment: deterministic, and blames only what changed."""
    layout = render_diagram(variant_ir)
    findings = rank_findings(
        mark_inherited(
            structural_findings(variant_ir, layout, repairs),
            _parent_findings(parent_ir),
            parent_ir,
            variant_ir,
        )
    )
    verdict, headline = compute_verdict(findings)
    return VerificationReport(
        target_id=target_id,
        target_kind=target_kind,
        verdict=verdict,
        headline=headline,
        findings=findings,
        structural_delta=structural_delta(parent_ir, variant_ir),
        layers=[
            LayerStatus(
                layer="L0",
                status="ok",
                detail="Structural checks over the graph.",
                seconds=round(seconds, 4),
                llm_calls=0,
            )
        ],
        model="",
        total_seconds=round(seconds, 4),
    )


@traceable(name="propose_modification", run_type="chain")
def propose_modification(
    target_id: str, intent: str, max_ops: int = 8
) -> Dict[str, Any]:
    """Turn a request into a reviewable patch. Persists nothing."""
    record, kind = resolve_target(target_id)
    base_ir = ir_from_record(record)
    article, chunks = _paper_context(record)

    patch = propose_patch(
        base_ir, intent, article=article, chunks=chunks, max_ops=max_ops
    )

    started = time.perf_counter()
    result = apply_patch(base_ir, patch.ops)
    if not result.applied:
        reasons = "; ".join(f"{r.op.op}: {r.reason}" for r in result.rejected[:4])
        raise ValueError(
            "None of the proposed operations could be applied — " + (reasons or "no ops")
        )
    report = _assess(
        base_ir, result.ir, result.repairs, target_id, kind, time.perf_counter() - started
    )

    return {
        "base": {
            "id": target_id,
            "record_kind": kind,
            "title": record.get("title", ""),
            "algorithm_name": record.get("algorithm_name", ""),
        },
        "intent": intent,
        "patch": patch.model_dump(),
        "applied": [op.model_dump() for op in result.applied],
        "rejected": [op.model_dump() for op in result.rejected],
        "preview": {
            "diagram": render_diagram(result.ir),
            "changed_node_ids": result.changed_node_ids,
            "removed_node_ids": result.removed_node_ids,
        },
        "report": report.model_dump(),
    }


@traceable(name="apply_modification", run_type="chain")
def apply_modification(
    target_id: str,
    intent: str,
    patch: ModificationPatch,
    drop_op_indices: List[int] | None = None,
) -> Dict[str, Any]:
    """Create a persisted variant. Deterministic — no LLM call.

    Re-applies the patch server-side so any operations the user rejected are
    genuinely honoured rather than trusted from the client.
    """
    record, kind = resolve_target(target_id)
    base_ir = ir_from_record(record)

    dropped = set(drop_op_indices or [])
    kept: List[RawOp] = [
        op for index, op in enumerate(patch.ops) if index not in dropped
    ]
    if not kept:
        raise ValueError("Every operation was rejected; nothing to apply")

    started = time.perf_counter()
    result: PatchResult = apply_patch(base_ir, kept)
    if not result.applied:
        reasons = "; ".join(f"{r.op.op}: {r.reason}" for r in result.rejected[:4])
        raise ValueError("No operation could be applied — " + (reasons or "no ops"))

    variant_ir = result.ir
    diagram = render_diagram(variant_ir)

    variant = create_variant(
        root_viz_id=_root_viz_id(record, kind),
        parent_variant_id=target_id if kind == "variant" else None,
        article_id=record["article_id"],
        document_source=record.get("document_source", ""),
        diagram_kind=variant_ir.diagram_kind,
        title=variant_ir.title,
        algorithm_name=variant_ir.algorithm_name,
        variant_title=patch.variant_title or "Variant",
        diagram=diagram,
        summary=variant_ir.summary,
        key_insight=variant_ir.key_insight,
        worked_example=record.get("worked_example"),
        intent=intent,
        patch=patch.model_dump(),
        patch_result={
            "applied": [op.model_dump() for op in result.applied],
            "rejected": [op.model_dump() for op in result.rejected],
            "repairs": [note.model_dump() for note in result.repairs],
            "changed_node_ids": result.changed_node_ids,
            "removed_node_ids": result.removed_node_ids,
            "structurally_touched_node_ids": result.structurally_touched_node_ids,
        },
        changed_node_ids=result.changed_node_ids,
        depth=int(record.get("depth", 0)) + 1 if kind == "variant" else 1,
        model=DEFAULT_MODEL,
    )

    # Carry storyboards over for stages the patch genuinely left alone. Stages
    # whose neighbourhood changed are omitted so they regenerate rather than
    # animate a mechanism that no longer matches their connections.
    stale = (
        set(result.changed_node_ids)
        | set(result.removed_node_ids)
        | set(result.structurally_touched_node_ids)
    )
    reusable = [node.id for node in variant_ir.nodes if node.id not in stale]
    copied = copy_node_expansions(target_id, variant["variant_id"], reusable)

    report = _assess(
        base_ir,
        variant_ir,
        result.repairs,
        variant["variant_id"],
        "variant",
        time.perf_counter() - started,
    )
    run = _store_report(variant["variant_id"], "variant", report, ["L0"])

    return {
        "variant": variant,
        "patch_result": {
            "applied": [op.model_dump() for op in result.applied],
            "rejected": [op.model_dump() for op in result.rejected],
            "repairs": [note.model_dump() for note in result.repairs],
            "changed_node_ids": result.changed_node_ids,
            "removed_node_ids": result.removed_node_ids,
            "structurally_touched_node_ids": result.structurally_touched_node_ids,
            "storyboards_reused": copied,
        },
        "run": run,
    }


def _store_report(
    target_id: str, target_kind: str, report: VerificationReport, layers: List[str]
) -> Dict[str, Any]:
    run = create_run(
        target_id=target_id,
        target_kind=target_kind,
        layers=layers,
        status="running",
        stage="structural",
        model=report.model,
    )
    caused = [f for f in report.findings if not f.inherited]
    finished = finish_run(
        run["run_id"],
        status="complete",
        report=report.model_dump(),
        verdict=report.verdict,
        finding_count=len(caused),
        blocking_count=sum(1 for f in caused if f.severity == "blocking"),
        layers=[layer.model_dump() for layer in report.layers],
        timings={"total_seconds": report.total_seconds},
        message=report.headline,
    )
    return finished or run


@traceable(name="verify_target", run_type="chain")
def verify_target(target_id: str) -> Dict[str, Any]:
    """Verify a variant, or an original diagram as a calibration control."""
    record, kind = resolve_target(target_id)
    variant_ir = ir_from_record(record)

    started = time.perf_counter()
    if kind == "variant":
        parent_id = record.get("parent_variant_id") or record["root_viz_id"]
        try:
            parent_record, _ = resolve_target(parent_id)
            parent_ir = ir_from_record(parent_record)
        except ValueError:
            parent_ir = variant_ir
        repairs_raw = (record.get("patch_result") or {}).get("repairs") or []
        from app.rag.diagram_mutator import RepairNote

        repairs = [RepairNote(**note) for note in repairs_raw]
    else:
        # Verifying an original against itself: every finding is pre-existing,
        # which is exactly the honest control for "do the checks over-fire?"
        parent_ir = variant_ir
        repairs = []

    report = _assess(
        parent_ir, variant_ir, repairs, target_id, kind, time.perf_counter() - started
    )
    run = _store_report(target_id, kind, report, ["L0"])
    return {"run": run, "report": report.model_dump()}


def variant_tree(root_viz_id: str) -> List[Dict[str, Any]]:
    """Flat lineage rows with the latest verdict, for the lineage UI."""
    rows: List[Dict[str, Any]] = []
    for variant in list_variants_for_visualization(root_viz_id):
        run = latest_run(variant["variant_id"])
        rows.append(
            {
                "variant_id": variant["variant_id"],
                "parent_variant_id": variant["parent_variant_id"],
                "depth": variant["depth"],
                "variant_title": variant["variant_title"],
                "intent": variant["intent"],
                "verdict": (run or {}).get("verdict", ""),
                "blocking_count": (run or {}).get("blocking_count", 0),
                "finding_count": (run or {}).get("finding_count", 0),
                "changed_node_ids": variant["changed_node_ids"],
                "created_at": variant["created_at"],
            }
        )
    return rows


def delete_variant_tree(variant_id: str) -> int:
    """Delete a variant, everything branched from it, and their storyboards."""
    if get_variant(variant_id) is None:
        raise ValueError(f"Variant not found: {variant_id}")
    ids = descendant_ids(variant_id)
    for identifier in ids:
        delete_node_expansions(identifier)
    return delete_variants(ids)


def get_variant_detail(variant_id: str) -> Dict[str, Any]:
    variant = get_variant(variant_id)
    if variant is None:
        raise ValueError(f"Variant not found: {variant_id}")
    parent_id = variant.get("parent_variant_id") or variant["root_viz_id"]
    parent_diagram = None
    try:
        parent_record, _ = resolve_target(parent_id)
        parent_diagram = parent_record.get("diagram")
    except ValueError:
        parent_diagram = None
    run = latest_run(variant_id)
    return {
        "variant": variant,
        "parent": {"id": parent_id, "diagram": parent_diagram},
        "lineage": [
            {
                "variant_id": item["variant_id"],
                "variant_title": item["variant_title"],
                "depth": item["depth"],
            }
            for item in lineage_of(variant_id)
        ],
        "run": run,
    }

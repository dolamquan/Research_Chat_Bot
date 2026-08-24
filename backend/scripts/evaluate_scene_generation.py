"""Evaluate generated scenes against hand-annotated references.

Run against a directory of reference scenes plus the scenes actually generated
for the same papers, and it reports node/edge precision, recall and F1,
grounding ratios, hallucination counts, connectivity, and schema/render
validity.

Deliberately not an LLM judge. Every number here is computed from the graphs
with NetworkX and set arithmetic, so a regression is reproducible and a
disagreement can be traced to a specific node or edge. An LLM judge could be
layered on top later for qualitative questions, but it must not be the only
evaluator: the failures this feature actually had -- entities that do not exist
in the paper, steps consuming data before it is produced -- are all decidable
without one.

Usage:

    python scripts/evaluate_scene_generation.py \
        --references tests/fixtures/scenes \
        --generated  path/to/generated \
        --json-out   eval_report.json

References and generated scenes are matched by filename. A missing generated
scene counts as a total miss rather than being skipped, so partial coverage
cannot flatter the score.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Set, Tuple

# Import from the app package whether or not the backend is installed.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.rag.scene_ir import AlgorithmScene, SceneIRError, parse_scene  # noqa: E402
from app.rag.scene_verifier import verify_scene  # noqa: E402

try:
    import networkx as nx
except ImportError:  # pragma: no cover - optional dependency
    nx = None


def _f1(precision: float, recall: float) -> float:
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def prf(predicted: Set[Any], reference: Set[Any]) -> Dict[str, float]:
    """Precision, recall and F1 for one set against another."""
    if not predicted and not reference:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    true_positive = len(predicted & reference)
    precision = true_positive / len(predicted) if predicted else 0.0
    recall = true_positive / len(reference) if reference else 0.0
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(_f1(precision, recall), 4),
    }


def _normalise(label: str) -> str:
    """Compare entities on a normalised label, not on the model's chosen id.

    Two scenes describing the same architecture will not agree on identifiers,
    so comparing raw ids would report a total mismatch for a correct scene.
    """
    return " ".join(str(label or "").lower().split())


def entity_keys(scene: AlgorithmScene) -> Set[str]:
    return {_normalise(entity.label) for entity in scene.entities if entity.label}


def edge_keys(scene: AlgorithmScene) -> Set[Tuple[str, str]]:
    """Data-flow edges, keyed by normalised endpoint labels."""
    labels = {entity.id: _normalise(entity.label) for entity in scene.entities}
    edges: Set[Tuple[str, str]] = set()
    for step in scene.steps:
        for source in step.input_ids:
            for target in step.output_ids:
                if source in labels and target in labels:
                    edges.add((labels[source], labels[target]))
    return edges


def build_graph(scene: AlgorithmScene):
    if nx is None:
        return None
    graph = nx.DiGraph()
    for entity in scene.entities:
        graph.add_node(entity.id, label=entity.label)
    for step in scene.steps:
        for source in step.input_ids:
            for target in step.output_ids:
                graph.add_edge(source, target, step=step.id)
    return graph


def disconnected_components(scene: AlgorithmScene) -> int:
    """How many pieces the data-flow graph falls into.

    More than one means the scene depicts an algorithm whose parts never meet,
    which is the signature failure of a hallucinated architecture.
    """
    graph = build_graph(scene)
    if graph is None or graph.number_of_nodes() == 0:
        return 0
    return nx.number_weakly_connected_components(graph)


def evaluate_pair(
    reference: AlgorithmScene | None,
    generated: AlgorithmScene | None,
    name: str,
    provider: str = "",
    model: str = "",
    latency_ms: float | None = None,
    token_usage: Dict[str, int] | None = None,
) -> Dict[str, Any]:
    """Compare one generated scene with its reference."""
    row: Dict[str, Any] = {
        "name": name,
        "provider": provider,
        "model": model,
        "latency_ms": latency_ms,
        "token_usage": token_usage or {},
        "schema_valid": generated is not None,
        "render_ready": False,
    }

    if generated is None:
        row.update(
            {
                "nodes": {"precision": 0.0, "recall": 0.0, "f1": 0.0},
                "edges": {"precision": 0.0, "recall": 0.0, "f1": 0.0},
                "grounded_entity_ratio": 0.0,
                "grounded_step_ratio": 0.0,
                "hallucinated_entities": 0,
                "hallucinated_relationships": 0,
                "disconnected_components": 0,
                "verification_valid": False,
                "verification_errors": ["scene_missing_or_invalid"],
            }
        )
        return row

    report = verify_scene(generated)
    # "Render ready" means the compiler will draw every step rather than
    # falling back, and the deterministic checks found no error.
    from app.rag.scene_ir import SUPPORTED_PRIMITIVES

    row["render_ready"] = report.valid and all(
        step.primitive in SUPPORTED_PRIMITIVES for step in generated.steps
    )
    row["grounded_entity_ratio"] = report.grounded_entity_ratio
    row["grounded_step_ratio"] = report.grounded_step_ratio
    row["verification_valid"] = report.valid
    row["verification_errors"] = [f.code for f in report.findings if f.severity == "error"]
    row["disconnected_components"] = disconnected_components(generated)
    row["entity_count"] = report.entity_count
    row["step_count"] = report.step_count

    if reference is None:
        row["nodes"] = None
        row["edges"] = None
        row["hallucinated_entities"] = None
        row["hallucinated_relationships"] = None
        return row

    predicted_nodes = entity_keys(generated)
    reference_nodes = entity_keys(reference)
    predicted_edges = edge_keys(generated)
    reference_edges = edge_keys(reference)

    row["nodes"] = prf(predicted_nodes, reference_nodes)
    row["edges"] = prf(predicted_edges, reference_edges)
    # Anything the generated scene asserts that the reference does not.
    row["hallucinated_entities"] = len(predicted_nodes - reference_nodes)
    row["hallucinated_relationships"] = len(predicted_edges - reference_edges)
    return row


def _load(path: Path) -> AlgorithmScene | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    # A record wrapper from the API is accepted as well as a bare scene.
    if isinstance(payload, dict) and "scene" in payload and "steps" not in payload:
        payload = payload["scene"]
    try:
        return parse_scene(payload)
    except SceneIRError:
        return None


def aggregate(rows: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    rows = list(rows)
    if not rows:
        return {}

    def mean(pick) -> float:
        values = [pick(r) for r in rows if pick(r) is not None]
        return round(sum(values) / len(values), 4) if values else 0.0

    return {
        "papers": len(rows),
        "node_f1": mean(lambda r: (r.get("nodes") or {}).get("f1")),
        "node_precision": mean(lambda r: (r.get("nodes") or {}).get("precision")),
        "node_recall": mean(lambda r: (r.get("nodes") or {}).get("recall")),
        "edge_f1": mean(lambda r: (r.get("edges") or {}).get("f1")),
        "edge_precision": mean(lambda r: (r.get("edges") or {}).get("precision")),
        "edge_recall": mean(lambda r: (r.get("edges") or {}).get("recall")),
        "grounded_entity_ratio": mean(lambda r: r.get("grounded_entity_ratio")),
        "grounded_step_ratio": mean(lambda r: r.get("grounded_step_ratio")),
        "hallucinated_entities_total": sum(
            r.get("hallucinated_entities") or 0 for r in rows
        ),
        "hallucinated_relationships_total": sum(
            r.get("hallucinated_relationships") or 0 for r in rows
        ),
        "multi_component_scenes": sum(
            1 for r in rows if (r.get("disconnected_components") or 0) > 1
        ),
        "schema_valid_rate": mean(lambda r: 1.0 if r.get("schema_valid") else 0.0),
        "render_ready_rate": mean(lambda r: 1.0 if r.get("render_ready") else 0.0),
        "verification_valid_rate": mean(
            lambda r: 1.0 if r.get("verification_valid") else 0.0
        ),
        "mean_latency_ms": mean(lambda r: r.get("latency_ms")),
        "networkx_available": nx is not None,
    }


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--references", type=Path, required=True,
                        help="Directory of hand-annotated reference scenes.")
    parser.add_argument("--generated", type=Path, default=None,
                        help="Directory of generated scenes. Defaults to --references, "
                             "which measures the harness itself (a perfect score).")
    parser.add_argument("--provider", default="", help="Recorded in the report.")
    parser.add_argument("--model", default="", help="Recorded in the report.")
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args(argv)

    if not args.references.is_dir():
        parser.error(f"--references is not a directory: {args.references}")
    generated_dir = args.generated or args.references

    started = time.perf_counter()
    rows: List[Dict[str, Any]] = []
    for reference_path in sorted(args.references.glob("*.json")):
        generated_path = generated_dir / reference_path.name
        rows.append(
            evaluate_pair(
                reference=_load(reference_path),
                generated=_load(generated_path) if generated_path.exists() else None,
                name=reference_path.stem,
                provider=args.provider,
                model=args.model,
            )
        )
    elapsed_ms = (time.perf_counter() - started) * 1000

    summary = aggregate(rows)
    summary["wall_clock_ms"] = round(elapsed_ms, 2)
    report = {"summary": summary, "per_paper": rows}

    print(f"\nScene generation evaluation  ({summary.get('papers', 0)} papers)")
    print("-" * 68)
    for row in rows:
        nodes = row.get("nodes") or {}
        edges = row.get("edges") or {}
        print(
            f"  {row['name'][:32]:34s} "
            f"node F1 {nodes.get('f1', 0):.2f}  "
            f"edge F1 {edges.get('f1', 0):.2f}  "
            f"grounded {row.get('grounded_step_ratio', 0):.0%}  "
            f"{'ok' if row.get('render_ready') else 'NOT RENDERABLE'}"
        )
    print("-" * 68)
    for key in (
        "node_f1", "edge_f1", "grounded_step_ratio", "grounded_entity_ratio",
        "hallucinated_entities_total", "hallucinated_relationships_total",
        "multi_component_scenes", "schema_valid_rate", "render_ready_rate",
    ):
        print(f"  {key:34s} {summary.get(key)}")
    if nx is None:
        print("\n  note: networkx is not installed; connectivity was not computed.")

    if args.json_out:
        args.json_out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\n  wrote {args.json_out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

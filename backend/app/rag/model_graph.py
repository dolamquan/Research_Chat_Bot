"""Scaffolding for comparing a paper-derived diagram against a real model graph.

A paper describes an architecture in prose; a shipped artifact (ONNX, a
TorchScript file, a SavedModel) *is* that architecture. Where both exist, the
strongest available check on a generated scene is whether its topology matches
the graph the authors actually ran.

This module defines the seam for that comparison without taking on the
dependency. Nothing here is required: papers with no released code -- most of
them -- go through the pipeline untouched, and `compare_topology` works on any
adapter that can produce the small dict shape below.

See `docs/PAPER_TO_SCENE.md` for how Netron and Google Model Explorer fit in.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Protocol, runtime_checkable

# The minimal graph shape every adapter returns, so `compare_topology` never
# needs to know which framework produced it:
#
#   {
#     "format": "onnx",
#     "nodes": [{"id": "conv1", "op": "Conv", "label": "conv1"}, ...],
#     "edges": [{"source": "input", "target": "conv1"}, ...],
#   }
ModelGraph = Dict[str, Any]


@runtime_checkable
class ModelGraphAdapter(Protocol):
    """Reads one artifact format into the common graph shape."""

    def supports(self, artifact_path: Path) -> bool:
        """True when this adapter can read the artifact."""
        ...

    def extract_graph(self, artifact_path: Path) -> ModelGraph:
        """Parse the artifact into `ModelGraph`."""
        ...


class OnnxGraphAdapter:
    """ONNX adapter.

    Implemented as far as the seam requires and no further: `supports` is real,
    `extract_graph` raises unless the optional `onnx` package is present. That
    keeps `onnx` out of `requirements.txt` while leaving the integration point
    unambiguous for whoever picks this up.
    """

    format = "onnx"

    def supports(self, artifact_path: Path) -> bool:
        return artifact_path.suffix.lower() == ".onnx"

    def extract_graph(self, artifact_path: Path) -> ModelGraph:
        try:
            import onnx
        except ImportError as error:
            raise NotImplementedError(
                "Reading ONNX graphs requires the optional `onnx` package. "
                "Install it to enable model-graph verification."
            ) from error

        model = onnx.load(str(artifact_path))
        nodes: List[Dict[str, str]] = []
        edges: List[Dict[str, str]] = []
        producers: Dict[str, str] = {}

        for index, node in enumerate(model.graph.node):
            node_id = node.name or f"{node.op_type}_{index}"
            nodes.append({"id": node_id, "op": node.op_type, "label": node_id})
            for output in node.output:
                producers[output] = node_id

        for index, node in enumerate(model.graph.node):
            node_id = node.name or f"{node.op_type}_{index}"
            for value in node.input:
                source = producers.get(value)
                if source and source != node_id:
                    edges.append({"source": source, "target": node_id})

        return {"format": self.format, "nodes": nodes, "edges": edges}


class TorchScriptGraphAdapter:
    """TorchScript / PyTorch artifact adapter (seam only)."""

    format = "torchscript"

    def supports(self, artifact_path: Path) -> bool:
        return artifact_path.suffix.lower() in {".pt", ".pth"}

    def extract_graph(self, artifact_path: Path) -> ModelGraph:
        raise NotImplementedError(
            "TorchScript graph extraction is not implemented. A traced module's "
            "`.graph` can be walked into the ModelGraph shape; see "
            "docs/PAPER_TO_SCENE.md."
        )


class SavedModelGraphAdapter:
    """TensorFlow SavedModel adapter (seam only)."""

    format = "tf_saved_model"

    def supports(self, artifact_path: Path) -> bool:
        return artifact_path.is_dir() and (artifact_path / "saved_model.pb").exists()

    def extract_graph(self, artifact_path: Path) -> ModelGraph:
        raise NotImplementedError(
            "SavedModel graph extraction is not implemented. See "
            "docs/PAPER_TO_SCENE.md."
        )


# Order matters only in that the first adapter claiming an artifact wins.
DEFAULT_ADAPTERS: tuple[ModelGraphAdapter, ...] = (
    OnnxGraphAdapter(),
    TorchScriptGraphAdapter(),
    SavedModelGraphAdapter(),
)


def find_adapter(
    artifact_path: Path, adapters: tuple[ModelGraphAdapter, ...] = DEFAULT_ADAPTERS
) -> ModelGraphAdapter | None:
    """The first adapter that claims this artifact, or None."""
    for adapter in adapters:
        if adapter.supports(artifact_path):
            return adapter
    return None


def compare_topology(scene_graph: ModelGraph, model_graph: ModelGraph) -> Dict[str, Any]:
    """Set-overlap between a paper-derived graph and an artifact's graph.

    Deliberately crude: node labels in a paper diagram and operator names in a
    compiled graph rarely match one-for-one, so this reports overlap and
    difference for a human to read rather than pretending to a verdict. It is
    supporting evidence, never a pass/fail gate.
    """
    scene_nodes = {str(n.get("label") or n.get("id")).lower() for n in scene_graph.get("nodes", [])}
    model_nodes = {str(n.get("label") or n.get("id")).lower() for n in model_graph.get("nodes", [])}
    shared = scene_nodes & model_nodes

    return {
        "scene_node_count": len(scene_nodes),
        "model_node_count": len(model_nodes),
        "shared_node_count": len(shared),
        "only_in_scene": sorted(scene_nodes - model_nodes),
        "only_in_model": sorted(model_nodes - scene_nodes),
        "node_overlap": round(len(shared) / len(scene_nodes), 4) if scene_nodes else 0.0,
        "note": (
            "Names in a paper diagram and operators in a compiled graph seldom "
            "align exactly. Read this as supporting evidence, not a verdict."
        ),
    }


def scene_to_model_graph(scene: Any) -> ModelGraph:
    """Project an `AlgorithmScene` into the common graph shape for comparison."""
    return {
        "format": "algorithm_scene",
        "nodes": [
            {"id": entity.id, "op": entity.kind, "label": entity.label}
            for entity in scene.entities
        ],
        "edges": [
            {"source": source, "target": target}
            for step in scene.steps
            for source in step.input_ids
            for target in step.output_ids
        ],
    }

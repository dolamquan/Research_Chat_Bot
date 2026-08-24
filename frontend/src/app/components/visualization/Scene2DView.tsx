import { useMemo } from "react";

import type { AlgorithmScene, SceneStep } from "./sceneTypes";
import { entityIsUncertain } from "./sceneValidation";

/**
 * The 2D view of a scene, rendered as SVG from the same Scene IR as the 3D view.
 *
 * Entity ids come from the diagram, so the node highlighted here is the same
 * node the 3D player highlights, and switching mode never regenerates or
 * re-plans anything.
 *
 * Layout is computed deterministically by longest-path layering rather than
 * with a layout library: it keeps the dependency surface unchanged, and the
 * graph a scene produces is small and acyclic by construction (the verifier
 * rejects inputs consumed before they are produced). Should scenes grow to the
 * point where this is insufficient, ELK can replace `layoutEntities` alone --
 * everything else here works off its output.
 */

type Placed = {
  id: string;
  label: string;
  x: number;
  y: number;
  layer: number;
  uncertain: boolean;
};

const NODE_W = 132;
const NODE_H = 40;
const GAP_X = 76;
const GAP_Y = 26;

/** Assign each entity to a layer from step order, then space layers evenly. */
export function layoutEntities(scene: AlgorithmScene): {
  nodes: Placed[];
  edges: { from: string; to: string; stepId: string }[];
  width: number;
  height: number;
} {
  const layer = new Map<string, number>();
  for (const entity of scene.entities) layer.set(entity.id, 0);

  // Steps play in order, so an output sits one layer beyond the deepest input.
  for (const step of scene.steps) {
    const deepest = step.input_ids.reduce(
      (acc, id) => Math.max(acc, layer.get(id) ?? 0),
      0,
    );
    for (const id of step.output_ids) {
      layer.set(id, Math.max(layer.get(id) ?? 0, deepest + 1));
    }
  }

  const byLayer = new Map<number, string[]>();
  for (const entity of scene.entities) {
    const index = layer.get(entity.id) ?? 0;
    byLayer.set(index, [...(byLayer.get(index) ?? []), entity.id]);
  }

  const labels = new Map(scene.entities.map((e) => [e.id, e]));
  const nodes: Placed[] = [];
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const tallest = Math.max(1, ...layers.map((l) => (byLayer.get(l) ?? []).length));

  for (const layerIndex of layers) {
    const ids = byLayer.get(layerIndex) ?? [];
    ids.forEach((id, row) => {
      const entity = labels.get(id);
      if (!entity) return;
      const columnHeight = ids.length * NODE_H + (ids.length - 1) * GAP_Y;
      const top = (tallest * (NODE_H + GAP_Y) - columnHeight) / 2;
      nodes.push({
        id,
        label: entity.label,
        x: layerIndex * (NODE_W + GAP_X) + 20,
        y: top + row * (NODE_H + GAP_Y) + 20,
        layer: layerIndex,
        uncertain: entityIsUncertain(entity),
      });
    });
  }

  const edges: { from: string; to: string; stepId: string }[] = [];
  for (const step of scene.steps) {
    for (const from of step.input_ids) {
      for (const to of step.output_ids) {
        edges.push({ from, to, stepId: step.id });
      }
    }
  }

  const width = (Math.max(0, ...layers) + 1) * (NODE_W + GAP_X) + 40;
  const height = tallest * (NODE_H + GAP_Y) + 40;
  return { nodes, edges, width, height };
}

export function Scene2DView({
  scene,
  activeStep,
  selectedEntityId,
  onSelectEntity,
}: {
  scene: AlgorithmScene;
  activeStep: SceneStep | null;
  selectedEntityId: string | null;
  onSelectEntity?: (entityId: string) => void;
}) {
  const { nodes, edges, width, height } = useMemo(() => layoutEntities(scene), [scene]);
  const active = new Set<string>([
    ...(activeStep?.input_ids ?? []),
    ...(activeStep?.output_ids ?? []),
  ]);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  if (nodes.length === 0) {
    return (
      <div
        className="grid h-full place-items-center text-xs text-zinc-500"
        data-testid="scene-2d-empty"
      >
        This scene has no entities to lay out.
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-full w-full"
      data-testid="scene-2d"
      role="img"
      aria-label={`2D diagram of ${scene.algorithm_name || "the method"}`}
    >
      <defs>
        <marker id="scene-arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#52525b" />
        </marker>
        <marker id="scene-arrow-active" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#5eead4" />
        </marker>
      </defs>

      {edges.map((edge, index) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        const isActive = activeStep?.id === edge.stepId;
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const mid = (x1 + x2) / 2;
        return (
          <path
            key={`${edge.from}-${edge.to}-${index}`}
            d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
            fill="none"
            stroke={isActive ? "#5eead4" : "#3f3f46"}
            strokeWidth={isActive ? 2 : 1.2}
            markerEnd={`url(#${isActive ? "scene-arrow-active" : "scene-arrow"})`}
          />
        );
      })}

      {nodes.map((node) => {
        const isActive = active.has(node.id);
        const isSelected = selectedEntityId === node.id;
        return (
          <g
            key={node.id}
            transform={`translate(${node.x}, ${node.y})`}
            onClick={() => onSelectEntity?.(node.id)}
            style={{ cursor: onSelectEntity ? "pointer" : "default" }}
            data-testid={`scene-2d-node-${node.id}`}
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={6}
              fill={isActive ? "#0f2f2b" : "#18181b"}
              stroke={isSelected ? "#fbbf24" : isActive ? "#5eead4" : "#3f3f46"}
              strokeWidth={isSelected || isActive ? 2 : 1}
              strokeDasharray={node.uncertain ? "4 3" : undefined}
            />
            <text
              x={NODE_W / 2}
              y={NODE_H / 2 + 4}
              textAnchor="middle"
              fontSize={11}
              fill={isActive ? "#99f6e4" : "#d4d4d8"}
            >
              {node.label.length > 20 ? `${node.label.slice(0, 19)}...` : node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default Scene2DView;

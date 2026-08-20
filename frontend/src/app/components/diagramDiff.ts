import type {
  Diagram,
  DiagramEdge,
  DiagramNode,
  DiffState,
} from "../types";

/**
 * Compare a variant against the diagram it came from.
 *
 * Removed stages still have to appear or the diff is meaningless, so they are
 * re-inserted as ghosts: first at their original coordinates when nothing has
 * taken that space, then anchored between whichever neighbours survived, and
 * only as a last resort parked in a gutter.
 */

const NODE_W = 180;
const NODE_H = 48;
const GUTTER_GAP = 260;

export function edgeKey(edge: { source: string; target: string }): string {
  return `${edge.source}->${edge.target}`;
}

export type DiagramDiffModel = {
  nodeState: Record<string, DiffState>;
  edgeState: Record<string, DiffState>;
  changedFields: Record<string, string[]>;
  ghostNodeIds: Set<string>;
  ghostEdgeKeys: Set<string>;
  /** Ghost id -> surviving neighbours, for leader lines back into the graph. */
  ghostAnchors: Record<string, string[]>;
  merged: Diagram;
  counts: Record<DiffState, number>;
};

// Only authored fields count. x, y and layer are all derived by the layout
// pass, so including them would mark every stage downstream of a removal as
// "changed" and drown out the stages the modification actually touched.
const NODE_COMPARE_FIELDS: (keyof DiagramNode)[] = [
  "label",
  "kind",
  "detail",
  "group",
];
// `back` is likewise derived from cycle-breaking during layout.
const EDGE_COMPARE_FIELDS: (keyof DiagramEdge)[] = ["label", "kind"];

function changedFieldsOf<T extends object>(
  before: T,
  after: T,
  fields: (keyof T)[],
): string[] {
  return fields
    .filter((field) => before[field] !== after[field])
    .map((field) => String(field));
}

function collides(
  node: { x: number; y: number },
  others: DiagramNode[],
): boolean {
  return others.some(
    (other) =>
      Math.abs(other.x - node.x) < NODE_W * 0.9 &&
      Math.abs(other.y - node.y) < NODE_H * 1.6,
  );
}

function placeGhosts(
  base: Diagram,
  variant: Diagram,
  removedIds: string[],
): { ghosts: DiagramNode[]; anchors: Record<string, string[]> } {
  const variantIds = new Set(variant.nodes.map((node) => node.id));
  const variantById = new Map(variant.nodes.map((node) => [node.id, node]));
  const maxX = Math.max(...variant.nodes.map((node) => node.x), 0);

  const ghosts: DiagramNode[] = [];
  const anchors: Record<string, string[]> = {};
  let gutterSlot = 0;

  for (const id of removedIds) {
    const original = base.nodes.find((node) => node.id === id);
    if (!original) continue;

    // Which of its former neighbours are still in the graph?
    const neighbours = base.edges
      .filter((edge) => edge.source === id || edge.target === id)
      .map((edge) => (edge.source === id ? edge.target : edge.source))
      .filter((neighbour) => variantIds.has(neighbour));
    anchors[id] = [...new Set(neighbours)];

    const placed = [...variant.nodes, ...ghosts];

    // 1. its own coordinates, if nothing moved into them
    if (!collides(original, placed)) {
      ghosts.push({ ...original });
      continue;
    }

    // 2. beside the surviving neighbours it used to sit between
    const anchorNodes = anchors[id]
      .map((neighbour) => variantById.get(neighbour))
      .filter((node): node is DiagramNode => Boolean(node));
    if (anchorNodes.length > 0) {
      const cx =
        anchorNodes.reduce((total, node) => total + node.x, 0) / anchorNodes.length;
      const cy =
        anchorNodes.reduce((total, node) => total + node.y, 0) / anchorNodes.length;
      const candidate = { ...original, x: cx + (NODE_W + 40), y: cy };
      if (!collides(candidate, placed)) {
        ghosts.push(candidate);
        continue;
      }
      const mirrored = { ...original, x: cx - (NODE_W + 40), y: cy };
      if (!collides(mirrored, placed)) {
        ghosts.push(mirrored);
        continue;
      }
    }

    // 3. a labelled gutter, so it never overlaps live content
    ghosts.push({
      ...original,
      x: maxX + GUTTER_GAP,
      y: original.y + gutterSlot * (NODE_H * 2),
    });
    gutterSlot += 1;
  }

  return { ghosts, anchors };
}

export function buildDiagramDiff(
  base: Diagram,
  variant: Diagram,
): DiagramDiffModel {
  const nodeState: Record<string, DiffState> = {};
  const edgeState: Record<string, DiffState> = {};
  const changedFields: Record<string, string[]> = {};

  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const variantNodes = new Map(variant.nodes.map((node) => [node.id, node]));

  for (const node of variant.nodes) {
    const before = baseNodes.get(node.id);
    if (!before) {
      nodeState[node.id] = "added";
      continue;
    }
    const fields = changedFieldsOf(before, node, NODE_COMPARE_FIELDS);
    if (fields.length > 0) {
      nodeState[node.id] = "changed";
      changedFields[node.id] = fields;
    } else {
      nodeState[node.id] = "unchanged";
    }
  }

  const removedIds = base.nodes
    .filter((node) => !variantNodes.has(node.id))
    .map((node) => node.id);
  for (const id of removedIds) nodeState[id] = "removed";

  const baseEdges = new Map(base.edges.map((edge) => [edgeKey(edge), edge]));
  const variantEdges = new Map(
    variant.edges.map((edge) => [edgeKey(edge), edge]),
  );

  for (const [key, edge] of variantEdges) {
    const before = baseEdges.get(key);
    if (!before) {
      edgeState[key] = "added";
      continue;
    }
    const fields = changedFieldsOf(before, edge, EDGE_COMPARE_FIELDS);
    if (fields.length > 0) {
      edgeState[key] = "changed";
      changedFields[key] = fields;
    } else {
      edgeState[key] = "unchanged";
    }
  }

  const ghostEdgeKeys = new Set<string>();
  for (const [key] of baseEdges) {
    if (!variantEdges.has(key)) {
      edgeState[key] = "removed";
      ghostEdgeKeys.add(key);
    }
  }

  const { ghosts, anchors } = placeGhosts(base, variant, removedIds);
  const ghostNodeIds = new Set(ghosts.map((node) => node.id));

  const ghostEdges = base.edges.filter((edge) => ghostEdgeKeys.has(edgeKey(edge)));
  const merged: Diagram = {
    nodes: [...variant.nodes, ...ghosts],
    edges: [...variant.edges, ...ghostEdges],
    groups: variant.groups,
  };

  const counts: Record<DiffState, number> = {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
  };
  for (const state of Object.values(nodeState)) counts[state] += 1;

  return {
    nodeState,
    edgeState,
    changedFields,
    ghostNodeIds,
    ghostEdgeKeys,
    ghostAnchors: anchors,
    merged,
    counts,
  };
}

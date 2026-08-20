export function nodeStroke(kind: string): string {
  if (kind === "input") return "#6ee7d8";
  if (kind === "output") return "#a5b4fc";
  if (kind === "operation") return "#fbbf24";
  if (kind === "data") return "#f0abfc";
  if (kind === "decision") return "#fca5a5";
  if (kind === "loop") return "#93c5fd";
  if (kind === "state") return "#86efac";
  return "#e8e2d4"; // component
}

export function edgeStroke(kind: string): string {
  if (kind === "residual") return "#6ee7d8";
  if (kind === "attention") return "#f0abfc";
  if (kind === "feedback") return "#fbbf24";
  if (kind === "data") return "#93c5fd";
  if (kind === "reference") return "#71717a";
  return "#8b8b93"; // flow
}

export function formatKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

/**
 * Each process primitive gets its own colour, so the machinery inside a stage
 * is readable at a glance — a projection never looks like an attention fan.
 */
const PRIMITIVE_COLORS: Record<string, string> = {
  token_stream: "#7dd3fc",
  vector_array: "#6ee7d8",
  matrix_transform: "#fbbf24",
  attention_links: "#f0abfc",
  split_parallel: "#a5b4fc",
  merge_parallel: "#c4b5fd",
  elementwise_combine: "#86efac",
  nonlinearity: "#fb923c",
  normalize: "#38bdf8",
  distribution: "#fde047",
  filter_select: "#f472b6",
  compare: "#a3e635",
  loop_repeat: "#fcd34d",
  note: "#71717a",
};

export function primitiveColor(primitive: string): string {
  return PRIMITIVE_COLORS[primitive] ?? "#e8e2d4";
}

export const PRIMITIVE_LEGEND = Object.entries(PRIMITIVE_COLORS).filter(
  ([primitive]) => primitive !== "note",
);

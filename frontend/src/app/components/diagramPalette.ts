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

// ------------------------------------------------------------------- diff

/** Diff tint, or null when the state carries no annotation. */
export function diffTint(state?: string | null): string | null {
  if (state === "added") return "#34d399";
  if (state === "removed") return "#fb7185";
  if (state === "changed") return "#fbbf24";
  return null;
}

export const DIFF_LEGEND: [string, string][] = [
  ["added", "#34d399"],
  ["changed", "#fbbf24"],
  ["removed", "#fb7185"],
];

/** Severity colour. Basis (checked vs judged) is carried by form, not hue. */
export function severityTone(severity: string): string {
  if (severity === "blocking") return "text-rose-300";
  if (severity === "major") return "text-amber-300";
  if (severity === "minor") return "text-teal-300";
  return "text-zinc-400";
}

export function verdictTone(verdict: string): string {
  if (verdict === "likely_broken") return "text-rose-300 border-rose-900/60 bg-rose-950/40";
  if (verdict === "concerns") return "text-amber-300 border-amber-900/60 bg-amber-950/40";
  return "text-emerald-300 border-emerald-900/60 bg-emerald-950/40";
}

export function verdictLabel(verdict: string): string {
  if (verdict === "likely_broken") return "likely broken";
  if (verdict === "concerns") return "concerns";
  if (verdict === "structurally_sound") return "sound";
  return verdict || "unverified";
}

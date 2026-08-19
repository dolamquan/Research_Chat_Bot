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

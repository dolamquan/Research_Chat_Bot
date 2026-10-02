/**
 * Layout constants and pure helpers for the diagram canvas.
 *
 * Extracted from VisualizerView so the geometry and the readiness rules can be
 * read — and tested — without the 2,000-line component around them.
 */
import { checkSceneCode } from "./sceneRuntime";
import { sceneRuntimeStatus } from "./sceneTypes";
import type { StageSceneRecord } from "./sceneTypes";
import type { DiagramKind } from "../../types";

export const NODE_W = 180;
export const NODE_H = 48;
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2.5;

/** The code passes the static contract, so the frame is allowed to mount it. */
export function sceneIsPlayable(record: StageSceneRecord): boolean {
  return record.valid !== false && checkSceneCode(record.scene.code).length === 0;
}

// Playable means the code passes the contract; ready means the browser has
// also run it through a full cycle without a crash. "All stages ready" and
// the prepare counter use ready, so a scene that throws on its first frame
// is never announced as prepared.
export function sceneIsReady(record: StageSceneRecord): boolean {
  return sceneIsPlayable(record) && sceneRuntimeStatus(record) === "passed";
}

export const EDGE_KIND_LIST = [
  "flow",
  "data",
  "residual",
  "attention",
  "feedback",
  "reference",
] as const;

export function edgeWidth(kind: string): number {
  if (kind === "reference") return 1.1;
  if (kind === "feedback") return 1.4;
  if (kind === "flow") return 1.9;
  return 1.6;
}

export const KIND_OPTIONS: { value: "auto" | DiagramKind; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "architecture", label: "Architecture" },
  { value: "method_flow", label: "Method flow" },
  { value: "pipeline", label: "Pipeline" },
];

/**
 * Break a node label over at most two lines, eliding the rest.
 *
 * A node box is a fixed size, so a long label has to lose something; losing
 * the tail with an ellipsis keeps the start, which is what identifies it.
 */
export function wrapLabel(label: string, maxChars = 24): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length > 2) {
    const second = lines.slice(1).join(" ");
    return [lines[0], second.length > maxChars ? `${second.slice(0, maxChars - 1)}…` : second];
  }
  return lines;
}

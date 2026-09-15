/**
 * Frontend mirror of the backend scene coder (`backend/app/rag/scene_coder.py`).
 *
 * A scene is now a self-contained Three.js program the model wrote, not a
 * validated data document. It executes ONLY inside the sandboxed iframe built
 * by `sceneRuntime.ts` (`sandbox="allow-scripts"`, opaque origin) — never in
 * the app's own realm.
 */

/** Must match `CODE_FORMAT` in scene_coder.py. */
export const SCENE_CODE_FORMAT = "threejs-code@1";

export type RefinementKind = "cosmetic" | "fundamental";

/** How the server judged a refinement request, and how sure it could be. */
export type RefinementClassification = {
  kind: RefinementKind;
  reason: string;
  /** "model", "heuristic" (offline word lists) or "acknowledged" (the user confirmed). */
  basis: string;
};

/**
 * How a refinement request came back. `needs_acknowledgement` means the
 * server judged the change to alter what the animation shows and generated
 * nothing; only an explicit "change it anyway" re-sends with the flag set.
 */
export type RefineOutcome<R> =
  | { status: "refined"; record: R; classification: RefinementClassification }
  | { status: "needs_acknowledgement"; classification: RefinementClassification };

/** One user-directed change applied to the stored program. */
export type SceneEdit = {
  instruction: string;
  kind: RefinementKind;
  basis: string;
  at: string;
};

export type SceneCodeDoc = {
  format: string;
  language: string;
  runtime: string;
  title: string;
  algorithm_name: string;
  summary: string;
  code: string;
  /** Present once the user has refined the scene; the trail survives reloads. */
  edits?: SceneEdit[];
};

/** A label (or a label and a figure) the probe found colliding on screen. */
export type OverlapPair = { a: string; b: string; seconds: number[] };

/**
 * The browser's verdict on a scene. Every stored scene starts `unverified`:
 * the static checks passed and nothing has executed it. Only `passed` counts
 * as ready — a scene can be contract-complete and still throw on frame one.
 */
export type SceneRuntimeReport = {
  status: "unverified" | "passed" | "failed";
  error?: string | null;
  overlaps?: OverlapPair[];
  samples?: number;
  checked_at?: string;
};

/** Static contract checks recorded at generation time (and re-run on verify). */
export type SceneVerificationReport = {
  valid: boolean;
  findings: string[];
  checks?: string;
  runtime?: SceneRuntimeReport;
};

export function sceneRuntimeStatus(record: {
  verification?: SceneVerificationReport;
}): SceneRuntimeReport["status"] {
  return record.verification?.runtime?.status ?? "unverified";
}

/** True once any edit changed what the animation shows, not just how. */
export function sceneDivergesFromPaper(scene: SceneCodeDoc): boolean {
  return (scene.edits ?? []).some((edit) => edit.kind === "fundamental");
}

export type SceneRecord = {
  scene_id: string;
  viz_id: string;
  article_id: string;
  schema_version: string;
  provider: string;
  model: string;
  extraction_strategy: string;
  scene: SceneCodeDoc;
  verification: SceneVerificationReport;
  valid: boolean;
  created_at: string;
  updated_at: string;
};

/** A per-node scene: the same code document, scoped to one diagram stage. */
export type StageSceneRecord = {
  stage_scene_id: string;
  viz_id: string;
  node_id: string;
  schema_version: string;
  provider: string;
  model: string;
  scene: SceneCodeDoc;
  verification: SceneVerificationReport;
  valid: boolean;
  created_at: string;
  updated_at: string;
};

/** What a player actually needs from either record shape. */
export type PlayableSceneRecord = { scene: SceneCodeDoc };

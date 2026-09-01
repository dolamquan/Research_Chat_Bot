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

export type SceneCodeDoc = {
  format: string;
  language: string;
  runtime: string;
  title: string;
  algorithm_name: string;
  summary: string;
  code: string;
};

/** Static contract checks recorded at generation time (and re-run on verify). */
export type SceneVerificationReport = {
  valid: boolean;
  findings: string[];
  checks?: string;
};

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

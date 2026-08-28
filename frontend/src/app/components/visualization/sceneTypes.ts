/**
 * Frontend mirror of the backend Scene IR (`backend/app/rag/scene_ir.py`).
 *
 * Kept as its own module rather than folded into the already-large
 * `types.ts` so the visualization package is self-contained, and so the
 * primitive list has one obvious home to keep in step with the backend.
 */

/** The complete whitelist. Anything outside it renders a safe fallback. */
export const SUPPORTED_PRIMITIVES = [
  "token_stream",
  "vector_array",
  "matrix_transform",
  "attention_links",
  "split_parallel",
  "merge_parallel",
  "elementwise_combine",
  "nonlinearity",
  "normalize",
  "distribution",
  "filter_select",
  "compare",
  "loop_repeat",
  "data_transfer",
  "state_transition",
  "note",
] as const;

export type ProcessPrimitive = (typeof SUPPORTED_PRIMITIVES)[number];

export type VisualizationMode = "2d" | "2_5d" | "3d";

export type EvidenceRef = {
  evidence_id: string;
  chunk_id: string | null;
  section: string;
  page: number | null;
  quote: string;
  confidence: number;
};

export type SceneEntity = {
  id: string;
  label: string;
  kind: string;
  semantic_role: string;
  group: string | null;
  evidence_ids: string[];
};

export type SceneStep = {
  id: string;
  node_id: string | null;
  /** Typed loosely on purpose: a stored scene may predate the current list. */
  primitive: ProcessPrimitive | string;
  caption: string;
  detail: string;
  items: string[];
  values: number[];
  count: number;
  label_in: string;
  label_out: string;
  input_ids: string[];
  output_ids: string[];
  execution: "sequential" | "parallel" | "loop";
  duration_ms: number;
  evidence_ids: string[];
  confidence: number;
};

export type CameraCue = {
  step_id: string;
  focus_entity_ids: string[];
  framing: "overview" | "group" | "detail";
  transition_ms: number;
};

export type AlgorithmScene = {
  schema_version: string;
  title: string;
  algorithm_name: string;
  visualization_mode: VisualizationMode;
  summary: string;
  entities: SceneEntity[];
  evidence: EvidenceRef[];
  steps: SceneStep[];
  camera_cues: CameraCue[];
};

export type SceneFinding = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  entity_ids: string[];
  step_ids: string[];
  evidence_ids: string[];
};

export type SceneVerificationReport = {
  valid: boolean;
  findings: SceneFinding[];
  entity_count: number;
  step_count: number;
  grounded_entity_ratio: number;
  grounded_step_ratio: number;
};

export type SceneRecord = {
  scene_id: string;
  viz_id: string;
  article_id: string;
  schema_version: string;
  provider: string;
  model: string;
  extraction_strategy: string;
  scene: AlgorithmScene;
  verification: SceneVerificationReport;
  valid: boolean;
  created_at: string;
  updated_at: string;
};

/** Props every primitive renderer receives. Uniform so the registry is a map. */
export type PrimitiveSceneProps = {
  step: SceneStep;
  /** 0..1 progress through this step. */
  t: number;
  /** Entities this step names, resolved for labelling. */
  inputs: SceneEntity[];
  outputs: SceneEntity[];
  /** Muted rendering while another step is active. */
  dimmed?: boolean;
  onSelectEntity?: (entityId: string) => void;
};

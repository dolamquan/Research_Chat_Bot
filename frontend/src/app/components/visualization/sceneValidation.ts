/**
 * Client-side validation of a scene received from the API.
 *
 * The backend already validates on the way in, but the frontend must survive a
 * malformed scene regardless of where it came from -- an older stored record,
 * a hand-edited fixture, a partially-written response. Nothing here throws:
 * `sanitizeScene` always returns something renderable, and reports what it had
 * to repair so the UI can say the scene was incomplete rather than silently
 * showing less than the paper described.
 *
 * This is the frontend half of the no-executable-content rule. Every field is
 * coerced to a primitive of a known type; a string is never interpreted, only
 * displayed.
 */

import {
  SUPPORTED_PRIMITIVES,
  type AlgorithmScene,
  type CameraCue,
  type EvidenceRef,
  type SceneEntity,
  type SceneStep,
  type VisualizationMode,
} from "./sceneTypes";

const PRIMITIVE_SET = new Set<string>(SUPPORTED_PRIMITIVES);
const MODES: VisualizationMode[] = ["2d", "2_5d", "3d"];

export type SanitizeIssue = {
  code: string;
  message: string;
};

export type SanitizeResult = {
  scene: AlgorithmScene;
  issues: SanitizeIssue[];
  /** False when the input was unusable and an empty scene was substituted. */
  usable: boolean;
};

export function isSupportedPrimitive(value: unknown): boolean {
  return typeof value === "string" && PRIMITIVE_SET.has(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function numArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : [];
}

export function emptyScene(): AlgorithmScene {
  return {
    schema_version: "1.0",
    title: "",
    algorithm_name: "",
    visualization_mode: "2d",
    summary: "",
    entities: [],
    evidence: [],
    steps: [],
    camera_cues: [],
  };
}

/**
 * Coerce an untrusted value into a renderable scene.
 *
 * Steps referencing entities that do not exist keep playing with the reference
 * dropped rather than being discarded: losing a caption is a smaller loss than
 * losing the step, and the dropped reference is reported as an issue.
 */
export function sanitizeScene(input: unknown): SanitizeResult {
  const issues: SanitizeIssue[] = [];

  if (!input || typeof input !== "object") {
    return {
      scene: emptyScene(),
      issues: [{ code: "not_an_object", message: "The scene payload was not an object." }],
      usable: false,
    };
  }

  const raw = input as Record<string, unknown>;

  const entities: SceneEntity[] = [];
  const seenEntities = new Set<string>();
  for (const value of Array.isArray(raw.entities) ? raw.entities : []) {
    const item = value as Record<string, unknown>;
    const id = str(item?.id);
    if (!id || seenEntities.has(id)) {
      issues.push({
        code: "bad_entity",
        message: `Entity with missing or duplicate id ${id || "(blank)"} was dropped.`,
      });
      continue;
    }
    seenEntities.add(id);
    entities.push({
      id,
      label: str(item.label, id),
      kind: str(item.kind, "component"),
      semantic_role: str(item.semantic_role),
      group: typeof item.group === "string" ? item.group : null,
      evidence_ids: strArray(item.evidence_ids),
    });
  }

  const evidence: EvidenceRef[] = [];
  const seenEvidence = new Set<string>();
  for (const value of Array.isArray(raw.evidence) ? raw.evidence : []) {
    const item = value as Record<string, unknown>;
    const id = str(item?.evidence_id);
    if (!id || seenEvidence.has(id)) continue;
    seenEvidence.add(id);
    evidence.push({
      evidence_id: id,
      chunk_id: typeof item.chunk_id === "string" ? item.chunk_id : null,
      section: str(item.section),
      page: typeof item.page === "number" ? item.page : null,
      quote: str(item.quote),
      confidence: clamp01(num(item.confidence, 0.5)),
    });
  }

  const steps: SceneStep[] = [];
  const seenSteps = new Set<string>();
  for (const [index, value] of (Array.isArray(raw.steps) ? raw.steps : []).entries()) {
    const item = value as Record<string, unknown>;
    const id = str(item?.id) || `step_${index}`;
    if (seenSteps.has(id)) {
      issues.push({ code: "duplicate_step", message: `Duplicate step id ${id} was dropped.` });
      continue;
    }
    seenSteps.add(id);

    const primitive = str(item.primitive, "note");
    if (!PRIMITIVE_SET.has(primitive)) {
      // Kept, not dropped: the compiler renders an explicit fallback so the
      // reader sees that a step exists and is not supported, rather than a gap.
      issues.push({
        code: "unknown_primitive",
        message: `Step ${id} uses unsupported primitive "${primitive}".`,
      });
    }

    const inputs = strArray(item.input_ids).filter((eid) => seenEntities.has(eid));
    const outputs = strArray(item.output_ids).filter((eid) => seenEntities.has(eid));
    if (inputs.length !== strArray(item.input_ids).length) {
      issues.push({ code: "dangling_input", message: `Step ${id} referenced a missing entity.` });
    }
    if (outputs.length !== strArray(item.output_ids).length) {
      issues.push({ code: "dangling_output", message: `Step ${id} referenced a missing entity.` });
    }

    const execution = str(item.execution, "sequential");
    steps.push({
      id,
      node_id: typeof item.node_id === "string" ? item.node_id : null,
      primitive,
      caption: str(item.caption),
      detail: str(item.detail),
      items: strArray(item.items).slice(0, 24),
      values: numArray(item.values).slice(0, 64),
      count: Math.max(0, Math.min(512, Math.round(num(item.count, 0)))),
      label_in: str(item.label_in),
      label_out: str(item.label_out),
      input_ids: inputs,
      output_ids: outputs,
      execution:
        execution === "parallel" || execution === "loop" ? execution : "sequential",
      duration_ms: Math.max(200, Math.min(20000, Math.round(num(item.duration_ms, 1200)))),
      evidence_ids: strArray(item.evidence_ids).filter((eid) => seenEvidence.has(eid)),
      confidence: clamp01(num(item.confidence, 0.5)),
    });
  }

  const cues: CameraCue[] = [];
  for (const value of Array.isArray(raw.camera_cues) ? raw.camera_cues : []) {
    const item = value as Record<string, unknown>;
    const stepId = str(item?.step_id);
    if (!seenSteps.has(stepId)) continue;
    const framing = str(item.framing, "overview");
    cues.push({
      step_id: stepId,
      focus_entity_ids: strArray(item.focus_entity_ids).filter((eid) => seenEntities.has(eid)),
      framing: framing === "group" || framing === "detail" ? framing : "overview",
      transition_ms: Math.max(0, Math.min(10000, Math.round(num(item.transition_ms, 800)))),
    });
  }

  const mode = str(raw.visualization_mode, "2d") as VisualizationMode;

  return {
    scene: {
      schema_version: str(raw.schema_version, "1.0"),
      title: str(raw.title),
      algorithm_name: str(raw.algorithm_name),
      visualization_mode: MODES.includes(mode) ? mode : "2d",
      summary: str(raw.summary),
      entities,
      evidence,
      steps,
      camera_cues: cues,
    },
    issues,
    usable: steps.length > 0,
  };
}

/** A step is uncertain when it cites nothing or reports low confidence. */
export function stepIsUncertain(step: SceneStep): boolean {
  return step.evidence_ids.length === 0 || step.confidence < 0.5;
}

export function entityIsUncertain(entity: SceneEntity): boolean {
  return entity.evidence_ids.length === 0;
}

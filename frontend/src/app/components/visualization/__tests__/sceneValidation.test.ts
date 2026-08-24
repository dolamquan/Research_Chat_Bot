import { describe, expect, it } from "vitest";

import transformerScene from "../../../../../../backend/tests/fixtures/scenes/transformer_self_attention.json";
import ragScene from "../../../../../../backend/tests/fixtures/scenes/rag_pipeline.json";
import {
  emptyScene,
  entityIsUncertain,
  isSupportedPrimitive,
  sanitizeScene,
  stepIsUncertain,
} from "../sceneValidation";

/**
 * The fixtures are imported from the backend test directory on purpose: one
 * copy validated by both sides means a schema change cannot pass the Python
 * tests while breaking the renderer.
 */

describe("sanitizeScene", () => {
  it("accepts a valid fixture unchanged", () => {
    const { scene, issues, usable } = sanitizeScene(transformerScene);
    expect(usable).toBe(true);
    expect(issues).toHaveLength(0);
    expect(scene.steps).toHaveLength(5);
    expect(scene.entities).toHaveLength(6);
    expect(scene.visualization_mode).toBe("3d");
  });

  it("accepts every fixture", () => {
    for (const fixture of [transformerScene, ragScene]) {
      expect(sanitizeScene(fixture).usable).toBe(true);
    }
  });

  it("survives a non-object payload", () => {
    for (const bad of [null, undefined, 42, "scene", []]) {
      const result = sanitizeScene(bad);
      expect(result.usable).toBe(false);
      expect(result.scene.steps).toHaveLength(0);
    }
  });

  it("keeps a step with an unknown primitive but reports it", () => {
    const broken = structuredClone(transformerScene) as Record<string, unknown>;
    (broken.steps as Record<string, unknown>[])[0].primitive = "rm_minus_rf";
    const { scene, issues } = sanitizeScene(broken);
    // Kept, so the reader sees a step exists; the compiler renders a fallback.
    expect(scene.steps).toHaveLength(5);
    expect(issues.some((i) => i.code === "unknown_primitive")).toBe(true);
  });

  it("drops dangling entity references and reports them", () => {
    const broken = structuredClone(transformerScene) as Record<string, unknown>;
    (broken.steps as Record<string, unknown>[])[0].input_ids = ["ghost"];
    const { scene, issues } = sanitizeScene(broken);
    expect(scene.steps[0].input_ids).toHaveLength(0);
    expect(issues.some((i) => i.code === "dangling_input")).toBe(true);
  });

  it("drops duplicate entities", () => {
    const broken = structuredClone(transformerScene) as Record<string, unknown>;
    const entities = broken.entities as Record<string, unknown>[];
    entities.push({ ...entities[0] });
    const { scene, issues } = sanitizeScene(broken);
    expect(scene.entities).toHaveLength(6);
    expect(issues.some((i) => i.code === "bad_entity")).toBe(true);
  });

  it("drops evidence references that do not resolve", () => {
    const broken = structuredClone(transformerScene) as Record<string, unknown>;
    (broken.steps as Record<string, unknown>[])[0].evidence_ids = ["ev_nope"];
    const { scene } = sanitizeScene(broken);
    expect(scene.steps[0].evidence_ids).toHaveLength(0);
  });

  it("clamps out-of-range numbers instead of failing", () => {
    const broken = structuredClone(transformerScene) as Record<string, unknown>;
    const step = (broken.steps as Record<string, unknown>[])[0];
    step.duration_ms = 9_999_999;
    step.confidence = 5;
    step.count = -12;
    const { scene } = sanitizeScene(broken);
    expect(scene.steps[0].duration_ms).toBeLessThanOrEqual(20000);
    expect(scene.steps[0].confidence).toBe(1);
    expect(scene.steps[0].count).toBe(0);
  });

  it("coerces a bogus visualization mode to 2d", () => {
    const broken = structuredClone(transformerScene) as Record<string, unknown>;
    broken.visualization_mode = "holographic";
    expect(sanitizeScene(broken).scene.visualization_mode).toBe("2d");
  });

  it("drops camera cues pointing at missing steps", () => {
    const broken = structuredClone(transformerScene) as Record<string, unknown>;
    broken.camera_cues = [{ step_id: "nope", focus_entity_ids: [], framing: "detail", transition_ms: 100 }];
    expect(sanitizeScene(broken).scene.camera_cues).toHaveLength(0);
  });

  it("treats a scene with no steps as unusable", () => {
    const broken = structuredClone(transformerScene) as Record<string, unknown>;
    broken.steps = [];
    expect(sanitizeScene(broken).usable).toBe(false);
  });

  it("never returns a string field as a non-string", () => {
    const hostile = {
      title: { toString: "not a string" },
      steps: [{ id: "s", primitive: "note", caption: ["array"], values: "nope" }],
      entities: [{ id: "e", label: 42 }],
    };
    const { scene } = sanitizeScene(hostile);
    expect(typeof scene.title).toBe("string");
    expect(typeof scene.steps[0].caption).toBe("string");
    expect(Array.isArray(scene.steps[0].values)).toBe(true);
    expect(typeof scene.entities[0].label).toBe("string");
  });
});

describe("uncertainty helpers", () => {
  it("marks a step with no evidence as uncertain", () => {
    const { scene } = sanitizeScene(transformerScene);
    expect(stepIsUncertain(scene.steps[0])).toBe(false);
    expect(stepIsUncertain({ ...scene.steps[0], evidence_ids: [] })).toBe(true);
  });

  it("marks a low-confidence step as uncertain even when cited", () => {
    const { scene } = sanitizeScene(transformerScene);
    expect(stepIsUncertain({ ...scene.steps[0], confidence: 0.2 })).toBe(true);
  });

  it("marks an uncited entity as uncertain", () => {
    const { scene } = sanitizeScene(transformerScene);
    expect(entityIsUncertain(scene.entities[0])).toBe(false);
    expect(entityIsUncertain({ ...scene.entities[0], evidence_ids: [] })).toBe(true);
  });
});

describe("primitive whitelist", () => {
  it("recognises supported names only", () => {
    expect(isSupportedPrimitive("token_stream")).toBe(true);
    expect(isSupportedPrimitive("note")).toBe(true);
    expect(isSupportedPrimitive("eval")).toBe(false);
    expect(isSupportedPrimitive(123)).toBe(false);
  });
});

describe("emptyScene", () => {
  it("is a valid, renderable, empty document", () => {
    const scene = emptyScene();
    expect(scene.steps).toHaveLength(0);
    expect(scene.visualization_mode).toBe("2d");
  });
});

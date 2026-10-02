import { describe, expect, it, vi } from "vitest";

// The readiness rules are the point of these tests; the contract checker and
// the runtime verdict are the two inputs they combine, so both are stubbed.
const contract = vi.hoisted(() => ({ checkSceneCode: vi.fn(() => [] as string[]) }));
const runtime = vi.hoisted(() => ({ sceneRuntimeStatus: vi.fn(() => "passed" as string) }));
vi.mock("../sceneRuntime", () => contract);
vi.mock("../sceneTypes", () => runtime);

import {
  EDGE_KIND_LIST,
  KIND_OPTIONS,
  MAX_SCALE,
  MIN_SCALE,
  NODE_H,
  NODE_W,
  edgeWidth,
  sceneIsPlayable,
  sceneIsReady,
  wrapLabel,
} from "../diagramLayout";
import type { StageSceneRecord } from "../sceneTypes";

function record(overrides: Partial<StageSceneRecord> = {}): StageSceneRecord {
  return { scene: { code: "// scene" }, ...overrides } as StageSceneRecord;
}

describe("wrapLabel", () => {
  it("keeps a short label on one line", () => {
    expect(wrapLabel("Retrieval")).toEqual(["Retrieval"]);
  });

  it("breaks on a word boundary rather than mid-word", () => {
    expect(wrapLabel("Dense Passage Retrieval", 16)).toEqual(["Dense Passage", "Retrieval"]);
  });

  it("rejoins the overflow onto the second line, eliding what will not fit", () => {
    // Wraps to three lines, so lines 2 and 3 are rejoined and clipped to the limit.
    expect(wrapLabel("Dense Passage Retrieval Encoder", 16)).toEqual([
      "Dense Passage",
      "Retrieval Encod…",
    ]);
  });

  it("elides once the label would need a third line", () => {
    const wrapped = wrapLabel("one two three four five six seven eight nine ten", 12);
    expect(wrapped).toHaveLength(2);
    expect(wrapped[1].endsWith("…")).toBe(true);
    expect(wrapped[1].length).toBeLessThanOrEqual(12);
  });

  it("does not split a single word that is longer than the limit", () => {
    expect(wrapLabel("Supercalifragilistic", 8)).toEqual(["Supercalifragilistic"]);
  });

  it("collapses runs of whitespace and survives an empty label", () => {
    expect(wrapLabel("  a   b  ", 24)).toEqual(["a b"]);
    expect(wrapLabel("")).toEqual([]);
  });
});

describe("edgeWidth", () => {
  it("draws the main flow heaviest and a reference lightest", () => {
    expect(edgeWidth("flow")).toBeGreaterThan(edgeWidth("feedback"));
    expect(edgeWidth("feedback")).toBeGreaterThan(edgeWidth("reference"));
  });

  it("gives every other kind the same default", () => {
    expect(edgeWidth("data")).toBe(1.6);
    expect(edgeWidth("attention")).toBe(1.6);
    expect(edgeWidth("something new")).toBe(1.6);
  });

  it("has a width for every kind it lists", () => {
    for (const kind of EDGE_KIND_LIST) {
      expect(edgeWidth(kind)).toBeGreaterThan(0);
    }
  });
});

describe("sceneIsPlayable", () => {
  it("accepts a scene whose code passes the contract", () => {
    contract.checkSceneCode.mockReturnValue([]);
    expect(sceneIsPlayable(record())).toBe(true);
  });

  it("rejects a scene the backend already marked invalid, without checking the code", () => {
    contract.checkSceneCode.mockReturnValue([]);
    expect(sceneIsPlayable(record({ valid: false }))).toBe(false);
  });

  it("rejects a scene that breaks the contract", () => {
    contract.checkSceneCode.mockReturnValue(["no network access"]);
    expect(sceneIsPlayable(record())).toBe(false);
  });
});

describe("sceneIsReady", () => {
  it("needs the browser to have run it, not just a passing contract", () => {
    contract.checkSceneCode.mockReturnValue([]);
    runtime.sceneRuntimeStatus.mockReturnValue("passed");
    expect(sceneIsReady(record())).toBe(true);

    // The case this rule exists for: the contract passes but the first frame threw.
    runtime.sceneRuntimeStatus.mockReturnValue("failed");
    expect(sceneIsReady(record())).toBe(false);

    // Never probed is not the same as passed.
    runtime.sceneRuntimeStatus.mockReturnValue("unknown");
    expect(sceneIsReady(record())).toBe(false);
  });

  it("is never ready when it is not even playable", () => {
    contract.checkSceneCode.mockReturnValue(["forbidden import"]);
    runtime.sceneRuntimeStatus.mockReturnValue("passed");
    expect(sceneIsReady(record())).toBe(false);
  });
});

describe("canvas constants", () => {
  it("allows zooming both out and in from the default scale of 1", () => {
    expect(MIN_SCALE).toBeLessThan(1);
    expect(MAX_SCALE).toBeGreaterThan(1);
  });

  it("gives a node box a landscape shape for a wrapped two-line label", () => {
    expect(NODE_W).toBeGreaterThan(NODE_H);
  });

  it("offers auto-detect first among the diagram kinds", () => {
    expect(KIND_OPTIONS[0].value).toBe("auto");
    expect(new Set(KIND_OPTIONS.map((option) => option.value)).size).toBe(KIND_OPTIONS.length);
  });
});

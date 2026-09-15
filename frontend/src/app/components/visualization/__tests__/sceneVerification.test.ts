import { describe, expect, it, vi } from "vitest";

import type { RuntimeVerdict } from "../sceneRuntime";
import { MAX_REPAIRS, describeVerdict, ensureVerified, firstLine } from "../sceneVerification";
import type { PlayableSceneRecord } from "../sceneTypes";

type Rec = PlayableSceneRecord & { version: number };

function rec(version: number): Rec {
  return {
    version,
    scene: {
      format: "threejs-code@1", language: "javascript", runtime: "three@0.170",
      title: "Stage", algorithm_name: "Stage", summary: "", code: `// v${version}`,
    },
  };
}

const passed: RuntimeVerdict = { status: "passed", overlaps: [], samples: 9 };
const crashed: RuntimeVerdict = {
  status: "failed",
  error: "TypeError: row.forEach is not a function\n    at init (<anonymous>:12:5)",
  overlaps: [],
  samples: 0,
};
const colliding: RuntimeVerdict = {
  status: "passed",
  samples: 9,
  overlaps: [
    { a: 'emb("I")', b: "0.20", seconds: [3, 6, 9] },
    { a: "Scale", b: "figure", seconds: [12] }, // transient: one sample only
  ],
};

function deps(verdicts: RuntimeVerdict[]) {
  const probe = vi.fn(async () => verdicts.shift() ?? passed);
  let version = 1;
  const repair = vi.fn(async () => rec(++version));
  const report = vi.fn(async (verdict: RuntimeVerdict) => ({ ...rec(version), reported: verdict.status }) as Rec);
  const phases: string[] = [];
  return { probe, repair, report, onPhase: (p: string) => phases.push(p), phases };
}

describe("ensureVerified", () => {
  it("reports a scene that passes first time without any repair", async () => {
    const d = deps([passed]);
    const outcome = await ensureVerified(rec(1), d);
    expect(outcome.verdict.status).toBe("passed");
    expect(outcome.repairs).toBe(0);
    expect(d.repair).not.toHaveBeenCalled();
    expect(d.report).toHaveBeenCalledWith(passed);
    expect(d.phases).toEqual(["probing", "reporting"]);
  });

  it("repairs a crash with the real error, then re-probes", async () => {
    const d = deps([crashed, passed]);
    const outcome = await ensureVerified(rec(1), d);
    expect(d.repair).toHaveBeenCalledTimes(1);
    expect(d.repair).toHaveBeenCalledWith({ runtimeError: crashed.error });
    expect(d.probe).toHaveBeenCalledTimes(2);
    expect(outcome.verdict.status).toBe("passed");
    expect(outcome.repairs).toBe(1);
    expect(d.phases).toEqual(["probing", "repairing", "probing", "reporting"]);
  });

  it("sends only persistent overlaps as a layout repair", async () => {
    const d = deps([colliding, passed]);
    await ensureVerified(rec(1), d);
    expect(d.repair).toHaveBeenCalledTimes(1);
    expect(d.repair).toHaveBeenCalledWith({
      layoutReport: { pairs: [{ a: 'emb("I")', b: "0.20", seconds: [3, 6, 9] }], samples: 9 },
    });
  });

  it("does not repair a transient single-sample overlap", async () => {
    const d = deps([{ ...passed, overlaps: [{ a: "x", b: "y", seconds: [3] }] }]);
    const outcome = await ensureVerified(rec(1), d);
    expect(d.repair).not.toHaveBeenCalled();
    expect(outcome.verdict.status).toBe("passed");
  });

  it("accepts a layout repair that still leaves overlaps rather than churning", async () => {
    const d = deps([colliding, colliding]);
    const outcome = await ensureVerified(rec(1), d);
    expect(d.repair).toHaveBeenCalledTimes(1);
    expect(outcome.verdict.status).toBe("passed");
    expect(outcome.verdict.overlaps.length).toBe(2);
  });

  it("gives up after the repair budget and reports the failure", async () => {
    const d = deps([crashed, crashed, crashed, crashed]);
    const outcome = await ensureVerified(rec(1), d);
    expect(d.repair).toHaveBeenCalledTimes(MAX_REPAIRS);
    expect(outcome.verdict.status).toBe("failed");
    expect(outcome.repairs).toBe(MAX_REPAIRS);
    expect(d.report).toHaveBeenCalledWith(crashed);
  });

  it("recovers when a layout repair breaks the scene, within the same budget", async () => {
    const d = deps([colliding, crashed, passed]);
    const outcome = await ensureVerified(rec(1), d);
    expect(d.repair.mock.calls.map((c) => Object.keys(c[0])[0])).toEqual(["layoutReport", "runtimeError"]);
    expect(outcome.verdict.status).toBe("passed");
    expect(outcome.repairs).toBe(2);
  });

  it("never claims ready when the last probe failed, even after a layout repair", async () => {
    const d = deps([colliding, crashed, crashed]);
    const outcome = await ensureVerified(rec(1), d);
    expect(outcome.verdict.status).toBe("failed");
    expect(outcome.repairs).toBe(2);
  });

  it("returns the reported record so the stored verdict reaches the UI", async () => {
    const d = deps([passed]);
    const outcome = await ensureVerified(rec(1), d);
    expect((outcome.record as Rec & { reported?: string }).reported).toBe("passed");
  });
});

describe("verdict text", () => {
  it("keeps only the first line of a stack", () => {
    expect(firstLine(crashed.error)).toBe("TypeError: row.forEach is not a function");
    expect(firstLine(undefined)).toBe("");
  });

  it("describes each outcome honestly", () => {
    expect(describeVerdict(crashed)).toContain("row.forEach is not a function");
    expect(describeVerdict(colliding)).toContain("1 label still overlap");
    expect(describeVerdict(colliding)).toContain('emb("I")');
    expect(describeVerdict(passed)).toContain("Verified");
  });
});

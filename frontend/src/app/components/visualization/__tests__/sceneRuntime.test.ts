import { describe, expect, it } from "vitest";

import {
  MAX_CODE_CHARS,
  PERSISTENT_OVERLAP_SAMPLES,
  PROBE_SECONDS,
  buildSceneSrcDoc,
  checkSceneCode,
  layoutReportFor,
  summarizeProbe,
} from "../sceneRuntime";

const GOOD_CODE = `
const state = {};
function init(ctx) {
  const { THREE, scene } = ctx;
  state.box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x4fc3f7 })
  );
  scene.add(state.box);
  ctx.setCaption("A box rotates.");
}
function update(ctx, t) {
  state.box.rotation.y = t;
}
`;

describe("checkSceneCode", () => {
  it("accepts contract-complete code", () => {
    expect(checkSceneCode(GOOD_CODE)).toEqual([]);
  });

  it("rejects empty code", () => {
    expect(checkSceneCode("")).toEqual(["the code is empty"]);
    expect(checkSceneCode("   \n ")).toEqual(["the code is empty"]);
  });

  it("names each missing entry point", () => {
    const findings = checkSceneCode("const x = 1;");
    expect(findings.some((f) => f.includes("function init"))).toBe(true);
    expect(findings.some((f) => f.includes("function update"))).toBe(true);
  });

  it("rejects oversized code", () => {
    const padded = GOOD_CODE + "//" + "x".repeat(MAX_CODE_CHARS);
    expect(checkSceneCode(padded).some((f) => f.includes("maximum"))).toBe(true);
  });

  it.each([
    "fetch('https://x.example')",
    "new XMLHttpRequest()",
    "new WebSocket('wss://x')",
    "importScripts('x.js')",
    "import('three')",
    "import * as THREE from 'three';",
    "export function helper() {}",
    "require('fs')",
    "eval('1+1')",
    "new Function('return 1')",
    "document.cookie",
    "localStorage.setItem('k','v')",
    "window.parent.location",
    "window.open('https://x')",
    "postMessage({}, '*')",
    "document.body.appendChild(x)",
  ])("rejects forbidden construct: %s", (snippet) => {
    expect(checkSceneCode(GOOD_CODE + "\n" + snippet).length).toBeGreaterThan(0);
  });

  it("does not mistake similar identifiers for violations", () => {
    const code =
      GOOD_CODE +
      "\nfunction fetchColor(i) { return i; }" +
      "\nconst important = 1;" +
      "\nconst exported = 2;";
    expect(checkSceneCode(code)).toEqual([]);
  });
});

describe("buildSceneSrcDoc", () => {
  it("treats the scene title as text, including closing script markup", () => {
    const doc = buildSceneSrcDoc(GOOD_CODE, '</script><img src=x onerror=alert(1)>');
    expect(doc).not.toContain('<img src=x');
    expect(doc).toContain('\\u003c/script>');
    expect(doc).toContain('.textContent = TITLE');
  });
  it("embeds the code and the harness contract", () => {
    const doc = buildSceneSrcDoc(GOOD_CODE);
    expect(doc).toContain("importmap");
    expect(doc).toContain("cdn.jsdelivr.net/npm/three@");
    expect(doc).toContain("OrbitControls");
    expect(doc).toContain("state.box.rotation.y = t;");
    expect(doc).toContain('id="caption"');
    expect(doc).toContain("scene-ready");
    expect(doc).toContain("scene-error");
  });

  it("cannot be escaped with a closing script tag in the code", () => {
    const hostile = GOOD_CODE + "\nconst s = '</scr' + 'ipt><img src=x>';";
    const doc = buildSceneSrcDoc(hostile);
    // The document must contain exactly the harness's own closing tag(s);
    // nothing from the embedded string may appear as raw markup.
    const openings = doc.match(/<script/g) ?? [];
    const closings = doc.match(/<\/script>/g) ?? [];
    expect(openings.length).toBe(closings.length);
    expect(doc).not.toContain("<img src=x>");
  });

  it("escapes every angle bracket in the embedded code", () => {
    const doc = buildSceneSrcDoc("function init(ctx) { const a = 1 < 2; }\nfunction update(ctx, t) {}");
    expect(doc).toContain("1 \\u003c 2");
  });

  it("animates, not probes, by default", () => {
    const doc = buildSceneSrcDoc(GOOD_CODE);
    expect(doc).toContain("const PROBE = false");
    expect(doc).toContain("scene-verified");
  });

  it("in probe mode sweeps the whole cycle and skips the animation loop", () => {
    const doc = buildSceneSrcDoc(GOOD_CODE, "Encoder", { probe: true });
    expect(doc).toContain("const PROBE = true");
    expect(doc).toContain(`const PROBE_SECONDS = ${PROBE_SECONDS}`);
    expect(doc).toContain("module_.update(context, t)");
    expect(doc).toContain("if (!PROBE) renderer.setAnimationLoop");
    // The verdict leaves the frame the same way errors do: one postMessage.
    expect(doc).toContain("postMessage(report");
  });
});

describe("summarizeProbe", () => {
  it("merges the same pair across samples and records when it collided", () => {
    const verdict = summarizeProbe({
      type: "scene-verified", ok: true, samples: [
        { t: 0, overlaps: [] },
        { t: 3, overlaps: [{ a: 'emb("I")', b: "0.20" }, { a: "Scale", b: "figure" }] },
        { t: 6, overlaps: [{ a: "0.20", b: 'emb("I")' }] }, // reversed order, same pair
        { t: 9, overlaps: [{ a: 'emb("I")', b: "0.20" }] },
      ],
    });
    expect(verdict.status).toBe("passed");
    expect(verdict.samples).toBe(4);
    expect(verdict.overlaps).toEqual([
      { a: 'emb("I")', b: "0.20", seconds: [3, 6, 9] },
      { a: "Scale", b: "figure", seconds: [3] },
    ]);
  });

  it("treats a thrown error as a failed verdict and keeps the stack for the repair", () => {
    const verdict = summarizeProbe({
      type: "scene-verified", ok: false,
      error: "TypeError: row.forEach is not a function\n    at init", samples: [],
    });
    expect(verdict.status).toBe("failed");
    expect(verdict.error).toContain("at init");
  });

  it("builds a layout report only from persistent pairs", () => {
    const verdict = summarizeProbe({
      type: "scene-verified", ok: true, samples: [
        { t: 3, overlaps: [{ a: "a", b: "b" }, { a: "c", b: "d" }] },
        { t: 6, overlaps: [{ a: "a", b: "b" }] },
      ],
    });
    expect(PERSISTENT_OVERLAP_SAMPLES).toBe(2);
    expect(layoutReportFor(verdict)).toEqual({ pairs: [{ a: "a", b: "b", seconds: [3, 6] }], samples: 2 });
    expect(layoutReportFor({ status: "passed", overlaps: [], samples: 9 })).toBeNull();
  });
});

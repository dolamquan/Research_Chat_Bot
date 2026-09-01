import { describe, expect, it } from "vitest";

import {
  MAX_CODE_CHARS,
  buildSceneSrcDoc,
  checkSceneCode,
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
});

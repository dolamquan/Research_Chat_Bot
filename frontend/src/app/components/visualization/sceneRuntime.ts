/**
 * The sandbox runtime for model-generated Three.js scene code.
 *
 * `buildSceneSrcDoc` produces a complete HTML document for an iframe with
 * `sandbox="allow-scripts"` and nothing else: an opaque origin with no
 * cookies, no storage, and no handle on this page. That attribute is the
 * security boundary. `checkSceneCode` mirrors the backend's static contract
 * checks so a record that was tampered with (or predates a contract change)
 * is refused client-side with named reasons instead of failing obscurely.
 *
 * The harness inside the document owns the renderer, camera, controls,
 * lights and caption bar; generated code only ever sees the `ctx` object.
 * Communication back out is one-way postMessage: `scene-ready` after the
 * first frame, `scene-error` when compilation or a frame throws.
 */

// Pinned to the version in package.json. jsDelivr serves with
// `Access-Control-Allow-Origin: *`, which the iframe's opaque origin needs
// for module fetches.
const THREE_VERSION = "0.170.0";
const THREE_URL = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.min.js`;
const THREE_ADDONS_URL = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/`;

export const MAX_CODE_CHARS = 60_000;

/** Mirror of FORBIDDEN_PATTERNS in backend/app/rag/scene_coder.py. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/im, "network access via fetch()"],
  [/\bXMLHttpRequest\b/im, "network access via XMLHttpRequest"],
  [/\bWebSocket\b/im, "network access via WebSocket"],
  [/\bEventSource\b/im, "network access via EventSource"],
  [/\bnavigator\s*\.\s*sendBeacon\b/im, "network access via sendBeacon"],
  [/\bimportScripts\s*\(/im, "importScripts()"],
  [/\bimport\s*\(/im, "dynamic import()"],
  [/^\s*import\s/im, "static import statement"],
  [/^\s*export\s/im, "export statement"],
  [/\brequire\s*\(/im, "require()"],
  [/\beval\s*\(/im, "eval()"],
  [/\bnew\s+Function\b/im, "new Function()"],
  [/\bdocument\s*\.\s*cookie\b/im, "document.cookie"],
  [/\blocalStorage\b/im, "localStorage"],
  [/\bsessionStorage\b/im, "sessionStorage"],
  [/\bindexedDB\b/im, "indexedDB"],
  [/\bwindow\s*\.\s*(top|parent|opener|open|location)\b/im, "window escape hatch"],
  [/\bpostMessage\s*\(/im, "postMessage (reserved for the harness)"],
  [/<\s*script/im, "inline <script> markup"],
  [/\bdocument\s*\.\s*(write|body|head)\b/im, "direct DOM mutation outside ctx"],
];

/** Static contract findings; empty means the code is accepted. */
export function checkSceneCode(code: string): string[] {
  const findings: string[] = [];
  if (!code || !code.trim()) return ["the code is empty"];
  if (code.length > MAX_CODE_CHARS) {
    findings.push(
      `the code is ${code.length} characters; the maximum is ${MAX_CODE_CHARS}`,
    );
  }
  for (const name of ["init", "update"]) {
    if (!new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(code)) {
      findings.push(`missing required top-level declaration \`function ${name}(...)\``);
    }
  }
  for (const [pattern, reason] of FORBIDDEN) {
    if (pattern.test(code)) findings.push(`forbidden construct: ${reason}`);
  }
  return findings;
}

/**
 * Serialize the code into the document without ever closing the script tag:
 * every angle bracket becomes its backslash-u JSON escape, so a closing
 * script tag inside the code cannot terminate the harness script.
 */
function embedAsJson(code: string): string {
  return JSON.stringify(code).replace(/</g, "\\u003c");
}

export type SceneFrameMessage =
  | { type: "scene-ready" }
  | { type: "scene-error"; message: string };

export type SceneControlMessage = {
  type: "scene-control";
  action: "play" | "pause" | "restart";
};

/** The full srcDoc for one scene. Pure string building; nothing executes here. */
export function buildSceneSrcDoc(code: string): string {
  const importMap = JSON.stringify({
    imports: { three: THREE_URL, "three/addons/": THREE_ADDONS_URL },
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0b0b0d; }
  canvas { display: block; }
  #caption {
    position: fixed; left: 0; right: 0; bottom: 0;
    padding: 6px 12px; text-align: center;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #c8ccd4; background: rgba(11, 11, 13, 0.82);
    pointer-events: none; white-space: pre-wrap;
  }
  #error {
    position: fixed; inset: 0; display: none; place-items: center;
    padding: 24px; background: rgba(11, 11, 13, 0.94);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #ff9d9d; white-space: pre-wrap; overflow: auto;
  }
</style>
<script type="importmap">${importMap}</script>
</head>
<body>
<div id="caption"></div>
<div id="error"></div>
<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const CODE = ${embedAsJson(code)};

const captionEl = document.getElementById("caption");
const errorEl = document.getElementById("error");

function fail(message) {
  errorEl.textContent = String(message);
  errorEl.style.display = "grid";
  try { window.parent.postMessage({ type: "scene-error", message: String(message) }, "*"); } catch {}
}

window.addEventListener("error", (event) => fail(event.message || "Uncaught error"));
window.addEventListener("unhandledrejection", (event) => fail(event.reason || "Unhandled rejection"));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.insertBefore(renderer.domElement, captionEl);

const camera = new THREE.PerspectiveCamera(
  45, window.innerWidth / window.innerHeight, 0.1, 500,
);
camera.position.set(0, 2, 14);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let scene;
function makeScene() {
  const next = new THREE.Scene();
  next.background = new THREE.Color(0x0b0b0d);
  next.add(new THREE.HemisphereLight(0xbfd4ff, 0x14141a, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(5, 7, 8);
  next.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.6);
  fill.position.set(-6, -2, -4);
  next.add(fill);
  return next;
}

function makeLabel(text, opts) {
  const { size = 1, color = "#e8eaf0", background = "rgba(10,10,14,0.55)" } = opts || {};
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  const font = "48px ui-sans-serif, system-ui, sans-serif";
  g.font = font;
  const padding = 24;
  const width = Math.ceil(g.measureText(String(text)).width) + padding * 2;
  canvas.width = Math.max(2, width);
  canvas.height = 96;
  g.font = font;
  g.fillStyle = background;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.fillText(String(text), padding, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.scale.set((size * canvas.width) / canvas.height, size, 1);
  return sprite;
}

function makeContext() {
  return {
    THREE, scene, camera, renderer, controls,
    get width() { return window.innerWidth; },
    get height() { return window.innerHeight; },
    makeLabel,
    setCaption(text) { captionEl.textContent = String(text || ""); },
  };
}

let module_;
try {
  const factory = new Function(
    "ctx",
    '"use strict";\\n' + CODE +
      '\\nreturn { init: typeof init === "function" ? init : null,' +
      ' update: typeof update === "function" ? update : null };',
  );
  scene = makeScene();
  module_ = factory(makeContext());
  if (!module_ || !module_.init || !module_.update) {
    throw new Error("The scene code must define function init(ctx) and function update(ctx, t).");
  }
  module_.init(makeContext());
} catch (error) {
  fail(error && error.stack ? error.stack : error);
}

let playing = true;
let elapsed = 0;
let announced = false;
const clock = new THREE.Clock();

function restart() {
  try {
    scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
      }
    });
    scene = makeScene();
    captionEl.textContent = "";
    errorEl.style.display = "none";
    elapsed = 0;
    module_.init(makeContext());
  } catch (error) {
    fail(error && error.stack ? error.stack : error);
  }
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "scene-control") return;
  if (data.action === "play") { playing = true; clock.getDelta(); }
  if (data.action === "pause") playing = false;
  if (data.action === "restart") restart();
});

renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  if (playing && module_ && module_.update && errorEl.style.display !== "grid") {
    elapsed += delta;
    try {
      module_.update(makeContext(), elapsed);
    } catch (error) {
      fail(error && error.stack ? error.stack : error);
    }
  }
  controls.update();
  if (scene) renderer.render(scene, camera);
  if (!announced) {
    announced = true;
    try { window.parent.postMessage({ type: "scene-ready" }, "*"); } catch {}
  }
});
</script>
</body>
</html>`;
}

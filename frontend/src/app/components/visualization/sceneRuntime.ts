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
import { SCIENTIFIC_HELPERS } from "./scientificHelpers";

const THREE_VERSION = "0.170.0";
const THREE_URL = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.min.js`;
const THREE_ADDONS_URL = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/`;

export const MAX_CODE_CHARS = 60_000;

/** The presentation contract for saved programs and newly generated scenes. */
export const SCENE_THEME = {
  background: "#000000", surface: "#171918", border: "#7d8884",
  ink: "#f4f1e9", muted: "#b9c1bc", data: "#79b8ad",
  process: "#d9ba7d", output: "#9cbfa2", danger: "#d7867f",
} as const;

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
export function buildSceneSrcDoc(code: string, title = ""): string {
  const importMap = JSON.stringify({
    imports: { three: THREE_URL, "three/addons/": THREE_ADDONS_URL },
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
  canvas { display: block; }
  #scene-header {
    position: fixed; inset: 0 0 auto; z-index: 2; box-sizing: border-box;
    display: flex; align-items: baseline; gap: 20px; padding: 24px 36px 12px;
    min-height: 72px;
    background: #000; color: #f4f1e9;
    font: 400 clamp(24px, 3vw, 38px)/1.15 Georgia, 'Times New Roman', serif;
  }
  #scene-title { min-width: 0; flex: 1; }
  #scene-navigation { color: #929d98; font: 11px/1.5 system-ui, sans-serif; flex-shrink: 0; }
  #caption {
    position: fixed; left: 50%; top: 58px; transform: translateX(-50%); z-index: 2;
    width: max-content; max-width: calc(100% - 64px); box-sizing: border-box;
    padding: 8px 16px; text-align: center;
    font: 14px/1.6 Inter, ui-sans-serif, system-ui, sans-serif;
    color: #b9c1bc; background: rgba(0, 0, 0, 0.94);
    pointer-events: none; white-space: pre-wrap;
  }
  #caption:empty { display: none; }
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
<div id="scene-header"><span id="scene-title"></span><span id="scene-navigation"></span></div>
<div id="caption"></div>
<div id="error"></div>
<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const CODE = ${embedAsJson(code)};
const TITLE = ${embedAsJson(title)};
const theme = ${JSON.stringify(SCENE_THEME)};
document.getElementById("scene-title").textContent = TITLE || "Process visualization";

const captionEl = document.getElementById("caption");
const errorEl = document.getElementById("error");

function fail(message) {
  errorEl.textContent = "This animation could not play. Regenerate it to try again.";
  errorEl.style.display = "grid";
  try { window.parent.postMessage({ type: "scene-error", message: String(message) }, "*"); } catch {}
}

window.addEventListener("error", (event) => fail(event.message || "Uncaught error"));
window.addEventListener("unhandledrejection", (event) => fail(event.reason || "Unhandled rejection"));

const renderer = new THREE.WebGLRenderer({ antialias: true });
let contentHeight = window.innerHeight;
let contentWidth = window.innerWidth;
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
  restoreLabels();
  contentHeight = window.innerHeight;
  contentWidth = window.innerWidth;
  if (module_?.resize) module_.resize(context);
  sizePresentation();
  if (scene) fitScene();
});

function sizePresentation() {
  // Older programs have no responsive layout. Give their figures real space
  // instead of crushing a 100-label matrix into a phone-width camera view.
  if (!module_?.resize) {
    const compact = window.innerWidth < 640;
    contentWidth = compact ? 960 : window.innerWidth;
    contentHeight = compact ? Math.max(window.innerHeight,720) : window.innerHeight;
  }
  const wide = contentWidth > window.innerWidth;
  const tall = contentHeight > window.innerHeight;
  document.documentElement.style.overflow = wide || tall ? "auto" : "hidden";
  document.body.style.overflow = wide || tall ? "visible" : "hidden";
  controls.enabled = !wide && !tall;
  renderer.domElement.style.touchAction = wide || tall ? "pan-x pan-y" : "none";
  document.getElementById("scene-navigation").textContent = wide ? "Scroll to explore ↔" : tall ? "Scroll to explore ↓" : "Drag to rotate";
  renderer.setSize(contentWidth, contentHeight);
  camera.aspect = contentWidth / contentHeight;
  camera.updateProjectionMatrix();
}

let scene;
function makeScene() {
  const next = new THREE.Scene();
  next.background = new THREE.Color(0x0b0b0b);
  next.add(new THREE.HemisphereLight(0xffffff, 0x101010, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(5, 7, 8);
  next.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-6, -2, -4);
  next.add(fill);
  return next;
}

const labelMetadata = new WeakMap();
function labelInk(value) {
  if (!value) return theme.ink;
  const color = new THREE.Color(value);
  const hsl = color.getHSL({h:0,s:0,l:0}, THREE.SRGBColorSpace);
  if (hsl.s < 0.18) return hsl.l < 0.8 ? theme.muted : theme.ink;
  color.setHSL(hsl.h, Math.min(hsl.s,0.35), Math.max(0.72,hsl.l), THREE.SRGBColorSpace);
  return "#" + color.getHexString();
}
function paintLabel(text, opts = {}) {
  const color = labelInk(opts.color);
  // Saved programs frequently ask for black ink or white label boxes. The
  // player owns contrast and surfaces; hue still carries semantic meaning.
  const background = "transparent";
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  const font = opts.role === "heading" ? "48px Georgia, serif" : "48px Inter, ui-sans-serif, system-ui, sans-serif";
  g.font = font;
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\\s+/)) {
    if (line && (line + " " + word).length > 28) { lines.push(line); line = word; }
    else line = line ? line + " " + word : word;
  }
  lines.push(line);
  canvas.width = Math.max(2, Math.ceil(Math.max(...lines.map(line => g.measureText(line).width))) + 48);
  canvas.height = 64 * lines.length + 32;
  g.font = font;
  if (String(text).trim()) {
    g.fillStyle = color;
    // A narrow black halo separates ink from geometry without opaque badges.
    g.strokeStyle = "rgba(0,0,0,0.95)"; g.lineWidth = 6; g.lineJoin = "round";
    g.textBaseline = "middle";
    lines.forEach((line, i) => {g.strokeText(line,24,48+i*64);g.fillText(line, 24, 48 + i * 64);});
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeLabel(text, opts = {}) {
  const texture = paintLabel(text, opts);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  }));
  const size = opts.size ?? 1;
  sprite.scale.set(size * texture.image.width / 96, size * texture.image.height / 96, 1);
  sprite.renderOrder = 10;
  sprite.userData.text = String(text);
  labelMetadata.set(sprite, {text:String(text), opts, position:new THREE.Vector3(), scale:new THREE.Vector3(), adjusted:false});
  return sprite;
}

function setLabelText(sprite, text) {
  sprite.userData.text = String(text ?? "");
}

// Keep authored animation coordinates separate from the readability pass.
// Restore before update(), then resolve screen-space label bounds after it.
// Metadata stays outside userData because older saved scenes replace userData.
function restoreLabels() {
  scene?.traverse(object => {
    const meta = labelMetadata.get(object);
    if (meta?.adjusted) {
      object.position.copy(meta.position); object.scale.copy(meta.scale); meta.adjusted = false;
      object.material.rotation = meta.rotation;
    }
  });
}

const guideCanvas = document.createElement("canvas");
guideCanvas.style.cssText = "position:absolute;left:0;top:0;pointer-events:none";
document.body.insertBefore(guideCanvas, captionEl);
const guide = guideCanvas.getContext("2d");
const labelPoint = new THREE.Vector3();
const labelScale = new THREE.Vector3();
const labelLocal = new THREE.Vector3();
function layoutLabels() {
  captionEl.style.top = document.getElementById("scene-header").offsetHeight + 12 + "px";
  const width = renderer.domElement.clientWidth, height = renderer.domElement.clientHeight;
  if (guideCanvas.width !== width || guideCanvas.height !== height) {guideCanvas.width = width; guideCanvas.height = height;}
  guide.clearRect(0,0,width,height);
  scene.updateMatrixWorld(true); camera.updateMatrixWorld();
  const structures=[];
  scene.traverseVisible(object=>{
    if(object.geometry?.type!=="BoxGeometry" || object.material?.opacity<0.05) return;
    if(!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const box=object.geometry.boundingBox;
    let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
    for(const x of [box.min.x,box.max.x]) for(const y of [box.min.y,box.max.y]) for(const z of [box.min.z,box.max.z]) {
      labelPoint.set(x,y,z).applyMatrix4(object.matrixWorld).project(camera);
      const px=(labelPoint.x+1)*width/2,py=(1-labelPoint.y)*height/2;
      left=Math.min(left,px);right=Math.max(right,px);top=Math.min(top,py);bottom=Math.max(bottom,py);
    }
    if(right-left>2 && bottom-top>2 && (right-left)*(bottom-top)<width*height*0.7) structures.push({x:left,y:top,w:right-left,h:bottom-top});
  });
  const labels = [];
  scene.traverseVisible(object => {
    const meta = labelMetadata.get(object);
    if (!meta || object.material.opacity < 0.05) return;
    const text = String(object.userData.text ?? meta.text);
    if (text !== meta.text) {
      object.material.map.dispose(); object.material.map = paintLabel(text,meta.opts); meta.text = text;
    }
    meta.suppressed=Boolean(TITLE)&&text.trim().toLowerCase()===TITLE.trim().toLowerCase();
    if (!text.trim() || meta.suppressed) return;
    // Direction glyphs may rotate; explanatory text must stay upright.
    if (/^[\\s\\u2190-\\u21ff\\u27f0-\\u27ff]+$/.test(text)) return;
    meta.rotation = object.material.rotation;
    object.material.rotation = 0;
    meta.position.copy(object.position); meta.scale.copy(object.scale); meta.adjusted = true;
    object.getWorldPosition(labelPoint);
    labelLocal.copy(labelPoint).applyMatrix4(camera.matrixWorldInverse);
    if (labelLocal.z >= 0) return;
    const pixels = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * -labelLocal.z);
    object.getWorldScale(labelScale);
    // A collapsed sprite/group is an authored hidden state, not tiny text
    // to enlarge. Preserve reveal animations and avoid dividing by zero.
    if (Math.abs(labelScale.x) < 0.01 || Math.abs(labelScale.y) < 0.01) return;
    const canvas = object.material.map.image;
    const font = Math.max(meta.opts.role === "heading" ? 18 : 12, Math.min(meta.opts.role === "heading" ? 26 : 18, Math.abs(labelScale.y) * pixels * 48 / canvas.height));
    const h = font * canvas.height / 48, w = h * canvas.width / canvas.height;
    // Preserve texture aspect even when old scene code calls scale.setScalar().
    object.scale.x = w / pixels / Math.max(0.001,Math.abs(labelScale.x / (object.scale.x || 1)));
    object.scale.y = h / pixels / Math.max(0.001,Math.abs(labelScale.y / (object.scale.y || 1)));
    labelPoint.project(camera);
    // Transparent texture padding is not visible ink; treating it as text
    // would push apart well-spaced rows and add unnecessary leader lines.
    const padding = font * 0.65;
    labels.push({object,meta,annotation:meta.opts.role === "heading" || (text.length>20 && text.split(/\\s+/).length>=3),w:Math.max(1,w-padding),h:Math.max(1,h-padding),
      x:(labelPoint.x+1)*width/2,y:(1-labelPoint.y)*height/2,z:labelPoint.z});
  });
  const placed = [];
  const top = captionEl.textContent ? captionEl.getBoundingClientRect().bottom + 12 : 68;
  const overlap = (a,b) => a.x < b.x+b.w+6 && a.x+a.w+6 > b.x && a.y < b.y+b.h+4 && a.y+a.h+4 > b.y;
  labels.sort((a,b) => a.y-b.y || a.x-b.x);
  for (const item of labels) {
    // Descriptive annotations belong beside a structure. Short token/value
    // labels may intentionally sit inside their own cell or node.
    const obstacles=item.annotation ? placed.concat(structures) : placed;
    const original = {x:item.x-item.w/2,y:item.y-item.h/2,w:item.w,h:item.h};
    const clamp = candidate => ({...candidate,
      x:Math.max(12,Math.min(width-item.w-12,candidate.x)),
      y:Math.max(top,Math.min(height-item.h-12,candidate.y))});
    let rect = clamp(original);
    if (obstacles.some(other => overlap(rect,other))) {
      const candidates = [rect];
      for (const other of obstacles) {
        candidates.push(clamp({...rect,x:other.x+other.w+8}),clamp({...rect,x:other.x-item.w-8}),
          clamp({...rect,y:other.y+other.h+6}),clamp({...rect,y:other.y-item.h-6}));
      }
      // Check nearest positions first and stop at the first clear candidate.
      // Dense matrices otherwise test every candidate against every label.
      candidates.sort((a,b) => (a.x-original.x)**2+(a.y-original.y)**2 - (b.x-original.x)**2-(b.y-original.y)**2);
      const clear = candidates.find(candidate => !obstacles.some(other => overlap(candidate,other)));
      if (clear) rect = clear;
    }
    placed.push(rect);
    const x = rect.x+item.w/2, y = rect.y+item.h/2;
    if (Math.abs(x-item.x)+Math.abs(y-item.y) > 8) {
      guide.strokeStyle = "#6a6a6a"; guide.lineWidth = 1;
      guide.beginPath(); guide.moveTo(item.x,item.y);
      guide.lineTo(Math.max(rect.x,Math.min(rect.x+rect.w,item.x)),Math.max(rect.y,Math.min(rect.y+rect.h,item.y))); guide.stroke();
    }
    labelLocal.set(x/width*2-1,1-y/height*2,item.z).unproject(camera);
    item.object.parent.worldToLocal(labelLocal); item.object.position.copy(labelLocal);
  }
}

function makePanel(title, opts = {}) {
  const { width = 4.4, height = 5, color = "#85a3bd" } = opts;
  const group = new THREE.Group();
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ color: theme.surface, side: THREE.DoubleSide,transparent:true,opacity:0.22,depthWrite:false }));
  surface.position.z = -0.15;
  group.add(surface);
  const border = new THREE.LineSegments(new THREE.EdgesGeometry(surface.geometry),
    new THREE.LineBasicMaterial({ color: theme.border,transparent:true,opacity:0.35 }));
  border.position.z = -0.14;
  group.add(border);
  const label = makeLabel(title, {size: 0.62, color, role:"heading", background: "transparent"});
  label.position.set(0, height / 2 - 0.5, 0.05);
  group.add(label);
  return group;
}

// Signed bars share a baseline and label their values. Generate these once;
// animate their parent group or the returned group's children afterwards.
function makeBars(values, opts = {}) {
  const { width = 3.5, height = 1.7, maxValue = 2, color = "#85a3bd" } = opts;
  const group = new THREE.Group();
  const step = width / Math.max(1, values.length);
  const geometry = new THREE.BoxGeometry(step * 0.56, 1, 0.12);
  const material = new THREE.MeshBasicMaterial({color});
  values.forEach((value, i) => {
    const h = Math.min(height, Math.abs(value) / Math.max(0.001, maxValue) * height);
    const bar = new THREE.Mesh(geometry, material);
    bar.scale.y = Math.max(0.015, h);
    bar.position.set(-width / 2 + step * (i + 0.5), Math.sign(value) * h / 2, 0.05);
    group.add(bar);
    const label = makeLabel(Number(value).toFixed(2), {size: 0.4, background: "transparent"});
    label.position.set(bar.position.x, -height - 0.35, 0.15);
    group.add(label);
  });
  const baseline = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-width/2, 0, 0.1), new THREE.Vector3(width/2, 0, 0.1),
  ]), new THREE.LineBasicMaterial({color: 0x6b7e99}));
  group.add(baseline);
  return group;
}

// Frame geometry and label anchors. Authored sprite rectangles can be enormous;
// including those before the screen-space text pass made the actual figure tiny.
function fitScene() {
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  scene.traverse(object=>{
    if(object.isGridHelper || object.isAxesHelper) return;
    if(object.isSprite) {bounds.expandByPoint(object.getWorldPosition(new THREE.Vector3()));return;}
    if(!object.geometry) return;
    if(!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    if(object.geometry.boundingBox) bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
  });
  if (bounds.isEmpty()) return;
  bounds.expandByScalar(0.8);
  const center = bounds.getCenter(new THREE.Vector3());
  if (![...center.toArray(), ...bounds.max.toArray(), ...bounds.min.toArray()].every(Number.isFinite)) return;
  const direction = camera.position.clone().sub(controls.target).normalize();
  if (direction.lengthSq() < 0.01) direction.set(0, 0, 1);
  camera.position.copy(center).add(direction);
  camera.lookAt(center);
  const inverse = camera.quaternion.clone().invert();
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const verticalFill = contentHeight > window.innerHeight ? 0.92 : 0.72;
  let distance = 1;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const corner = new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverse);
        distance = Math.max(distance, corner.z + Math.max(
          Math.abs(corner.x) / (tangent * camera.aspect * 0.84),
          Math.abs(corner.y) / (tangent * verticalFill),
        ));
      }
    }
  }
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.far = Math.max(500, distance * 10);
  camera.updateProjectionMatrix();
  controls.update();
}

${SCIENTIFIC_HELPERS}

function makeContext() {
  return {
    THREE, scene, camera, renderer, controls, theme,
    get width() { return window.innerWidth; },
    get height() { return window.innerHeight; },
    makeLabel, makePanel, makeBars, makeMatrix, makeNetwork, setLabelText,
    setContentHeight(height) {
      contentHeight = Math.max(window.innerHeight, Math.min(6000, Number(height) || window.innerHeight));
      contentWidth = window.innerWidth;
      sizePresentation();
    },
    setCaption(text) { captionEl.textContent = String(text || ""); },
  };
}

let module_;
let factory;
let context;
try {
  factory = new Function(
    "ctx",
    '"use strict";\\n' + CODE +
      '\\nreturn { init: typeof init === "function" ? init : null,' +
      ' update: typeof update === "function" ? update : null,' +
      ' resize: typeof resize === "function" ? resize : null };',
  );
  scene = makeScene();
  context = makeContext();
  module_ = factory(context);
  if (!module_ || !module_.init || !module_.update) {
    throw new Error("The scene code must define function init(ctx) and function update(ctx, t).");
  }
  module_.init(context);
  if (module_.resize) module_.resize(context);
  module_.update(context, 0);
  sizePresentation();
  fitScene();
} catch (error) {
  fail(error && error.stack ? error.stack : error);
}

let playing = true;
let elapsed = 0;
let announced = false;
const clock = new THREE.Clock();

// Styling is a render-time projection. Restore source values afterwards:
// saved programs sometimes use material colors in their own computations.
const presentationColors = new WeakMap();
const colorRestores = [];
const materialRestores = [];
const lightRestores = [];
const styledMaterials = new Set();
const styledColors = new Set();
const backgroundColor = new THREE.Color(theme.background);
const workingHsl = {h:0,s:0,l:0};
// One batched outline pass for existing block/vector/matrix geometry. It lives
// outside the authored scene graph so child indices and animation logic stay intact.
const figureEdges = new WeakMap();
const outlineScene = new THREE.Scene();
const outlineGeometry = new THREE.BufferGeometry();
let outlinePositions = new Float32Array(12288);
let outlineColors = new Float32Array(12288);
function allocateOutlines() {
  outlineGeometry.setAttribute("position",new THREE.BufferAttribute(outlinePositions,3).setUsage(THREE.DynamicDrawUsage));
  outlineGeometry.setAttribute("color",new THREE.BufferAttribute(outlineColors,3).setUsage(THREE.DynamicDrawUsage));
}
allocateOutlines();
const outlineLines = new THREE.LineSegments(outlineGeometry,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:0.55,depthTest:false,toneMapped:false}));
outlineLines.frustumCulled=false;outlineScene.add(outlineLines);
const outlinePoint=new THREE.Vector3(), outlineInk=new THREE.Color(), outlineLightInk=new THREE.Color(theme.ink);
let outlineCount=0;
function outlineFigure(object) {
  if(object.geometry?.type!=="BoxGeometry" || !object.material?.color || object.material.opacity<0.05) return;
  let vertices=figureEdges.get(object.geometry);
  if(!vertices) {
    const edges=new THREE.EdgesGeometry(object.geometry);vertices=edges.attributes.position.array.slice();edges.dispose();
    figureEdges.set(object.geometry,vertices);
  }
  if(outlineCount+vertices.length>outlinePositions.length) {
    const size=Math.max(outlinePositions.length*2,outlineCount+vertices.length);
    const positions=new Float32Array(size),colors=new Float32Array(size);
    positions.set(outlinePositions);colors.set(outlineColors);
    outlinePositions=positions;outlineColors=colors;allocateOutlines();
  }
  outlineInk.copy(object.material.color).lerp(outlineLightInk,0.5);
  for(let i=0;i<vertices.length;i+=3) {
    outlinePoint.fromArray(vertices,i).applyMatrix4(object.matrixWorld).toArray(outlinePositions,outlineCount);
    outlineInk.toArray(outlineColors,outlineCount);outlineCount+=3;
  }
}
function presentColor(color, emissive = false) {
  if (!color?.isColor || styledColors.has(color)) return;
  styledColors.add(color);
  let record = presentationColors.get(color);
  if (!record) {record={color,source:new THREE.Color(),display:new THREE.Color(),valid:false};presentationColors.set(color,record);}
  if (!record.valid || !record.source.equals(color) || record.emissive !== emissive) {
    record.source.copy(color); record.emissive=emissive; record.valid=true;
    color.getHSL(workingHsl,THREE.SRGBColorSpace);
    // Preserve hue and ordered color scales; reduce saturation instead of
    // collapsing distinct scientific values to a handful of palette colors.
    const lightness = emissive ? workingHsl.l : workingHsl.s < 0.12
      ? Math.min(workingHsl.l,0.72) : Math.max(0.38,Math.min(workingHsl.l,0.72));
    record.display.setHSL(workingHsl.h,Math.min(workingHsl.s,0.35),lightness,THREE.SRGBColorSpace);
  }
  colorRestores.push(record); color.copy(record.display);
}

function renderScene() {
  outlineCount=0;
  const autoReset=renderer.info.autoReset;
  renderer.info.autoReset=false;renderer.info.reset();
  colorRestores.length=0; materialRestores.length=0; lightRestores.length=0;
  styledMaterials.clear(); styledColors.clear();
  const authoredBackground=scene.background;
  scene.background=backgroundColor;
  try {
    scene.traverseVisible(object => {
      outlineFigure(object);
      if (object.isLight) {
        lightRestores.push({light:object,intensity:object.intensity,color:object.color.clone()});
        object.color.set(0xffffff);
        object.intensity=Math.min(object.intensity,object.isPointLight ? 4 : 1.5);
      }
      const materials=Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const material of materials) {
        if (styledMaterials.has(material)) continue;
        styledMaterials.add(material);
        if (labelMetadata.has(object)) {
          materialRestores.push({material,opacity:material.opacity});
          if(labelMetadata.get(object).suppressed) material.opacity=0;
          else if (material.opacity > 0.05) material.opacity=Math.max(0.75,material.opacity);
          continue;
        }
        presentColor(material.color); presentColor(material.emissive,true);
        materialRestores.push({material,roughness:material.roughness,metalness:material.metalness,emissiveIntensity:material.emissiveIntensity,
          opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite});
        if(object.geometry?.type === "BoxGeometry") {
          material.opacity=Math.min(material.opacity,0.32);material.transparent=true;material.depthWrite=false;
        }
        if (typeof material.roughness === "number") material.roughness=Math.max(material.roughness,0.85);
        if (typeof material.metalness === "number") material.metalness=Math.min(material.metalness,0.05);
        if (typeof material.emissiveIntensity === "number") material.emissiveIntensity=0.35*material.emissiveIntensity/(1+Math.max(0,material.emissiveIntensity));
      }
    });
    renderer.render(scene, camera);
    if(outlineCount) {
      outlineGeometry.setDrawRange(0,outlineCount/3);
      outlineGeometry.attributes.position.needsUpdate=true;outlineGeometry.attributes.color.needsUpdate=true;
      const autoClear=renderer.autoClear;renderer.autoClear=false;
      try {renderer.render(outlineScene,camera);} finally {renderer.autoClear=autoClear;}
    }
  } finally {
    renderer.info.autoReset=autoReset;
    scene.background=authoredBackground;
    for (const record of colorRestores) record.color.copy(record.source);
    for (const record of materialRestores) {
      if(record.roughness!==undefined) record.material.roughness=record.roughness;
      if(record.metalness!==undefined) record.material.metalness=record.metalness;
      if(record.emissiveIntensity!==undefined) record.material.emissiveIntensity=record.emissiveIntensity;
      if(record.opacity!==undefined) record.material.opacity=record.opacity;
      if(record.transparent!==undefined) record.material.transparent=record.transparent;
      if(record.depthWrite!==undefined) record.material.depthWrite=record.depthWrite;
    }
    for (const record of lightRestores) {record.light.intensity=record.intensity;record.light.color.copy(record.color);}
  }
}

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
    context = makeContext();
    module_ = factory(context);
    module_.init(context);
    if (module_.resize) module_.resize(context);
    module_.update(context, 0);
    sizePresentation();
    fitScene();
    clock.getDelta();
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
  restoreLabels();
  if (playing && module_ && module_.update && errorEl.style.display !== "grid") {
    elapsed += delta;
    try {
      module_.update(context, elapsed);
    } catch (error) {
      fail(error && error.stack ? error.stack : error);
    }
  }
  controls.update();
  if (scene) { layoutLabels(); renderScene(); }
  if (!announced && module_ && errorEl.style.display !== "grid") {
    announced = true;
    try { window.parent.postMessage({ type: "scene-ready" }, "*"); } catch {}
  }
});
</script>
</body>
</html>`;
}

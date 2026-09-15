/**
 * Run a scene once, off-screen, and return the browser's verdict.
 *
 * The backend can check that generated code parses and obeys the contract;
 * it cannot run Three.js. This is the missing half: an invisible sandboxed
 * frame (same `sandbox="allow-scripts"` boundary as the player) loads the
 * scene in probe mode, which sweeps `update` across a full cycle and
 * measures label overlaps, then posts one `scene-verified` message. A scene
 * is only ever called ready after this has passed.
 */
import {
  buildSceneSrcDoc,
  summarizeProbe,
  type RuntimeVerdict,
  type SceneFrameMessage,
} from "./sceneRuntime";

export const PROBE_TIMEOUT_MS = 30_000;
// WebGL contexts are scarce (browsers cap them around 16 per page) and each
// probe holds one. Two at a time keeps prepare-all fast without evicting the
// scene the user is watching.
const MAX_CONCURRENT_PROBES = 2;

let active = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_PROBES) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release(): void {
  active -= 1;
  waiting.shift()?.();
}

export type ProbeOptions = {
  timeoutMs?: number;
  /** Where the hidden frame is mounted; defaults to the page's document. */
  host?: Document;
};

function timedOut(timeoutMs: number): RuntimeVerdict {
  return {
    status: "failed",
    error:
      `The animation did not report within ${Math.round(timeoutMs / 1000)}s. ` +
      "Either init or update never returns (an infinite loop), or three.js could not be loaded.",
    overlaps: [],
    samples: 0,
  };
}

function runProbe(code: string, title: string, options: ProbeOptions): Promise<RuntimeVerdict> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const host = options.host ?? document;
  return new Promise((resolve) => {
    const frame = host.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("data-testid", "scene-probe");
    frame.title = `Verifying scene: ${title}`;
    // Off-screen rather than display:none: a hidden frame gets no WebGL
    // context and no layout, and the overlap measurement needs both.
    frame.style.cssText =
      "position:fixed;left:-10000px;top:0;width:960px;height:600px;opacity:0;pointer-events:none;border:0;";

    let settled = false;
    const finish = (verdict: RuntimeVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(verdict);
    };
    const onMessage = (event: MessageEvent<SceneFrameMessage>) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data;
      if (data?.type === "scene-verified") finish(summarizeProbe(data));
      else if (data?.type === "scene-error") {
        finish({ status: "failed", error: data.message, overlaps: [], samples: 0 });
      }
    };
    const timer = setTimeout(() => finish(timedOut(timeoutMs)), timeoutMs);

    window.addEventListener("message", onMessage);
    frame.srcdoc = buildSceneSrcDoc(code, title, { probe: true });
    host.body.appendChild(frame);
  });
}

/** Execute the scene off-screen and resolve with what happened. Never rejects. */
export async function probeScene(
  code: string,
  title: string,
  options: ProbeOptions = {},
): Promise<RuntimeVerdict> {
  await acquire();
  try {
    return await runProbe(code, title, options);
  } finally {
    release();
  }
}

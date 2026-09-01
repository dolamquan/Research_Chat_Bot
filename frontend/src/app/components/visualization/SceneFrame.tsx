import { useEffect, useMemo, useRef } from "react";

import { buildSceneSrcDoc, type SceneFrameMessage } from "./sceneRuntime";

/**
 * The sandboxed host for one generated scene.
 *
 * `sandbox="allow-scripts"` (and nothing else) is the security boundary: the
 * document gets an opaque origin with no cookies, no storage, and no way to
 * reach this page except postMessage — which this component is the only
 * listener for, and which it filters by source window.
 */
export function SceneFrame({
  code,
  title,
  playing = true,
  restartToken = 0,
  onReady,
  onError,
  className = "",
}: {
  code: string;
  title: string;
  /** Pausing does not unmount; the harness keeps the last frame visible. */
  playing?: boolean;
  /** Increment to rebuild the scene from t=0 inside the same frame. */
  restartToken?: number;
  onReady?: () => void;
  onError?: (message: string) => void;
  className?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => buildSceneSrcDoc(code), [code]);

  useEffect(() => {
    const handler = (event: MessageEvent<SceneFrameMessage>) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type === "scene-ready") onReady?.();
      if (event.data?.type === "scene-error") onError?.(event.data.message);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onReady, onError]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "scene-control", action: playing ? "play" : "pause" },
      "*",
    );
  }, [playing]);

  useEffect(() => {
    if (restartToken > 0) {
      frameRef.current?.contentWindow?.postMessage(
        { type: "scene-control", action: "restart" },
        "*",
      );
    }
  }, [restartToken]);

  return (
    <iframe
      ref={frameRef}
      title={`Scene: ${title}`}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className={`h-full w-full border-0 ${className}`}
      data-testid="scene-frame"
    />
  );
}

export default SceneFrame;

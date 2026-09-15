import { useMemo, useState } from "react";
import { Code2, Pause, Play, RotateCcw } from "lucide-react";

import SceneFrame from "./SceneFrame";
import SceneRefinePanel, { type RefineHandler } from "./SceneRefinePanel";
import { checkSceneCode } from "./sceneRuntime";
import {
  sceneDivergesFromPaper,
  sceneRuntimeStatus,
  type PlayableSceneRecord,
  type SceneVerificationReport,
} from "./sceneTypes";

/**
 * The player for one generated scene-code record: the sandboxed frame plus
 * playback controls, an error banner, and a source viewer.
 *
 * Before mounting anything, the code is re-checked against the same static
 * contract the backend enforced at generation time. A record that fails —
 * tampered storage, or a contract that tightened since it was stored — is
 * refused with the reasons listed, never executed.
 *
 * Passing the static checks is not the same as running: the runtime status
 * shown under the controls says whether the browser has actually executed
 * this code through a full cycle, and a crash in the live frame can be sent
 * back as a repair when the host provides `onRepair`.
 */
export function SceneCodePlayer({
  record,
  className = "",
  onRepair,
  onRefine,
  verifying = false,
}: {
  record: PlayableSceneRecord & { verification?: SceneVerificationReport };
  className?: string;
  /** Regenerate the stored code against the crash the frame just reported. */
  onRepair?: (runtimeError: string) => void;
  /** Apply a user-described change; see `SceneRefinePanel`. */
  onRefine?: RefineHandler;
  /** The scene is being probed off-screen right now. */
  verifying?: boolean;
}) {
  const { scene } = record;
  const findings = useMemo(() => checkSceneCode(scene.code), [scene.code]);
  const runtimeStatus = sceneRuntimeStatus(record);

  const [playing, setPlaying] = useState(true);
  const [restartToken, setRestartToken] = useState(0);
  const [showCode, setShowCode] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  if (findings.length > 0) {
    return (
      <div
        className={`rounded-lg border border-pen-red/40 bg-pen-red/10 p-4 ${className}`}
        data-testid="scene-code-blocked"
      >
        <div className="mb-1 text-xs font-medium text-pen-red">
          Scene code refused
        </div>
        <p className="mb-2 text-xs leading-relaxed text-pen-red">
          This stored scene no longer passes the code contract, so it was not
          run:
        </p>
        <ul className="list-inside list-disc text-[11px] leading-relaxed text-pen-red">
          {findings.map((finding) => (
            <li key={finding}>{finding}</li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-ivory-500">
          Regenerate the scene to replace it.
        </p>
      </div>
    );
  }

  const statusText = verifying
    ? "Verifying: running a full cycle off-screen…"
    : runtimeStatus === "passed"
      ? "Verified: runs through a full cycle"
      : runtimeStatus === "failed"
        ? "Crashed the last time it ran"
        : "Not yet run in the browser";
  const statusTone = verifying
    ? "text-accent-300 animate-pulse"
    : runtimeStatus === "passed"
      ? "text-ivory-300"
      : runtimeStatus === "failed"
        ? "text-pen-red"
        : "text-ivory-500";

  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`} data-testid="scene-code-player">
      <div className="relative min-h-[18rem] flex-1 overflow-hidden rounded-lg border border-desk-700 bg-desk-950">
        {showCode ? (
          <pre
            className="h-full overflow-auto p-3 font-mono text-[11px] leading-relaxed text-ivory-500"
            data-testid="scene-code-source"
          >
            {scene.code}
          </pre>
        ) : (
          <SceneFrame
            code={scene.code}
            title={scene.title || scene.algorithm_name}
            playing={playing}
            restartToken={restartToken}
            onError={setRuntimeError}
          />
        )}
      </div>

      {runtimeError ? (
        <div
          className="max-h-32 overflow-auto rounded border border-pen-red/40 bg-pen-red/10 px-2 py-1.5"
          data-testid="scene-runtime-error"
        >
          <p className="font-mono text-[10px] leading-relaxed text-pen-red">
            The scene crashed while running: {runtimeError}
          </p>
          {onRepair ? (
            <button
              type="button"
              onClick={() => onRepair(runtimeError)}
              title="Send this error back to the model and fix the existing scene"
              className="mt-1 rounded border border-pen-red/50 px-2 py-0.5 text-[11px] text-pen-red hover:bg-pen-red/20"
            >
              Repair animation
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setPlaying((value) => !value)}
          className="flex items-center gap-1 rounded border border-desk-700 px-2 py-1 text-xs text-ivory-100 hover:bg-desk-800"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={() => {
            setRuntimeError(null);
            setRestartToken((value) => value + 1);
          }}
          className="flex items-center gap-1 rounded border border-desk-700 px-2 py-1 text-xs text-ivory-100 hover:bg-desk-800"
        >
          <RotateCcw className="h-3 w-3" />
          Restart
        </button>
        <button
          type="button"
          onClick={() => setShowCode((value) => !value)}
          className={`ml-auto flex items-center gap-1 rounded border px-2 py-1 text-xs ${
            showCode
              ? "border-accent-400 bg-accent-400/10 text-accent-300"
              : "border-desk-700 text-ivory-100 hover:bg-desk-800"
          }`}
        >
          <Code2 className="h-3 w-3" />
          {showCode ? "Scene" : "Code"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <span data-testid="scene-runtime-status" className={statusTone}>
          {statusText}
        </span>
        {sceneDivergesFromPaper(scene) ? (
          <span className="rounded border border-pen-red/50 px-1.5 py-0.5 text-pen-red">
            Diverges from the paper
          </span>
        ) : null}
      </div>

      {scene.summary ? (
        <p className="text-[11px] leading-relaxed text-ivory-500">{scene.summary}</p>
      ) : null}

      {onRefine ? (
        <SceneRefinePanel
          className="border-t border-desk-800 pt-2"
          onRefine={onRefine}
          edits={scene.edits}
          busy={verifying}
        />
      ) : null}

      <p className="text-[10px] leading-relaxed text-ivory-700">
        Generated code runs in a sandboxed frame with no network, storage, or
        page access. It is model-written and not verified against the paper.
      </p>
    </div>
  );
}

export default SceneCodePlayer;

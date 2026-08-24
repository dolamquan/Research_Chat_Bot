import type { PlaybackState } from "./usePlayback";
import { SPEED_OPTIONS } from "./usePlayback";
import type { AlgorithmScene, VisualizationMode } from "./sceneTypes";
import { stepIsUncertain } from "./sceneValidation";

/**
 * Transport controls, timeline and the current step's caption.
 *
 * Plain DOM rather than anything inside the canvas, so it stays usable when
 * WebGL is unavailable and so the buttons are reachable by keyboard and screen
 * readers without extra work.
 */
export function SceneControls({
  scene,
  playback,
  mode,
  onModeChange,
  reducedMotion,
}: {
  scene: AlgorithmScene;
  playback: PlaybackState;
  mode: VisualizationMode;
  onModeChange: (mode: VisualizationMode) => void;
  reducedMotion?: boolean;
}) {
  const { currentStep, stepIndex, playing, timeline, speed } = playback;
  const total = scene.steps.length;
  const uncertain = currentStep ? stepIsUncertain(currentStep) : false;

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-zinc-700/80 bg-zinc-900/90 px-3 py-2"
      data-testid="scene-controls"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={playback.previous}
          disabled={stepIndex === 0}
          aria-label="Previous step"
          data-testid="scene-prev"
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 disabled:opacity-40 hover:border-zinc-500"
        >
          Prev
        </button>
        <button
          type="button"
          onClick={playback.toggle}
          aria-label={playing ? "Pause" : "Play"}
          data-testid="scene-playpause"
          className="rounded border border-teal-600 bg-teal-600/20 px-3 py-1 text-xs font-medium text-teal-200 hover:bg-teal-600/30"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={playback.next}
          disabled={stepIndex >= total - 1}
          aria-label="Next step"
          data-testid="scene-next"
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 disabled:opacity-40 hover:border-zinc-500"
        >
          Next
        </button>
        <button
          type="button"
          onClick={playback.restart}
          aria-label="Restart"
          data-testid="scene-restart"
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
        >
          Restart
        </button>

        <label className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-widest text-zinc-500">
          Speed
          <select
            value={speed}
            onChange={(event) => playback.setSpeed(Number(event.target.value))}
            aria-label="Playback speed"
            data-testid="scene-speed"
            className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs text-zinc-200"
          >
            {SPEED_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}x
              </option>
            ))}
          </select>
        </label>

        <div className="flex overflow-hidden rounded border border-zinc-700" role="group" aria-label="Visualization mode">
          {(["2d", "2_5d", "3d"] as VisualizationMode[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onModeChange(option)}
              aria-pressed={mode === option}
              data-testid={`scene-mode-${option}`}
              className={[
                "px-2 py-1 text-xs transition-colors",
                mode === option
                  ? "bg-teal-600/30 text-teal-200"
                  : "text-zinc-400 hover:text-zinc-200",
              ].join(" ")}
            >
              {option === "2_5d" ? "2.5D" : option.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={stepIndex}
          onChange={(event) => playback.seekStep(Number(event.target.value))}
          aria-label="Timeline"
          data-testid="scene-timeline"
          className="h-1 flex-1 accent-teal-400"
        />
        <span className="font-mono text-[10px] tabular-nums text-zinc-500" data-testid="scene-position">
          {total === 0 ? "0/0" : `${stepIndex + 1}/${total}`}
        </span>
      </div>

      <div className="h-0.5 w-full overflow-hidden rounded bg-zinc-800">
        <div
          className="h-full bg-teal-400/70 transition-[width] duration-100"
          style={{ width: `${Math.round(timeline * 100)}%` }}
        />
      </div>

      {currentStep ? (
        <div className="pt-0.5" data-testid="scene-caption">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              {currentStep.primitive}
            </span>
            {currentStep.execution !== "sequential" ? (
              <span className="rounded bg-zinc-800 px-1 font-mono text-[9px] uppercase text-zinc-400">
                {currentStep.execution}
              </span>
            ) : null}
            <span
              title={
                uncertain
                  ? "This step cites no paper evidence, or reports low confidence."
                  : "Supported by cited evidence"
              }
              data-testid="scene-confidence"
              className={[
                "ml-auto rounded px-1.5 font-mono text-[9px] uppercase tracking-wide",
                uncertain
                  ? "border border-dashed border-amber-500/70 text-amber-300"
                  : "border border-teal-700 text-teal-300",
              ].join(" ")}
            >
              {uncertain ? "uncertain" : `${Math.round(currentStep.confidence * 100)}%`}
            </span>
          </div>
          <p className="mt-0.5 text-xs leading-snug text-zinc-200">{currentStep.caption}</p>
          {currentStep.label_in || currentStep.label_out ? (
            <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
              {currentStep.label_in || "?"} &rarr; {currentStep.label_out || "?"}
            </p>
          ) : null}
        </div>
      ) : null}

      {reducedMotion ? (
        <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">
          reduced motion: step manually
        </p>
      ) : null}
    </div>
  );
}

export default SceneControls;

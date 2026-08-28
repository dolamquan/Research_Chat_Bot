import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";

import CompiledStep from "./SceneCompiler";
import Scene2DView from "./Scene2DView";
import SceneControls from "./SceneControls";
import SceneEvidencePanel from "./SceneEvidencePanel";
import { sanitizeScene } from "./sceneValidation";
import { usePlayback, usePrefersReducedMotion } from "./usePlayback";
import type { SceneVerificationReport, VisualizationMode } from "./sceneTypes";

/**
 * The interactive player for one `AlgorithmScene`.
 *
 * Takes an untrusted scene payload, sanitises it, and drives 2D, 2.5D and 3D
 * off the same object -- switching mode changes only how the steps are drawn,
 * never what they are, so no regeneration happens and entity ids stay stable
 * across views.
 */
export function ScenePlayer({
  sceneInput,
  verification,
  initialMode,
  autoPlay = false,
  className = "",
  sideBySide = false,
}: {
  sceneInput: unknown;
  verification?: SceneVerificationReport | null;
  initialMode?: VisualizationMode;
  autoPlay?: boolean;
  className?: string;
  /** Put the evidence panel beside the diagram. Only for wide containers. */
  sideBySide?: boolean;
}) {
  const { scene, issues, usable } = useMemo(() => sanitizeScene(sceneInput), [sceneInput]);
  const reducedMotion = usePrefersReducedMotion();
  const playback = usePlayback(scene.steps, { autoPlay, loop: true, reducedMotion });

  const [mode, setMode] = useState<VisualizationMode>(
    initialMode ?? scene.visualization_mode,
  );
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

  // The scene chooses its own mode; respect that when a different scene loads,
  // unless the caller pinned one.
  useEffect(() => {
    if (!initialMode) setMode(scene.visualization_mode);
  }, [scene.visualization_mode, initialMode]);

  const currentStep = playback.currentStep;

  if (!usable) {
    return (
      <div
        className={`grid place-items-center rounded-lg border border-zinc-700/80 bg-zinc-900/70 p-6 ${className}`}
        data-testid="scene-player-empty"
      >
        <div className="max-w-sm text-center">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            no scene to play
          </div>
          <p className="text-xs leading-snug text-zinc-400">
            {issues.length > 0
              ? issues[0].message
              : "This visualization has no generated scene yet."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`} data-testid="scene-player">
      <div
        className={`flex min-h-0 flex-1 gap-2 ${
          sideBySide ? "flex-row" : "flex-col"
        }`}
      >
        <div className="relative min-h-[18rem] flex-1 overflow-hidden rounded-lg border border-zinc-700/80 bg-[#0b0b0d]">
          {mode === "2d" ? (
            <Scene2DView
              scene={scene}
              activeStep={currentStep}
              selectedEntityId={selectedEntityId}
              onSelectEntity={setSelectedEntityId}
            />
          ) : (
            <Canvas
              camera={{ position: [0, 1.5, 12], fov: 45 }}
              dpr={[1, 2]}
              data-testid="scene-canvas"
            >
              <color attach="background" args={["#0b0b0d"]} />
              <hemisphereLight args={["#bfd4ff", "#14141a", 1.1]} />
              <directionalLight position={[5, 7, 8]} intensity={1.5} />
              <directionalLight position={[-6, -2, -4]} intensity={0.6} color="#88aaff" />

              {/* Every step is mounted; only the active one animates. The
                  others stay visible and dimmed so the reader keeps the whole
                  method in view rather than losing context at each cut. */}
              {scene.steps.map((step, index) => (
                <CompiledStep
                  key={step.id}
                  scene={scene}
                  step={step}
                  t={index === playback.stepIndex ? playback.progress : 1}
                  dimmed={index !== playback.stepIndex}
                  depthIndex={index - playback.stepIndex}
                  mode={mode}
                  onSelectEntity={setSelectedEntityId}
                />
              ))}

              <OrbitControls
                enablePan={false}
                enableZoom
                enableRotate={mode === "3d"}
                target={[0, 0, 0]}
              />
            </Canvas>
          )}
        </div>

        <div
          className={
            sideBySide ? "w-72 shrink-0" : "max-h-[15rem] shrink-0"
          }
        >
          <SceneEvidencePanel
            scene={scene}
            verification={verification ?? null}
            selectedEntityId={selectedEntityId}
            activeStepId={currentStep?.id ?? null}
            onClearSelection={() => setSelectedEntityId(null)}
          />
        </div>
      </div>

      <SceneControls
        scene={scene}
        playback={playback}
        mode={mode}
        onModeChange={setMode}
        reducedMotion={reducedMotion}
      />

      {issues.length > 0 ? (
        <p
          className="font-mono text-[9px] leading-snug text-amber-500/80"
          data-testid="scene-issues"
        >
          {issues.length} scene issue(s) were repaired on load: {issues[0].message}
        </p>
      ) : null}
    </div>
  );
}

export default ScenePlayer;

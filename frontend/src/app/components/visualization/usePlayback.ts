import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SceneStep } from "./sceneTypes";

/**
 * Playback state for a scene.
 *
 * Timing comes from each step's own `duration_ms`, so the walkthrough is
 * driven by the Scene IR rather than by a timeline hardcoded for one
 * architecture. Kept as a hook, separate from any renderer, so the controls,
 * the 2D view and the 3D view all read the same clock and stay in step, and so
 * it can be unit-tested without a WebGL context.
 */

export type PlaybackState = {
  stepIndex: number;
  /** 0..1 progress through the current step. */
  progress: number;
  playing: boolean;
  speed: number;
  /** 0..1 progress through the whole scene. */
  timeline: number;
  currentStep: SceneStep | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  restart: () => void;
  seekStep: (index: number) => void;
  setSpeed: (speed: number) => void;
};

export const SPEED_OPTIONS = [0.5, 1, 1.5, 2] as const;

/** Honour the OS "reduce motion" setting; SSR-safe. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function usePlayback(
  steps: SceneStep[],
  options: { autoPlay?: boolean; loop?: boolean; reducedMotion?: boolean } = {},
): PlaybackState {
  const { autoPlay = false, loop = true, reducedMotion = false } = options;

  // With reduced motion the scene never animates itself; the reader steps
  // through it manually and each step is shown at its final state.
  const [playing, setPlaying] = useState(autoPlay && !reducedMotion);
  const [stepIndex, setStepIndex] = useState(0);
  const [progress, setProgress] = useState(reducedMotion ? 1 : 0);
  const [speed, setSpeed] = useState(1);

  const frameRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);

  const total = steps.length;
  const durations = useMemo(
    () => steps.map((step) => Math.max(200, step.duration_ms)),
    [steps],
  );

  // A scene swap must not leave the index pointing past the new step list.
  useEffect(() => {
    setStepIndex(0);
    setProgress(reducedMotion ? 1 : 0);
  }, [total, reducedMotion]);

  useEffect(() => {
    if (!playing || total === 0 || reducedMotion) return undefined;

    lastRef.current = performance.now();
    const tick = (now: number) => {
      const elapsed = now - lastRef.current;
      lastRef.current = now;

      setProgress((current) => {
        const duration = durations[stepIndex] ?? 1200;
        const advanced = current + (elapsed * speed) / duration;
        if (advanced < 1) return advanced;

        // Step boundary. Advancing the index inside this updater would be a
        // side effect during render, so it is deferred to a microtask.
        queueMicrotask(() => {
          setStepIndex((index) => {
            if (index + 1 < total) return index + 1;
            if (loop) return 0;
            setPlaying(false);
            return index;
          });
        });
        return loop || stepIndex + 1 < total ? 0 : 1;
      });

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [playing, stepIndex, speed, total, loop, durations, reducedMotion]);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => setPlaying((value) => !value), []);

  const seekStep = useCallback(
    (index: number) => {
      if (total === 0) return;
      const clamped = Math.max(0, Math.min(index, total - 1));
      setStepIndex(clamped);
      setProgress(reducedMotion ? 1 : 0);
    },
    [total, reducedMotion],
  );

  const next = useCallback(() => {
    setStepIndex((index) => {
      const target = Math.min(index + 1, Math.max(0, total - 1));
      return target;
    });
    setProgress(reducedMotion ? 1 : 0);
  }, [total, reducedMotion]);

  const previous = useCallback(() => {
    setStepIndex((index) => Math.max(0, index - 1));
    setProgress(reducedMotion ? 1 : 0);
  }, [reducedMotion]);

  const restart = useCallback(() => {
    setStepIndex(0);
    setProgress(reducedMotion ? 1 : 0);
  }, [reducedMotion]);

  const timeline = useMemo(() => {
    if (total === 0) return 0;
    const totalMs = durations.reduce((a, b) => a + b, 0) || 1;
    const elapsed =
      durations.slice(0, stepIndex).reduce((a, b) => a + b, 0) +
      (durations[stepIndex] ?? 0) * progress;
    return Math.max(0, Math.min(1, elapsed / totalMs));
  }, [durations, stepIndex, progress, total]);

  return {
    stepIndex,
    progress,
    playing,
    speed,
    timeline,
    currentStep: steps[stepIndex] ?? null,
    play,
    pause,
    toggle,
    next,
    previous,
    restart,
    seekStep,
    setSpeed,
  };
}

import { useCallback, useEffect, useRef } from "react";

/**
 * The recogniser exposes no audio, so a second, analysis-only microphone
 * stream drives the orb while the user speaks. Values land in a ref (0..1)
 * so nothing re-renders per frame.
 */
export function useMicLevel(enabled: boolean, onDenied: () => void) {
  const level = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const onDeniedRef = useRef(onDenied);
  onDeniedRef.current = onDenied;

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
    level.current = 0;
  }, []);

  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") return;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const context = new AudioContext();
        contextRef.current = context;
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        const buffer = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buffer);
          let sum = 0;
          for (let i = 0; i < buffer.length; i += 1) {
            const v = (buffer[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buffer.length);
          const gated = rms < 0.02 ? 0 : Math.min(1, (rms - 0.02) * 4);
          // Fast attack, slow release.
          level.current = gated > level.current ? gated : level.current * 0.88 + gated * 0.12;
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const name = (error as { name?: string })?.name;
        if (name === "NotAllowedError" || name === "SecurityError") onDeniedRef.current();
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, stop]);

  return level;
}

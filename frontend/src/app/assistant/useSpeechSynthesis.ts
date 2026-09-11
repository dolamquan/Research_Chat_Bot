import { useCallback, useEffect, useRef, useState } from "react";

import { chunkForSpeech, stripMarkdownForSpeech } from "./speechText";

export function speechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
}

const PREFERRED = [
  /Google US English/i,
  /Microsoft (Aria|Jenny|Guy|Ava|Andrew|Emma|Brian) Online.*English \(United States\)/i,
  /Microsoft (Aria|Jenny|Guy).*English/i,
  /Samantha/i,
];

export function pickVoice(voices: SpeechSynthesisVoice[], storedUri: string | null): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  if (storedUri) {
    const stored = voices.find((voice) => voice.voiceURI === storedUri);
    if (stored) return stored;
  }
  for (const pattern of PREFERRED) {
    const hit = voices.find((voice) => pattern.test(voice.name));
    if (hit) return hit;
  }
  return (
    voices.find((voice) => voice.lang?.startsWith("en-US") && !voice.localService) ||
    voices.find((voice) => voice.lang?.startsWith("en-US")) ||
    voices.find((voice) => voice.lang?.startsWith("en")) ||
    voices[0]
  );
}

export type SpeechSynthesisHandlers = {
  onStart: (text: string) => void;
  onEnd: () => void;
};

/**
 * Speaks short texts through the browser, one sentence-sized chunk at a time,
 * and exposes a 0..1 "mouth level" ref the orb can read every frame.
 */
export function useSpeechSynthesis(handlers: SpeechSynthesisHandlers, options: { enabled: boolean; storedVoiceUri: string | null }) {
  const supported = speechSynthesisSupported();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const level = useRef(0);
  const queueRef = useRef<string[]>([]);
  const speakingRef = useRef(false);
  const generationRef = useRef(0);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const boundaryRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const enabledRef = useRef(options.enabled);
  enabledRef.current = options.enabled;

  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    let cancelled = false;
    const load = () => {
      const list = synth.getVoices();
      if (!list.length || cancelled) return;
      setVoices(list);
      setVoice((current) => current ?? pickVoice(list, options.storedVoiceUri));
    };
    load();
    synth.addEventListener?.("voiceschanged", load);
    const timers = [250, 1000, 3000].map((ms) => setTimeout(load, ms));
    return () => {
      cancelled = true;
      synth.removeEventListener?.("voiceschanged", load);
      timers.forEach(clearTimeout);
    };
    // The stored voice only matters for the first pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const stopEnvelope = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    level.current = 0;
  }, []);

  const runEnvelope = useCallback(() => {
    const started = performance.now();
    let lastImpulse = started;
    const tick = (now: number) => {
      if (!speakingRef.current) {
        stopEnvelope();
        return;
      }
      if (boundaryRef.current) {
        level.current *= 0.86;
      } else {
        // No word boundaries (Safari, some engines): synthesise a syllable rhythm.
        if (now - lastImpulse > 120 + Math.random() * 100) {
          level.current = 0.55 + Math.random() * 0.45;
          lastImpulse = now;
        } else {
          level.current *= 0.9;
        }
      }
      const floor = 0.18 + 0.08 * Math.sin((now - started) / 1000 * Math.PI * 2 * 3.5);
      level.current = Math.max(level.current, floor);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopEnvelope]);

  const finish = useCallback(() => {
    speakingRef.current = false;
    queueRef.current = [];
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    keepAliveRef.current = null;
    stopEnvelope();
    handlersRef.current.onEnd();
  }, [stopEnvelope]);

  const speakNext = useCallback((generation: number) => {
    if (generation !== generationRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      finish();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(next);
    if (voice) utterance.voice = voice;
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onboundary = (event) => {
      if (event.name === "word" || event.name === undefined) {
        boundaryRef.current = true;
        level.current = 1;
      }
    };
    utterance.onend = () => speakNext(generation);
    utterance.onerror = (event) => {
      if (event.error === "interrupted" || event.error === "canceled") return;
      speakNext(generation);
    };
    window.speechSynthesis.speak(utterance);
  }, [finish, voice]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    if (!supported) return;
    const wasSpeaking = speakingRef.current;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    if (wasSpeaking) finish();
  }, [finish, supported]);

  const speak = useCallback((text: string) => {
    if (!supported || !enabledRef.current) return false;
    const clean = stripMarkdownForSpeech(text);
    const chunks = chunkForSpeech(clean, 180);
    if (!chunks.length) return false;
    cancel();
    const generation = generationRef.current;
    queueRef.current = chunks;
    speakingRef.current = true;
    boundaryRef.current = false;
    handlersRef.current.onStart(clean);
    runEnvelope();
    // Chrome stalls on long sessions unless the engine is nudged periodically.
    keepAliveRef.current = setInterval(() => {
      try {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      } catch {
        /* ignore */
      }
    }, 10000);
    // Chrome swallows a speak() issued synchronously after cancel().
    setTimeout(() => speakNext(generation), 50);
    return true;
  }, [cancel, runEnvelope, speakNext, supported]);

  useEffect(() => () => {
    generationRef.current += 1;
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    stopEnvelope();
    if (supported) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
  }, [stopEnvelope, supported]);

  return {
    supported,
    voices,
    voice,
    setVoice,
    speak,
    cancel,
    level,
    isSpeaking: () => speakingRef.current,
  };
}

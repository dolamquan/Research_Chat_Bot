import { useCallback, useEffect, useRef } from "react";

type RecognitionResultLike = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEventLike = { resultIndex: number; results: ArrayLike<RecognitionResultLike> };
type RecognitionErrorLike = { error: string };

type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: RecognitionErrorLike) => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type RecognitionCtor = new () => RecognitionLike;

export function speechRecognitionSupported(): boolean {
  return Boolean(recognitionConstructor());
}

function recognitionConstructor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type SpeechRecognitionHandlers = {
  onStart: () => void;
  onEnd: () => void;
  onError: (code: string) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
};

/**
 * A thin, restart-safe wrapper over the browser recogniser. It never restarts
 * on its own; the voice machine decides when (with backoff) and calls start().
 */
export function useSpeechRecognition(handlers: SpeechRecognitionHandlers, lang = "en-US") {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const runningRef = useRef(false);
  const lastFinalRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const ensure = useCallback((): RecognitionLike | null => {
    if (recognitionRef.current) return recognitionRef.current;
    const Ctor = recognitionConstructor();
    if (!Ctor) return null;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      runningRef.current = true;
      console.debug("[assistant] recognition started");
      handlersRef.current.onStart();
    };
    recognition.onend = () => {
      runningRef.current = false;
      console.debug("[assistant] recognition ended");
      handlersRef.current.onEnd();
    };
    recognition.onerror = (event) => {
      console.debug("[assistant] recognition error:", event?.error);
      handlersRef.current.onError(event?.error || "unknown");
    };
    recognition.onresult = (event) => {
      const results = event.results;
      for (let index = event.resultIndex ?? 0; index < results.length; index += 1) {
        const result = results[index];
        const text = result?.[0]?.transcript ?? "";
        if (!text.trim()) continue;
        if (result.isFinal) {
          // Chrome occasionally reports the same final segment twice in a row.
          const now = Date.now();
          if (lastFinalRef.current.text === text && now - lastFinalRef.current.at < 1500) continue;
          lastFinalRef.current = { text, at: now };
        }
        console.debug("[assistant] heard:", JSON.stringify(text), result.isFinal ? "(final)" : "(interim)");
        handlersRef.current.onTranscript(text, Boolean(result.isFinal));
      }
    };
    recognitionRef.current = recognition;
    return recognition;
  }, [lang]);

  const start = useCallback(() => {
    const recognition = ensure();
    if (!recognition || runningRef.current) return;
    try {
      recognition.start();
    } catch {
      // InvalidStateError when a start races an end; the machine will retry.
    }
  }, [ensure]);

  const stop = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
  }, []);

  const abort = useCallback(() => {
    try {
      recognitionRef.current?.abort();
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    if (recognition) {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
    }
  }, []);

  return { supported: speechRecognitionSupported(), start, stop, abort, isRunning: () => runningRef.current };
}

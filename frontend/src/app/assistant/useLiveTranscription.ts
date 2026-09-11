import { useCallback, useEffect, useRef } from "react";
import { getAccessToken, transcriptionSocketUrl, UNAUTHORIZED_EVENT } from "../api";
import { LiveTranscription, type TranscriptionHandlers } from "./liveTranscription";

export { speechRecognitionSupported } from "./liveTranscription";

export function useLiveTranscription(handlers: TranscriptionHandlers, authenticated: boolean) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const authenticatedRef = useRef(authenticated);
  authenticatedRef.current = authenticated;
  const clientRef = useRef<LiveTranscription | null>(null);
  if (!clientRef.current) {
    clientRef.current = new LiveTranscription({
      url: transcriptionSocketUrl,
      token: getAccessToken,
      handlers: {
        onStart: () => handlersRef.current.onStart(),
        onEnd: () => handlersRef.current.onEnd(),
        onTranscript: (text, final) => handlersRef.current.onTranscript(text, final),
        onSpeechStart: () => handlersRef.current.onSpeechStart?.(),
        onError: (code, message, retryable) => {
          if (code === "unauthorized") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
          handlersRef.current.onError(code, message, retryable);
        },
      },
    });
  }
  const start = useCallback(() => {
    if (authenticatedRef.current) void clientRef.current!.start();
  }, []);
  const abort = useCallback(() => clientRef.current!.stop(), []);
  useEffect(() => () => clientRef.current!.stop(false), []);
  return { start, stop: abort, abort, isRunning: () => clientRef.current!.isRunning(), level: clientRef.current.level };
}

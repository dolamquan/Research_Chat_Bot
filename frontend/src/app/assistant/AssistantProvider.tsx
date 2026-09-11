import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
} from "react";

import { UNAUTHORIZED_EVENT, assistantSocketUrl, createNote, getAccessToken } from "../api";
import { useAuth } from "../auth/AuthProvider";
import { AssistantSocket } from "./assistantSocket";
import { assistantStorage } from "./assistantStorage";
import type {
  AssistantTurn,
  AssistantWorkspace,
  HistoryEntry,
  LiveToolEvent,
  ServerMessage,
  SocketStatus,
  UiAction,
  VoiceContext,
  VoiceEffect,
  VoiceEvent,
} from "./assistantTypes";
import { CLIENT_TOOL_SPECS, createClientToolDispatcher } from "./clientTools";
import { createUiActionRegistry, createWorkspaceStore, type UiActionRegistry, type WorkspaceStore } from "./uiActionRegistry";
import { useAssistantHotkeys } from "./useAssistantHotkeys";
import { useMicLevel } from "./useMicLevel";
import { speechRecognitionSupported, useSpeechRecognition } from "./useSpeechRecognition";
import { speechSynthesisSupported, useSpeechSynthesis } from "./useSpeechSynthesis";
import { currentCommand, displayState, initialVoiceContext, shouldListen, transition } from "./voiceMachine";

export type AssistantValue = {
  ctx: VoiceContext;
  display: ReturnType<typeof displayState>;
  turns: AssistantTurn[];
  activeTool: LiveToolEvent | null;
  caption: { primary: string; status: string };
  sessionId: string | null;
  socket: SocketStatus;
  catalogToolCount: number;
  panelOpen: boolean;
  ttsEnabled: boolean;
  voices: SpeechSynthesisVoice[];
  voice: SpeechSynthesisVoice | null;
  micLevel: React.MutableRefObject<number>;
  ttsLevel: React.MutableRefObject<number>;
  workspace: WorkspaceStore;
  actions: {
    sendText: (text: string) => void;
    pushToTalk: () => void;
    toggleMute: () => void;
    confirm: (approved: boolean) => void;
    cancel: () => void;
    setPanelOpen: (open: boolean) => void;
    setTtsEnabled: (enabled: boolean) => void;
    setVoice: (uri: string) => void;
    newSession: () => void;
    stopSpeaking: () => void;
  };
};

const AssistantContext = createContext<AssistantValue | null>(null);
const RegistryContext = createContext<{ registry: UiActionRegistry; workspace: WorkspaceStore } | null>(null);

function fromHistory(history: HistoryEntry[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  for (const entry of history) {
    const at = Date.parse(entry.created_at) || Date.now();
    if (entry.role === "user") {
      turns.push({
        id: `h-${at}-${turns.length}`,
        user: { text: entry.content, source: entry.source === "voice" ? "voice" : "text" },
        streamingText: "",
        answer: null,
        spoken: null,
        tools: [],
        sources: [],
        error: null,
        status: "done",
        createdAt: at,
      });
    } else {
      const last = turns[turns.length - 1];
      const tools: LiveToolEvent[] = (entry.tool_trace || []).map((step, index) => ({
        ...step,
        call_id: `h-${at}-${index}`,
        origin: step.tool.startsWith("ui.") ? "client" : "server",
        startedAt: at,
        endedAt: at,
      }));
      if (last && last.answer === null) {
        last.answer = entry.content;
        last.spoken = entry.spoken ?? null;
        last.tools = tools;
        last.sources = entry.sources || [];
      } else {
        turns.push({
          id: `h-${at}-${turns.length}`,
          user: { text: "", source: "text" },
          streamingText: "",
          answer: entry.content,
          spoken: entry.spoken ?? null,
          tools,
          sources: entry.sources || [],
          error: null,
          status: "done",
          createdAt: at,
        });
      }
    }
  }
  return turns;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const registry = useRef<UiActionRegistry>(createUiActionRegistry()).current;
  const workspace = useRef<WorkspaceStore>(createWorkspaceStore()).current;

  const [ctx, setCtx] = useState<VoiceContext>(() =>
    initialVoiceContext({
      recognition: speechRecognitionSupported(),
      synthesis: speechSynthesisSupported(),
      muted: assistantStorage.getMuted(),
      voiceEnabled: assistantStorage.getVoiceEnabled(),
    }),
  );
  const ctxRef = useRef(ctx);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(assistantStorage.getSessionId());
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("closed");
  const [catalogToolCount, setCatalogToolCount] = useState(0);
  const [panelOpen, setPanelOpenState] = useState(assistantStorage.getDockExpanded());
  const [ttsEnabled, setTtsEnabledState] = useState(assistantStorage.getTtsEnabled());
  const ttsEnabledRef = useRef(ttsEnabled);
  ttsEnabledRef.current = ttsEnabled;

  const socketRef = useRef<AssistantSocket | null>(null);
  const localCounter = useRef(0);
  const timers = useRef<{ silence?: number; capture?: number; confirm?: number; error?: number; restart?: number; workspace?: number }>({});
  const dispatchRef = useRef<(event: VoiceEvent) => void>(() => undefined);

  // ---- browser speech ----------------------------------------------------

  const recognition = useSpeechRecognition({
    onStart: () => dispatchRef.current({ type: "RECOGNITION_STARTED" }),
    onEnd: () => dispatchRef.current({ type: "RECOGNITION_ENDED" }),
    onError: (code) => dispatchRef.current({ type: "RECOGNITION_ERROR", code }),
    onTranscript: (text, isFinal) => dispatchRef.current({ type: "TRANSCRIPT", text, isFinal, now: Date.now() }),
  });
  const recognitionRef = useRef(recognition);
  recognitionRef.current = recognition;

  const synthesis = useSpeechSynthesis(
    {
      onStart: (text) => dispatchRef.current({ type: "TTS_STARTED", text }),
      onEnd: () => dispatchRef.current({ type: "TTS_ENDED", now: Date.now() }),
    },
    { enabled: ttsEnabled, storedVoiceUri: assistantStorage.getVoiceUri() },
  );
  const synthesisRef = useRef(synthesis);
  synthesisRef.current = synthesis;

  const micLevel = useMicLevel(shouldListen(ctx), () => dispatchRef.current({ type: "MIC_DENIED" }));

  // ---- turns -----------------------------------------------------------------

  const updateTurn = useCallback((predicate: (turn: AssistantTurn) => boolean, patch: (turn: AssistantTurn) => AssistantTurn) => {
    setTurns((current) => {
      let index = -1;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        if (predicate(current[i])) {
          index = i;
          break;
        }
      }
      if (index < 0) return current;
      const next = [...current];
      next[index] = patch(current[index]);
      return next;
    });
  }, []);

  const updateCurrentTurn = useCallback(
    (turnId: string, patch: (turn: AssistantTurn) => AssistantTurn) => updateTurn((turn) => turn.id === turnId, patch),
    [updateTurn],
  );

  const startLocalTurn = useCallback((text: string, source: "voice" | "text"): string => {
    localCounter.current += 1;
    const id = `m-${Date.now()}-${localCounter.current}`;
    setTurns((current) => [
      ...current.slice(-60),
      { id, user: { text, source }, streamingText: "", answer: null, spoken: null, tools: [], sources: [], error: null, status: "pending", createdAt: Date.now() },
    ]);
    return id;
  }, []);

  // ---- effects from the voice machine ------------------------------------------

  const clearTimer = useCallback((name: keyof typeof timers.current) => {
    const handle = timers.current[name];
    if (handle) window.clearTimeout(handle);
    timers.current[name] = undefined;
  }, []);

  const runEffects = useCallback(
    (effects: VoiceEffect[], before: VoiceContext) => {
      for (const effect of effects) {
        switch (effect.type) {
          case "START_RECOGNITION":
            recognitionRef.current.start();
            break;
          case "ABORT_RECOGNITION":
            clearTimer("restart");
            recognitionRef.current.abort();
            break;
          case "SCHEDULE_RESTART":
            clearTimer("restart");
            timers.current.restart = window.setTimeout(() => {
              timers.current.restart = undefined;
              if (shouldListen(ctxRef.current)) recognitionRef.current.start();
            }, effect.delayMs);
            break;
          case "CANCEL_TTS":
            synthesisRef.current.cancel();
            break;
          case "SPEAK":
            if (ttsEnabledRef.current) synthesisRef.current.speak(effect.text.replace(/\bzoetrope\b/gi, "I").replace(/\bzoe\b/gi, "I"));
            break;
          case "SEND_MESSAGE": {
            const id = startLocalTurn(effect.text, effect.source);
            socketRef.current?.send({ type: "user_message", id, text: effect.text, source: effect.source, workspace: workspace.snapshot() });
            break;
          }
          case "SEND_CONFIRM":
            startLocalTurn(effect.approved ? "Yes" : "No", "text");
            socketRef.current?.send({ type: "confirm", action_id: before.confirmation?.actionId ?? null, approved: effect.approved, workspace: workspace.snapshot() });
            break;
          case "SEND_CANCEL":
            socketRef.current?.send({ type: "cancel", reason: effect.reason });
            break;
          case "START_SILENCE_TIMER":
            clearTimer("silence");
            timers.current.silence = window.setTimeout(() => dispatchRef.current({ type: "SILENCE_TIMEOUT" }), effect.ms);
            break;
          case "CLEAR_SILENCE_TIMER":
            clearTimer("silence");
            break;
          case "START_CAPTURE_TIMER":
            clearTimer("capture");
            timers.current.capture = window.setTimeout(() => dispatchRef.current({ type: "CAPTURE_TIMEOUT" }), effect.ms);
            break;
          case "CLEAR_CAPTURE_TIMER":
            clearTimer("capture");
            break;
          case "START_CONFIRM_TIMER":
            clearTimer("confirm");
            timers.current.confirm = window.setTimeout(() => dispatchRef.current({ type: "CONFIRM_TIMEOUT" }), effect.ms);
            break;
          case "CLEAR_CONFIRM_TIMER":
            clearTimer("confirm");
            break;
          case "RESET_ERROR_LATER":
            clearTimer("error");
            timers.current.error = window.setTimeout(() => dispatchRef.current({ type: "ERROR_CLEARED" }), effect.ms);
            break;
          default:
            break;
        }
      }
    },
    [clearTimer, startLocalTurn, workspace],
  );

  const dispatch = useCallback(
    (event: VoiceEvent) => {
      const before = ctxRef.current;
      const { ctx: next, effects } = transition(before, event);
      ctxRef.current = next;
      if (next !== before) setCtx(next);
      runEffects(effects, before);
    },
    [runEffects],
  );
  dispatchRef.current = dispatch;

  // ---- server messages ---------------------------------------------------------

  const clientToolDispatch = useMemo(
    () => createClientToolDispatcher(registry, workspace, { createNote }),
    [registry, workspace],
  );

  const handleServer = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case "session": {
          setSessionId(message.session_id);
          assistantStorage.setSessionId(message.session_id);
          setCatalogToolCount(message.catalog_tool_count);
          setTurns(fromHistory(message.history || []));
          if (message.pending_action) {
            dispatch({
              type: "SERVER",
              message: {
                type: "confirmation_required", turn_id: "", action_id: message.pending_action.id, tool: message.pending_action.tool,
                effect: message.pending_action.effect, arguments: message.pending_action.arguments, summary: message.pending_action.summary,
              },
            });
          }
          return;
        }
        case "turn_start":
          updateTurn(
            (turn) => (message.message_id ? turn.id === message.message_id : turn.status === "pending"),
            (turn) => ({ ...turn, id: message.turn_id, status: "running" }),
          );
          break;
        case "thinking":
          updateCurrentTurn(message.turn_id, (turn) => ({ ...turn, streamingText: "" }));
          break;
        case "token":
          updateCurrentTurn(message.turn_id, (turn) => ({ ...turn, streamingText: turn.streamingText + message.text }));
          break;
        case "tool_start":
          updateCurrentTurn(message.turn_id, (turn) => ({
            ...turn,
            tools: [
              ...turn.tools,
              { tool: message.tool, status: "running", message: message.say, timestamp: new Date().toISOString(), arguments: message.arguments, effect: message.effect,
                call_id: message.call_id, origin: message.execution === "client" ? "client" : "server", say: message.say, startedAt: Date.now(), execution: message.execution },
            ],
          }));
          break;
        case "tool_result":
          updateCurrentTurn(message.turn_id, (turn) => ({
            ...turn,
            tools: turn.tools.map((tool) =>
              tool.call_id === message.call_id ? { ...tool, status: message.status, message: message.message, effect: message.effect, endedAt: Date.now() } : tool,
            ),
          }));
          break;
        case "client_tool_call": {
          void clientToolDispatch(message.tool, message.arguments).then((outcome) => {
            socketRef.current?.send(
              outcome.ok
                ? { type: "client_tool_result", call_id: message.call_id, ok: true, result: outcome.result }
                : { type: "client_tool_result", call_id: message.call_id, ok: false, error: outcome.error, result: outcome.candidates ? { candidates: outcome.candidates } : undefined },
            );
          });
          break;
        }
        case "answer":
          updateCurrentTurn(message.turn_id, (turn) => ({
            ...turn, answer: message.answer, spoken: message.spoken, sources: message.sources || [], streamingText: "",
            tools: turn.tools.length ? turn.tools : (message.tool_trace || []).map((step, index) => ({
              ...step, call_id: `${message.turn_id}-${index}`, origin: step.tool.startsWith("ui.") ? "client" as const : "server" as const, startedAt: Date.now(), endedAt: Date.now(),
            })),
          }));
          break;
        case "error":
          if (message.turn_id) updateCurrentTurn(message.turn_id, (turn) => ({ ...turn, error: message.message, status: "error" }));
          break;
        case "done":
          updateCurrentTurn(message.turn_id, (turn) => ({
            ...turn,
            status: message.status === "cancelled" ? "cancelled" : message.status === "error" ? "error" : "done",
            streamingText: turn.answer ? "" : turn.streamingText,
          }));
          if (message.status === "ok") assistantStorage.setHintSeen();
          break;
        default:
          break;
      }
      dispatch({ type: "SERVER", message });
    },
    [clientToolDispatch, dispatch, updateCurrentTurn, updateTurn],
  );
  const handleServerRef = useRef(handleServer);
  handleServerRef.current = handleServer;

  // ---- socket lifecycle -------------------------------------------------------------

  const ready = auth.status === "signed_in" || auth.status === "disabled";
  const userId = auth.user?.id ?? "";

  useEffect(() => {
    if (!ready) return;
    const socket = new AssistantSocket({
      url: assistantSocketUrl,
      hello: () => ({
        token: getAccessToken() ?? "",
        session_id: assistantStorage.getSessionId(),
        client_tools: CLIENT_TOOL_SPECS,
        workspace: workspace.snapshot(),
        client: { tts: ttsEnabledRef.current, locale: navigator.language || "en-US" },
      }),
      onMessage: (message) => handleServerRef.current(message),
      onStatus: (status) => {
        setSocketStatus(status);
        dispatchRef.current({ type: "SOCKET_STATUS", status });
      },
      onUnauthorized: () => window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)),
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [ready, userId, workspace]);

  // Keep the server's picture of the screen fresh between turns (debounced).
  useEffect(() => {
    return workspace.subscribe((snapshot) => {
      clearTimer("workspace");
      timers.current.workspace = window.setTimeout(() => {
        if (!ctxRef.current.inTurn) socketRef.current?.send({ type: "workspace", workspace: snapshot });
      }, 1500);
    });
  }, [clearTimer, workspace]);

  // ---- preferences -------------------------------------------------------------------

  useEffect(() => {
    assistantStorage.setVoiceEnabled(ctx.voiceEnabled);
  }, [ctx.voiceEnabled]);
  useEffect(() => {
    assistantStorage.setMuted(ctx.muted);
  }, [ctx.muted]);

  useEffect(() => {
    // Start listening on load when the user already granted the microphone before.
    if (shouldListen(ctxRef.current) && !ctxRef.current.recognitionActive) recognitionRef.current.start();
    return () => {
      Object.values(timers.current).forEach((handle) => handle && window.clearTimeout(handle));
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && shouldListen(ctxRef.current) && !recognitionRef.current.isRunning()) {
        recognitionRef.current.start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ---- public actions -----------------------------------------------------------------

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenState(open);
    assistantStorage.setDockExpanded(open);
  }, []);

  const actions = useMemo<AssistantValue["actions"]>(
    () => ({
      sendText: (text) => {
        if (text.trim()) dispatch({ type: "SUBMIT_TEXT", text });
      },
      pushToTalk: () => dispatch({ type: "PUSH_TO_TALK" }),
      toggleMute: () => dispatch({ type: ctxRef.current.muted ? "UNMUTE" : "MUTE" }),
      confirm: (approved) => dispatch({ type: "CONFIRM_CLICK", approved }),
      cancel: () => dispatch({ type: "CANCEL" }),
      setPanelOpen,
      setTtsEnabled: (enabled) => {
        setTtsEnabledState(enabled);
        assistantStorage.setTtsEnabled(enabled);
        if (!enabled) synthesisRef.current.cancel();
      },
      setVoice: (uri) => {
        const chosen = synthesisRef.current.voices.find((voice) => voice.voiceURI === uri) ?? null;
        synthesisRef.current.setVoice(chosen);
        assistantStorage.setVoiceUri(chosen?.voiceURI ?? null);
      },
      newSession: () => {
        assistantStorage.setSessionId(null);
        setTurns([]);
        dispatch({ type: "CANCEL" });
        socketRef.current?.refresh();
      },
      stopSpeaking: () => synthesisRef.current.cancel(),
    }),
    [dispatch, setPanelOpen],
  );

  const hotkeys = useMemo(
    () => ({
      pushToTalk: () => dispatch({ type: "PUSH_TO_TALK" }),
      togglePanel: () => setPanelOpen(!panelOpen),
      escape: () => {
        const current = ctxRef.current;
        if (current.speaking || current.state === "capturing" || current.inTurn) {
          dispatch({ type: "CANCEL" });
          return true;
        }
        if (panelOpen) {
          setPanelOpen(false);
          return true;
        }
        return false;
      },
    }),
    [dispatch, panelOpen, setPanelOpen],
  );
  useAssistantHotkeys(hotkeys);

  // ---- derived view state -------------------------------------------------------------

  const display = displayState(ctx);
  const activeTool = useMemo(() => {
    const last = turns[turns.length - 1];
    if (!last || last.status !== "running") return null;
    return [...last.tools].reverse().find((tool) => tool.status === "running") ?? null;
  }, [turns]);

  const caption = useMemo(() => {
    const lastTurn = turns[turns.length - 1];
    let primary = "";
    let status = "";
    switch (display) {
      case "text_only":
        status = ctx.textOnlyReason ?? "Voice unavailable in this browser";
        break;
      case "dormant":
        status = "Click the orb to enable voice";
        break;
      case "muted":
        status = "Muted";
        break;
      case "idle_listening":
        status = assistantStorage.getHintSeen() ? "" : 'Listening for "Hey Zoe"';
        break;
      case "capturing":
        primary = currentCommand(ctx) || (ctx.captureSource === "wake" ? "Yes?" : "Listening…");
        status = "Hearing you";
        break;
      case "sending":
        primary = lastTurn?.user.text ?? "";
        status = "Sending";
        break;
      case "thinking":
        primary = lastTurn?.streamingText.slice(-90) || lastTurn?.user.text || "";
        status = "Thinking";
        break;
      case "executing":
        primary = activeTool?.say || activeTool?.tool || "";
        status = activeTool ? `Running ${activeTool.tool}` : "Working";
        break;
      case "awaiting_confirmation":
        primary = ctx.confirmation?.summary ?? "";
        status = "Say yes or no";
        break;
      case "speaking":
        primary = ctx.spokenText;
        status = "Speaking";
        break;
      case "error":
        primary = ctx.error ?? "Something went wrong";
        status = "Error";
        break;
      default:
        break;
    }
    if (socketStatus !== "open" && display !== "text_only") status = socketStatus === "connecting" ? "Connecting…" : "Reconnecting…";
    return { primary, status };
  }, [activeTool, ctx, display, socketStatus, turns]);

  const value = useMemo<AssistantValue>(
    () => ({
      ctx, display, turns, activeTool, caption, sessionId, socket: socketStatus, catalogToolCount, panelOpen, ttsEnabled,
      voices: synthesis.voices, voice: synthesis.voice, micLevel, ttsLevel: synthesis.level, workspace, actions,
    }),
    [actions, activeTool, caption, catalogToolCount, ctx, display, micLevel, panelOpen, sessionId, socketStatus, synthesis.level, synthesis.voice, synthesis.voices, ttsEnabled, turns, workspace],
  );

  const registryValue = useMemo(() => ({ registry, workspace }), [registry, workspace]);

  return (
    <RegistryContext.Provider value={registryValue}>
      <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>
    </RegistryContext.Provider>
  );
}

export function useAssistant(): AssistantValue {
  const value = useContext(AssistantContext);
  if (!value) throw new Error("useAssistant must be used inside AssistantProvider");
  return value;
}

/**
 * Lend the assistant this view's handlers. Re-registers the latest closures
 * after every render (cheap map writes) and removes them on unmount. Views
 * rendered outside the provider (tests, previews) simply lend nothing.
 */
export function useRegisterUiActions(actions: Record<string, UiAction>): void {
  const registry = useContext(RegistryContext)?.registry ?? null;
  const namesRef = useRef<string[]>([]);
  useEffect(() => {
    if (!registry) return;
    registry.register(actions);
    namesRef.current = Object.keys(actions);
  });
  useEffect(() => () => registry?.unregister(namesRef.current), [registry]);
}

/** Publish what this view is showing whenever `deps` change. */
export function useReportWorkspace(factory: () => Partial<AssistantWorkspace>, deps: DependencyList): void {
  const workspace = useContext(RegistryContext)?.workspace ?? null;
  useEffect(() => {
    workspace?.publish(factory());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

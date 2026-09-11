/**
 * The assistant's voice state as a pure reducer.
 *
 * `transition(ctx, event)` returns the next context and a list of effects for
 * the provider to carry out (start recognition, speak, send a frame, arm a
 * timer). Keeping timers and browser APIs outside makes every path testable.
 */
import type { PendingConfirmation, VoiceContext, VoiceEffect, VoiceEvent, VoiceState } from "./assistantTypes";
import { isEchoOf, matchConfirmation, matchWakeWord, stripWakeWord } from "./wakeWord";

export const SILENCE_AFTER_SPEECH_MS = 1400;
export const WAIT_FOR_COMMAND_MS = 4000;
export const PUSH_TO_TALK_WAIT_MS = 6000;
export const CAPTURE_HARD_CAP_MS = 12000;
export const CONFIRMATION_WINDOW_MS = 20000;
export const POST_TTS_COOLDOWN_MS = 600;
export const ERROR_DISPLAY_MS = 4000;
export const RESTART_MIN_MS = 250;
export const RESTART_MAX_MS = 5000;

export type Transition = { ctx: VoiceContext; effects: VoiceEffect[] };

export function initialVoiceContext(options: {
  recognition: boolean;
  synthesis: boolean;
  muted?: boolean;
  voiceEnabled?: boolean;
}): VoiceContext {
  const ctx: VoiceContext = {
    state: "dormant",
    supported: options.recognition,
    synthesisSupported: options.synthesis,
    textOnlyReason: options.recognition ? null : "Voice input is not available in this browser",
    muted: Boolean(options.muted),
    voiceEnabled: Boolean(options.voiceEnabled),
    oneShot: false,
    recognitionActive: false,
    restartDelayMs: RESTART_MIN_MS,
    speaking: false,
    spokenText: "",
    cooldownUntil: 0,
    inTurn: false,
    pendingTools: 0,
    committed: "",
    interim: "",
    captureSource: null,
    confirmation: null,
    error: null,
    socket: "connecting",
  };
  return { ...ctx, state: restingState(ctx) };
}

export function restingState(ctx: VoiceContext): VoiceState {
  if (!ctx.supported || ctx.textOnlyReason) return "text_only";
  if (ctx.muted && !ctx.oneShot) return "muted";
  if (!ctx.voiceEnabled) return "dormant";
  return "idle_listening";
}

/** Should the recogniser be running right now? */
export function shouldListen(ctx: VoiceContext): boolean {
  return ctx.supported && !ctx.textOnlyReason && ctx.voiceEnabled && (!ctx.muted || ctx.oneShot);
}

export function isTurnState(state: VoiceState): boolean {
  return state === "sending" || state === "thinking" || state === "executing";
}

export function currentCommand(ctx: VoiceContext): string {
  return `${ctx.committed} ${ctx.interim}`.trim();
}

function settle(ctx: VoiceContext, effects: VoiceEffect[]): Transition {
  // Where to land when nothing is in flight.
  if (ctx.confirmation) return { ctx: { ...ctx, state: "awaiting_confirmation" }, effects };
  if (ctx.inTurn) return { ctx: { ...ctx, state: ctx.pendingTools > 0 ? "executing" : "thinking" }, effects };
  return { ctx: { ...ctx, state: restingState(ctx) }, effects };
}

function beginCapture(ctx: VoiceContext, remainder: string, source: "wake" | "push", effects: VoiceEffect[]): Transition {
  const next: VoiceContext = { ...ctx, state: "capturing", committed: "", interim: remainder, captureSource: source };
  const wait = source === "push" ? PUSH_TO_TALK_WAIT_MS : remainder ? SILENCE_AFTER_SPEECH_MS : WAIT_FOR_COMMAND_MS;
  return {
    ctx: next,
    effects: [...effects, { type: "START_SILENCE_TIMER", ms: wait }, { type: "START_CAPTURE_TIMER", ms: CAPTURE_HARD_CAP_MS }],
  };
}

function sendCommand(ctx: VoiceContext, text: string, source: "voice" | "text", effects: VoiceEffect[]): Transition {
  const trimmed = text.trim();
  const cleared: VoiceContext = {
    ...ctx, committed: "", interim: "", captureSource: null, error: null,
  };
  const timers: VoiceEffect[] = [{ type: "CLEAR_SILENCE_TIMER" }, { type: "CLEAR_CAPTURE_TIMER" }];
  if (!trimmed) return settle(cleared, [...effects, ...timers]);
  const bargeIn: VoiceEffect[] = ctx.inTurn ? [{ type: "SEND_CANCEL", reason: "barge_in" }] : [];
  return {
    ctx: { ...cleared, state: "sending", inTurn: true, pendingTools: 0, confirmation: ctx.confirmation },
    effects: [...effects, ...timers, ...bargeIn, { type: "SEND_MESSAGE", text: trimmed, source }],
  };
}

function finishCapture(ctx: VoiceContext, effects: VoiceEffect[]): Transition {
  const command = currentCommand(ctx);
  if (!command && ctx.captureSource === "wake") {
    // A bare wake word that never grew into a command.
    return settle({ ...ctx, committed: "", interim: "", captureSource: null }, [
      ...effects, { type: "CLEAR_SILENCE_TIMER" }, { type: "CLEAR_CAPTURE_TIMER" },
    ]);
  }
  const done = sendCommand(ctx, command, "voice", effects);
  if (ctx.oneShot && !command) {
    return { ctx: { ...done.ctx, oneShot: false, state: restingState({ ...done.ctx, oneShot: false }) }, effects: [...done.effects, { type: "ABORT_RECOGNITION" }] };
  }
  return done;
}

function micDenied(ctx: VoiceContext): Transition {
  const next: VoiceContext = {
    ...ctx, textOnlyReason: "Microphone access was denied", voiceEnabled: false, oneShot: false,
    recognitionActive: false, committed: "", interim: "", captureSource: null,
  };
  return settle(next, [{ type: "ABORT_RECOGNITION" }, { type: "CLEAR_SILENCE_TIMER" }, { type: "CLEAR_CAPTURE_TIMER" }]);
}

export function transition(ctx: VoiceContext, event: VoiceEvent): Transition {
  switch (event.type) {
    case "CAPS": {
      const next: VoiceContext = {
        ...ctx, supported: event.recognition, synthesisSupported: event.synthesis,
        textOnlyReason: event.recognition ? (ctx.textOnlyReason === "Voice input is not available in this browser" ? null : ctx.textOnlyReason) : "Voice input is not available in this browser",
      };
      return settle(next, []);
    }
    case "ENABLE_VOICE": {
      if (!ctx.supported || ctx.textOnlyReason) return { ctx, effects: [] };
      const next: VoiceContext = { ...ctx, voiceEnabled: true };
      return settle(next, shouldListen(next) && !ctx.recognitionActive ? [{ type: "START_RECOGNITION" }] : []);
    }
    case "MIC_DENIED":
      return micDenied(ctx);
    case "MUTE": {
      const next: VoiceContext = { ...ctx, muted: true, oneShot: false, committed: "", interim: "", captureSource: null };
      const effects: VoiceEffect[] = [{ type: "ABORT_RECOGNITION" }, { type: "CLEAR_SILENCE_TIMER" }, { type: "CLEAR_CAPTURE_TIMER" }];
      return next.state === "capturing" || !isTurnState(next.state) ? settle(next, effects) : { ctx: next, effects };
    }
    case "UNMUTE": {
      const next: VoiceContext = { ...ctx, muted: false, voiceEnabled: true };
      const effects: VoiceEffect[] = shouldListen(next) && !ctx.recognitionActive ? [{ type: "START_RECOGNITION" }] : [];
      return isTurnState(next.state) || next.state === "awaiting_confirmation" ? { ctx: next, effects } : settle(next, effects);
    }
    case "RECOGNITION_STARTED":
      return { ctx: { ...ctx, recognitionActive: true, restartDelayMs: RESTART_MIN_MS }, effects: [] };
    case "RECOGNITION_ENDED": {
      const next: VoiceContext = { ...ctx, recognitionActive: false };
      if (!shouldListen(next)) return { ctx: next, effects: [] };
      return {
        ctx: { ...next, restartDelayMs: Math.min(next.restartDelayMs * 2, RESTART_MAX_MS) },
        effects: [{ type: "SCHEDULE_RESTART", delayMs: next.restartDelayMs }],
      };
    }
    case "RECOGNITION_ERROR": {
      if (event.code === "not-allowed" || event.code === "service-not-allowed") return micDenied(ctx);
      if (event.code === "no-speech" || event.code === "aborted") return { ctx, effects: [] };
      if (event.code === "network" || event.code === "audio-capture") {
        return { ctx: { ...ctx, error: event.code === "network" ? "Speech recognition lost its connection" : "No microphone input" }, effects: [{ type: "RESET_ERROR_LATER", ms: ERROR_DISPLAY_MS }] };
      }
      return { ctx, effects: [] };
    }
    case "TRANSCRIPT":
      return onTranscript(ctx, event.text, event.isFinal, event.now);
    case "SILENCE_TIMEOUT":
      return ctx.state === "capturing" ? finishCapture(ctx, []) : { ctx, effects: [] };
    case "CAPTURE_TIMEOUT":
      return ctx.state === "capturing" ? finishCapture(ctx, []) : { ctx, effects: [] };
    case "PUSH_TO_TALK": {
      if (!ctx.supported || ctx.textOnlyReason) return { ctx, effects: [] };
      if (ctx.state === "capturing") return finishCapture(ctx, []);
      const effects: VoiceEffect[] = [];
      let next: VoiceContext = { ...ctx, voiceEnabled: true, error: null };
      if (ctx.muted) next = { ...next, oneShot: true };
      if (ctx.speaking) effects.push({ type: "CANCEL_TTS" });
      if (!ctx.recognitionActive) effects.push({ type: "START_RECOGNITION" });
      return beginCapture(next, "", "push", effects);
    }
    case "SUBMIT_TEXT": {
      const effects: VoiceEffect[] = ctx.speaking ? [{ type: "CANCEL_TTS" }] : [];
      return sendCommand(ctx, event.text, "text", effects);
    }
    case "SERVER":
      return onServer(ctx, event.message);
    case "CONFIRM_CLICK": {
      if (!ctx.confirmation) return { ctx, effects: [] };
      const effects: VoiceEffect[] = [{ type: "CLEAR_CONFIRM_TIMER" }, { type: "SEND_CONFIRM", approved: event.approved }];
      if (ctx.speaking) effects.unshift({ type: "CANCEL_TTS" });
      return { ctx: { ...ctx, confirmation: null, state: "sending", inTurn: true, pendingTools: 0 }, effects };
    }
    case "CONFIRM_TIMEOUT":
      // The card stays in the panel with its buttons; the microphone stops
      // treating every utterance as an answer.
      return ctx.state === "awaiting_confirmation" && !ctx.inTurn
        ? { ctx: { ...ctx, state: restingState(ctx) }, effects: [] }
        : { ctx, effects: [] };
    case "TTS_STARTED":
      return { ctx: { ...ctx, speaking: true, spokenText: event.text }, effects: [] };
    case "TTS_ENDED": {
      const next: VoiceContext = { ...ctx, speaking: false, cooldownUntil: event.now + POST_TTS_COOLDOWN_MS };
      if (next.oneShot && !next.inTurn && next.state !== "capturing") {
        const rested: VoiceContext = { ...next, oneShot: false };
        return { ctx: { ...rested, state: restingState(rested) }, effects: [{ type: "ABORT_RECOGNITION" }] };
      }
      if (next.state === "capturing" || next.state === "awaiting_confirmation" || next.inTurn) return { ctx: next, effects: [] };
      return settle(next, []);
    }
    case "CANCEL": {
      const effects: VoiceEffect[] = [{ type: "CANCEL_TTS" }, { type: "CLEAR_SILENCE_TIMER" }, { type: "CLEAR_CAPTURE_TIMER" }, { type: "CLEAR_CONFIRM_TIMER" }];
      if (ctx.inTurn) effects.push({ type: "SEND_CANCEL", reason: "user" });
      const next: VoiceContext = { ...ctx, inTurn: false, pendingTools: 0, committed: "", interim: "", captureSource: null, confirmation: null, error: null };
      return settle(next, effects);
    }
    case "SOCKET_STATUS": {
      const next: VoiceContext = { ...ctx, socket: event.status };
      if (event.status === "closed" && ctx.inTurn) {
        return { ctx: { ...next, inTurn: false, pendingTools: 0, state: "error", error: "Lost the connection to the assistant" }, effects: [{ type: "RESET_ERROR_LATER", ms: ERROR_DISPLAY_MS }] };
      }
      return { ctx: next, effects: [] };
    }
    case "ERROR_CLEARED":
      return ctx.state === "error" ? settle({ ...ctx, error: null }, []) : { ctx: { ...ctx, error: null }, effects: [] };
    default:
      return { ctx, effects: [] };
  }
}

function onTranscript(ctx: VoiceContext, text: string, isFinal: boolean, now: number): Transition {
  if (!shouldListen(ctx) || !text.trim()) return { ctx, effects: [] };
  if (now < ctx.cooldownUntil) return { ctx, effects: [] };

  const wake = matchWakeWord(text);

  if (ctx.speaking) {
    // Everything heard while we talk is our own voice unless it is clearly a wake word.
    if (!wake.matched || isEchoOf(text, ctx.spokenText)) return { ctx, effects: [] };
    return beginCapture({ ...ctx, speaking: false }, wake.remainder, "wake", [{ type: "CANCEL_TTS" }]);
  }

  switch (ctx.state) {
    case "idle_listening":
    case "sending":
    case "thinking":
    case "executing":
    case "error": {
      if (!wake.matched) return { ctx, effects: [] };
      return beginCapture(ctx, wake.remainder, "wake", []);
    }
    case "capturing": {
      const spoken = ctx.captureSource === "wake" && wake.matched ? wake.remainder : stripWakeWord(text);
      if (isFinal) {
        const next: VoiceContext = { ...ctx, committed: `${ctx.committed} ${spoken}`.trim(), interim: "" };
        return currentCommand(next) ? finishCapture(next, []) : { ctx: next, effects: [{ type: "START_SILENCE_TIMER", ms: WAIT_FOR_COMMAND_MS }] };
      }
      return { ctx: { ...ctx, interim: spoken }, effects: [{ type: "START_SILENCE_TIMER", ms: SILENCE_AFTER_SPEECH_MS }] };
    }
    case "awaiting_confirmation": {
      if (!isFinal) return { ctx, effects: [] };
      const command = wake.matched ? wake.remainder : stripWakeWord(text);
      const decision = matchConfirmation(command);
      if (decision) {
        return {
          ctx: { ...ctx, confirmation: null, state: "sending", inTurn: true, pendingTools: 0 },
          effects: [{ type: "CLEAR_CONFIRM_TIMER" }, { type: "SEND_CONFIRM", approved: decision === "yes" }],
        };
      }
      if (wake.matched && wake.remainder) {
        // A different request supersedes the pending question.
        return sendCommand({ ...ctx, confirmation: null }, wake.remainder, "voice", [{ type: "CLEAR_CONFIRM_TIMER" }]);
      }
      return { ctx, effects: [] };
    }
    default:
      return { ctx, effects: [] };
  }
}

function onServer(ctx: VoiceContext, message: { type: string } & Record<string, any>): Transition {
  switch (message.type) {
    case "turn_start":
      return { ctx: { ...ctx, inTurn: true, pendingTools: 0, state: ctx.confirmation ? "awaiting_confirmation" : "thinking" }, effects: [] };
    case "thinking":
    case "token":
      if (!ctx.inTurn) return { ctx, effects: [] };
      return { ctx: { ...ctx, state: ctx.confirmation ? "awaiting_confirmation" : ctx.pendingTools > 0 ? "executing" : "thinking" }, effects: [] };
    case "tool_start":
    case "client_tool_call":
      return { ctx: { ...ctx, inTurn: true, pendingTools: ctx.pendingTools + 1, state: ctx.confirmation ? "awaiting_confirmation" : "executing" }, effects: [] };
    case "tool_result": {
      const pendingTools = Math.max(0, ctx.pendingTools - 1);
      return { ctx: { ...ctx, pendingTools, state: ctx.confirmation ? "awaiting_confirmation" : pendingTools > 0 ? "executing" : "thinking" }, effects: [] };
    }
    case "confirmation_required": {
      const confirmation: PendingConfirmation = {
        actionId: message.action_id ?? null, tool: message.tool, effect: message.effect,
        summary: message.summary, arguments: message.arguments ?? {}, receivedAt: Date.now(),
      };
      return { ctx: { ...ctx, confirmation, state: "awaiting_confirmation" }, effects: [{ type: "START_CONFIRM_TIMER", ms: CONFIRMATION_WINDOW_MS }] };
    }
    case "speak":
      return { ctx, effects: message.text ? [{ type: "SPEAK", text: message.text }] : [] };
    case "error": {
      if (!message.turn_id && !ctx.inTurn) return { ctx: { ...ctx, error: message.message }, effects: [{ type: "RESET_ERROR_LATER", ms: ERROR_DISPLAY_MS }] };
      return { ctx: { ...ctx, state: "error", error: message.message, inTurn: false, pendingTools: 0 }, effects: [{ type: "RESET_ERROR_LATER", ms: ERROR_DISPLAY_MS }] };
    }
    case "done": {
      const next: VoiceContext = { ...ctx, inTurn: false, pendingTools: 0 };
      if (next.confirmation) return { ctx: { ...next, state: "awaiting_confirmation" }, effects: [] };
      if (next.state === "error") return { ctx: next, effects: [] };
      if (next.speaking) return { ctx: { ...next, state: next.state === "capturing" ? "capturing" : "thinking" }, effects: [] };
      if (next.state === "capturing") return { ctx: next, effects: [] };
      return settle(next, []);
    }
    default:
      return { ctx, effects: [] };
  }
}

/** The one word the orb and the caption line take their look from. */
export function displayState(ctx: VoiceContext): VoiceState | "speaking" {
  if (ctx.speaking && ctx.state !== "capturing" && ctx.state !== "error") return "speaking";
  return ctx.state;
}

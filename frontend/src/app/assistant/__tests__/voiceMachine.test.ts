import { describe, expect, it } from "vitest";

import type { ServerMessage, VoiceContext, VoiceEffect, VoiceEvent } from "../assistantTypes";
import { currentCommand, displayState, initialVoiceContext, shouldListen, transition } from "../voiceMachine";

function run(ctx: VoiceContext, ...events: VoiceEvent[]): { ctx: VoiceContext; effects: VoiceEffect[] } {
  const effects: VoiceEffect[] = [];
  let current = ctx;
  for (const event of events) {
    const result = transition(current, event);
    current = result.ctx;
    effects.push(...result.effects);
  }
  return { ctx: current, effects };
}

const server = (message: ServerMessage): VoiceEvent => ({ type: "SERVER", message });
const types = (effects: VoiceEffect[]) => effects.map((e) => e.type);
const ready = () => initialVoiceContext({ recognition: true, synthesis: true, voiceEnabled: true });

describe("voice machine", () => {
  it("keeps a hands-free conversation open across multiple requests", () => {
    const first = run(ready(),
      { type: "TRANSCRIPT", text: "Find graph papers.", isFinal: true, now: 1 },
      { type: "TRANSCRIPT", text: "Then open the newest one.", isFinal: true, now: 2 },
      { type: "SILENCE_TIMEOUT" },
    );
    expect(first.effects.filter((effect) => effect.type === "SEND_MESSAGE")).toEqual([
      { type: "SEND_MESSAGE", text: "Find graph papers. Then open the newest one.", source: "voice" },
    ]);
    const replied = run(first.ctx, server({ type: "done", turn_id: "t1", status: "ok", reason: null }));
    expect(shouldListen(replied.ctx)).toBe(true);
    const followUp = run(replied.ctx, { type: "TRANSCRIPT", text: "Summarize that paper.", isFinal: true, now: 3 }, { type: "SILENCE_TIMEOUT" });
    expect(followUp.effects).toContainEqual({ type: "SEND_MESSAGE", text: "Summarize that paper.", source: "voice" });
    expect(types(followUp.effects)).not.toContain("START_RECOGNITION");
  });

  it("adds spoken and typed instructions while work is running without cancelling it", () => {
    const busy = run(ready(), { type: "SUBMIT_TEXT", text: "find papers" }, server({ type: "turn_start", turn_id: "t1", message_id: "m1" }));
    const more = run(busy.ctx, { type: "TRANSCRIPT", text: "Then save a note.", isFinal: true, now: 1 }, { type: "SILENCE_TIMEOUT" }, { type: "SUBMIT_TEXT", text: "also compare them" });
    expect(more.effects.filter((effect) => effect.type === "SEND_MESSAGE")).toHaveLength(2);
    expect(types(more.effects)).not.toContain("SEND_CANCEL");
    const queued = transition(more.ctx, server({ type: "queue_state", message_ids: ["m2", "m3"], count: 2 }));
    expect(queued.ctx.queuedCount).toBe(2);
    expect(queued.ctx.inTurn).toBe(true);
  });

  it("preserves speech capture across tool events and turn completion", () => {
    const capture = run(ready(), { type: "SUBMIT_TEXT", text: "find papers" }, { type: "TRANSCRIPT", text: "also open", isFinal: false, now: 1 });
    const events = run(capture.ctx,
      server({ type: "turn_start", turn_id: "t1", message_id: "m1" }),
      server({ type: "thinking", turn_id: "t1", step: 1 }),
      server({ type: "tool_start", turn_id: "t1", call_id: "c1", tool: "app_papers", execution: "builtin", effect: "read", arguments: "{}", say: "Searching" }),
      server({ type: "client_tool_call", turn_id: "t1", call_id: "c1", tool: "open_paper", arguments: {} }),
      server({ type: "tool_result", turn_id: "t1", call_id: "c1", tool: "app_papers", status: "success", message: "found", effect: "read", execution: "builtin", duration_ms: 1 }),
      server({ type: "speak", turn_id: "t1", text: "Found it." }),
      server({ type: "done", turn_id: "t1", status: "ok", reason: null }),
    );
    expect(events.ctx.state).toBe("capturing");
    expect(events.ctx.pendingTools).toBe(0);
    expect(currentCommand(events.ctx)).toBe("also open");
    expect(types(events.effects)).not.toContain("SPEAK");
    const sent = run(events.ctx, { type: "TRANSCRIPT", text: "also open the newest paper", isFinal: true, now: 2 }, { type: "SILENCE_TIMEOUT" });
    expect(sent.effects).toContainEqual({ type: "SEND_MESSAGE", text: "also open the newest paper", source: "voice" });
  });

  it("does not arm a pause timer for an old final while the user keeps speaking", () => {
    const capture = run(ready(), { type: "TRANSCRIPT", text: "find papers", isFinal: false, now: 1 }, { type: "RECOGNITION_SPEECH_STARTED" });
    const oldFinal = transition(capture.ctx, { type: "TRANSCRIPT", text: "Find papers.", isFinal: true, now: 2 });
    expect(types(oldFinal.effects)).not.toContain("START_SILENCE_TIMER");
    const ended = run(oldFinal.ctx, { type: "RECOGNITION_SPEECH_ENDED" }, { type: "TRANSCRIPT", text: "Save a note too.", isFinal: true, now: 3 }, { type: "SILENCE_TIMEOUT" });
    expect(ended.effects).toContainEqual({ type: "SEND_MESSAGE", text: "Find papers. Save a note too.", source: "voice" });
  });

  it("stops and clears work by voice while leaving hands-free listening active", () => {
    const busy = { ...ready(), inTurn: true, queuedCount: 2 };
    const stop = transition(busy, { type: "TRANSCRIPT", text: "stop everything", isFinal: true, now: 1 });
    expect(stop.effects).toContainEqual({ type: "SEND_CANCEL", reason: "user" });
    expect(stop.ctx.queuedCount).toBe(0);
    expect(shouldListen(stop.ctx)).toBe(true);
    const mute = transition(stop.ctx, { type: "TRANSCRIPT", text: "stop listening", isFinal: true, now: 2 });
    expect(shouldListen(mute.ctx)).toBe(false);
    expect(types(mute.effects)).toContain("ABORT_RECOGNITION");
  });

  it("still speaks a required confirmation when more instructions are queued", () => {
    const asked = run({ ...ready(), queuedCount: 2 }, server({ type: "confirmation_required", turn_id: "t1", action_id: "a1", tool: "delete", effect: "destructive", arguments: {}, summary: "Delete this note?" }));
    const speak = transition(asked.ctx, server({ type: "speak", turn_id: "t1", text: "Delete this note?" }));
    expect(types(speak.effects)).toContain("SPEAK");
  });

  it("closes a muted one-shot microphone when a text-only response finishes", () => {
    const pushed = transition({ ...ready(), muted: true }, { type: "PUSH_TO_TALK" });
    const sent = run(pushed.ctx, { type: "TRANSCRIPT", text: "open the library", isFinal: true, now: 1 }, { type: "SILENCE_TIMEOUT" });
    const done = transition(sent.ctx, server({ type: "done", turn_id: "t-1", status: "ok", reason: null }));
    expect(done.ctx.oneShot).toBe(false);
    expect(done.ctx.state).toBe("muted");
    expect(types(done.effects)).toContain("ABORT_RECOGNITION");
  });

  it("cancels a one-shot capture and releases the microphone", () => {
    const pushed = transition({ ...ready(), muted: true }, { type: "PUSH_TO_TALK" });
    const cancelled = transition(pushed.ctx, { type: "CANCEL" });
    expect(cancelled.ctx.oneShot).toBe(false);
    expect(types(cancelled.effects)).toContain("ABORT_RECOGNITION");
  });

  it("stops retries for provider failures and permits a manual retry", () => {
    const failed = transition(ready(), { type: "RECOGNITION_ERROR", code: "provider", message: "Check billing", retryable: false });
    expect(failed.ctx.error).toBe("Check billing");
    expect(failed.ctx.voiceEnabled).toBe(false);
    expect(transition(failed.ctx, { type: "RECOGNITION_ENDED" }).effects).toEqual([]);
    expect(types(transition(failed.ctx, { type: "PUSH_TO_TALK" }).effects)).toContain("START_RECOGNITION");
  });

  it("falls back to text only when recognition is unsupported", () => {
    const ctx = initialVoiceContext({ recognition: false, synthesis: true });
    expect(ctx.state).toBe("text_only");
    expect(transition(ctx, { type: "PUSH_TO_TALK" }).effects).toEqual([]);
    const typed = transition(ctx, { type: "SUBMIT_TEXT", text: "hello" });
    expect(typed.ctx.state).toBe("sending");
    expect(typed.effects).toContainEqual({ type: "SEND_MESSAGE", text: "hello", source: "text" });
  });

  it("stays dormant until the user enables voice, then listens", () => {
    const ctx = initialVoiceContext({ recognition: true, synthesis: true });
    expect(ctx.state).toBe("dormant");
    const enabled = transition(ctx, { type: "ENABLE_VOICE" });
    expect(enabled.ctx.state).toBe("idle_listening");
    expect(types(enabled.effects)).toEqual(["START_RECOGNITION"]);
  });

  it("accepts an optional wake word and collects the request until a pause", () => {
    const heard = run(ready(),
      { type: "RECOGNITION_STARTED" },
      { type: "TRANSCRIPT", text: "hey", isFinal: false, now: 1 },
    );
    expect(heard.ctx.state).toBe("capturing");
    // "hey zoe" is enough to start listening for the command that follows.
    const woke = run(heard.ctx, { type: "TRANSCRIPT", text: "hey zoe", isFinal: false, now: 2 });
    expect(woke.ctx.state).toBe("capturing");
    expect(types(woke.effects)).toEqual(["CLEAR_SILENCE_TIMER"]);
    const capturing = run(woke.ctx, { type: "TRANSCRIPT", text: "hey zoetrope open", isFinal: false, now: 3 });
    expect(capturing.ctx.state).toBe("capturing");
    expect(capturing.ctx.interim).toBe("open");
    expect(types(capturing.effects)).toEqual(["CLEAR_SILENCE_TIMER"]);
    const sent = run(capturing.ctx, { type: "TRANSCRIPT", text: "hey zoetrope open the library", isFinal: true, now: 3 }, { type: "SILENCE_TIMEOUT" });
    expect(sent.ctx.state).toBe("sending");
    expect(sent.effects).toContainEqual({ type: "SEND_MESSAGE", text: "open the library", source: "voice" });
  });

  it("waits after a bare wake word and returns to listening if nothing follows", () => {
    const bare = run(ready(), { type: "TRANSCRIPT", text: "hey zoetrope", isFinal: true, now: 1 });
    expect(bare.ctx.state).toBe("capturing");
    expect(bare.effects).toContainEqual({ type: "START_SILENCE_TIMER", ms: 4000 });
    const quiet = transition(bare.ctx, { type: "SILENCE_TIMEOUT" });
    expect(quiet.ctx.state).toBe("idle_listening");
    expect(types(quiet.effects)).not.toContain("SEND_MESSAGE");
  });

  it("ignores its own voice and allows interruption without a wake word", () => {
    const speaking = run(ready(), { type: "TTS_STARTED", text: "I opened Graph RAG for Science at page four." });
    expect(displayState(speaking.ctx)).toBe("speaking");
    const echo = transition(speaking.ctx, { type: "TRANSCRIPT", text: "I opened graph rag for science at page four", isFinal: true, now: 5 });
    expect(echo.effects).toEqual([]);
    const unrelated = transition(speaking.ctx, { type: "TRANSCRIPT", text: "what is the weather", isFinal: true, now: 5 });
    expect(types(unrelated.effects)).toContain("CANCEL_TTS");
    expect(unrelated.ctx.committed).toBe("what is the weather");
    const barge = transition(speaking.ctx, { type: "TRANSCRIPT", text: "hey zoetrope stop", isFinal: false, now: 5 });
    expect(barge.ctx.state).toBe("capturing");
    expect(types(barge.effects)[0]).toBe("CANCEL_TTS");
  });

  it("filters echo after speech while accepting immediate follow-ups", () => {
    const ended = run(ready(), { type: "TTS_STARTED", text: "x" }, { type: "TTS_ENDED", now: 1000 });
    expect(transition(ended.ctx, { type: "TRANSCRIPT", text: "x", isFinal: true, now: 1200 }).effects).toEqual([]);
    expect(transition(ended.ctx, { type: "TRANSCRIPT", text: "tell me more", isFinal: true, now: 1200 }).ctx.state).toBe("capturing");
    expect(transition(ended.ctx, { type: "TRANSCRIPT", text: "hey zoetrope hi", isFinal: true, now: 1700 }).ctx.state).toBe("capturing");
  });

  it("follows a turn through thinking, executing and done", () => {
    const start = run(ready(), { type: "SUBMIT_TEXT", text: "find graph papers" }, server({ type: "turn_start", turn_id: "t-1", message_id: null }));
    expect(start.ctx.state).toBe("thinking");
    const tool = transition(start.ctx, server({ type: "tool_start", turn_id: "t-1", call_id: "c1", tool: "app_papers", execution: "builtin", effect: "read", arguments: "{}", say: "Searching" }));
    expect(tool.ctx.state).toBe("executing");
    const result = transition(tool.ctx, server({ type: "tool_result", turn_id: "t-1", call_id: "c1", tool: "app_papers", status: "success", message: "1 papers", effect: "read", execution: "builtin", duration_ms: 3 }));
    expect(result.ctx.state).toBe("thinking");
    const spoken = transition(result.ctx, server({ type: "speak", turn_id: "t-1", text: "Found one paper." }));
    expect(spoken.effects).toEqual([{ type: "SPEAK", text: "Found one paper." }]);
    const talking = transition(spoken.ctx, { type: "TTS_STARTED", text: "Found one paper." });
    const done = transition(talking.ctx, server({ type: "done", turn_id: "t-1", status: "ok", reason: null }));
    expect(done.ctx.inTurn).toBe(false);
    expect(displayState(done.ctx)).toBe("speaking");
    const quiet = transition(done.ctx, { type: "TTS_ENDED", now: 9 });
    expect(quiet.ctx.state).toBe("idle_listening");
  });

  it("handles confirmations by voice, by click and by timeout", () => {
    const asked = run(ready(),
      { type: "SUBMIT_TEXT", text: "delete note n1" },
      server({ type: "turn_start", turn_id: "t-1", message_id: null }),
      server({ type: "confirmation_required", turn_id: "t-1", action_id: "pa-1", tool: "api.notes.delete_note", effect: "destructive", arguments: {}, summary: "Delete note n1" }),
      server({ type: "done", turn_id: "t-1", status: "ok", reason: null }),
    );
    expect(asked.ctx.state).toBe("awaiting_confirmation");
    expect(asked.effects).toContainEqual({ type: "START_CONFIRM_TIMER", ms: 20000 });

    const yes = transition(asked.ctx, { type: "TRANSCRIPT", text: "yes", isFinal: true, now: 1 });
    expect(yes.effects).toContainEqual({ type: "SEND_CONFIRM", approved: true });
    expect(yes.ctx.confirmation).toBeNull();

    const interim = transition(asked.ctx, { type: "TRANSCRIPT", text: "ye", isFinal: false, now: 1 });
    expect(interim.effects).toEqual([]);

    const no = transition(asked.ctx, { type: "CONFIRM_CLICK", approved: false });
    expect(no.effects).toContainEqual({ type: "SEND_CONFIRM", approved: false });

    const other = run(asked.ctx, { type: "TRANSCRIPT", text: "open the library", isFinal: true, now: 1 }, { type: "SILENCE_TIMEOUT" });
    expect(other.effects).toContainEqual({ type: "SEND_MESSAGE", text: "open the library", source: "voice" });
    expect(other.ctx.confirmation).not.toBeNull();

    const timedOut = transition(asked.ctx, { type: "CONFIRM_TIMEOUT" });
    expect(timedOut.ctx.state).toBe("idle_listening");
    expect(timedOut.ctx.confirmation).not.toBeNull();
  });

  it("restarts recognition with growing backoff and stops on permission errors", () => {
    let ctx = ready();
    const first = transition(ctx, { type: "RECOGNITION_ENDED" });
    expect(first.effects).toEqual([{ type: "SCHEDULE_RESTART", delayMs: 250 }]);
    const second = transition(first.ctx, { type: "RECOGNITION_ENDED" });
    expect(second.effects).toEqual([{ type: "SCHEDULE_RESTART", delayMs: 500 }]);
    ctx = transition(second.ctx, { type: "RECOGNITION_STARTED" }).ctx;
    expect(ctx.restartDelayMs).toBe(250);

    const denied = transition(ctx, { type: "RECOGNITION_ERROR", code: "not-allowed" });
    expect(denied.ctx.state).toBe("text_only");
    expect(transition(denied.ctx, { type: "RECOGNITION_ENDED" }).effects).toEqual([]);
  });

  it("mutes and unmutes, and push-to-talk works once while muted", () => {
    const muted = transition(ready(), { type: "MUTE" });
    expect(muted.ctx.state).toBe("muted");
    expect(types(muted.effects)).toContain("ABORT_RECOGNITION");
    expect(transition(muted.ctx, { type: "TRANSCRIPT", text: "hey zoetrope hi", isFinal: true, now: 1 }).effects).toEqual([]);

    const push = transition(muted.ctx, { type: "PUSH_TO_TALK" });
    expect(push.ctx.state).toBe("capturing");
    expect(types(push.effects)).toContain("START_RECOGNITION");
    const spoke = run(push.ctx, { type: "TRANSCRIPT", text: "open the library", isFinal: true, now: 2 }, { type: "SILENCE_TIMEOUT" });
    expect(spoke.effects).toContainEqual({ type: "SEND_MESSAGE", text: "open the library", source: "voice" });

    const unmuted = transition(muted.ctx, { type: "UNMUTE" });
    expect(unmuted.ctx.state).toBe("idle_listening");
    expect(types(unmuted.effects)).toEqual(["START_RECOGNITION"]);
  });

  it("cancel stops speech and the running turn", () => {
    const busy = run(ready(), { type: "SUBMIT_TEXT", text: "x" }, server({ type: "turn_start", turn_id: "t-1", message_id: null }), { type: "TTS_STARTED", text: "y" });
    const cancelled = transition(busy.ctx, { type: "CANCEL" });
    expect(types(cancelled.effects)).toEqual(expect.arrayContaining(["CANCEL_TTS", "SEND_CANCEL"]));
    expect(cancelled.ctx.inTurn).toBe(false);
  });

  it("reports a lost connection during a turn as an error", () => {
    const busy = run(ready(), { type: "SUBMIT_TEXT", text: "x" }, server({ type: "turn_start", turn_id: "t-1", message_id: null }));
    const lost = transition(busy.ctx, { type: "SOCKET_STATUS", status: "closed" });
    expect(lost.ctx.state).toBe("error");
    expect(transition(lost.ctx, { type: "ERROR_CLEARED" }).ctx.state).toBe("idle_listening");
  });
});

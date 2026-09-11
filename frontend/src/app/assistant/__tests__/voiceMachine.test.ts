import { describe, expect, it } from "vitest";

import type { ServerMessage, VoiceContext, VoiceEffect, VoiceEvent } from "../assistantTypes";
import { displayState, initialVoiceContext, transition } from "../voiceMachine";

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

  it("captures after the wake word and sends on the final result", () => {
    const heard = run(ready(),
      { type: "RECOGNITION_STARTED" },
      { type: "TRANSCRIPT", text: "hey", isFinal: false, now: 1 },
    );
    expect(heard.ctx.state).toBe("idle_listening");
    // "hey zoe" is enough to start listening for the command that follows.
    const woke = run(heard.ctx, { type: "TRANSCRIPT", text: "hey zoe", isFinal: false, now: 2 });
    expect(woke.ctx.state).toBe("capturing");
    expect(types(woke.effects)).toEqual(["START_SILENCE_TIMER", "START_CAPTURE_TIMER"]);
    const capturing = run(woke.ctx, { type: "TRANSCRIPT", text: "hey zoetrope open", isFinal: false, now: 3 });
    expect(capturing.ctx.state).toBe("capturing");
    expect(capturing.ctx.interim).toBe("open");
    expect(types(capturing.effects)).toEqual(["START_SILENCE_TIMER"]);
    const sent = run(capturing.ctx, { type: "TRANSCRIPT", text: "hey zoetrope open the library", isFinal: true, now: 3 });
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

  it("ignores its own voice but lets a wake word barge in", () => {
    const speaking = run(ready(), { type: "TTS_STARTED", text: "I opened Graph RAG for Science at page four." });
    expect(displayState(speaking.ctx)).toBe("speaking");
    const echo = transition(speaking.ctx, { type: "TRANSCRIPT", text: "I opened graph rag for science at page four", isFinal: true, now: 5 });
    expect(echo.effects).toEqual([]);
    const unrelated = transition(speaking.ctx, { type: "TRANSCRIPT", text: "what is the weather", isFinal: true, now: 5 });
    expect(unrelated.effects).toEqual([]);
    const barge = transition(speaking.ctx, { type: "TRANSCRIPT", text: "hey zoetrope stop", isFinal: false, now: 5 });
    expect(barge.ctx.state).toBe("capturing");
    expect(types(barge.effects)[0]).toBe("CANCEL_TTS");
  });

  it("drops results during the post-speech cooldown", () => {
    const ended = run(ready(), { type: "TTS_STARTED", text: "x" }, { type: "TTS_ENDED", now: 1000 });
    expect(transition(ended.ctx, { type: "TRANSCRIPT", text: "hey zoetrope hi", isFinal: true, now: 1200 }).effects).toEqual([]);
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

    const other = transition(asked.ctx, { type: "TRANSCRIPT", text: "hey zoetrope open the library", isFinal: true, now: 1 });
    expect(other.effects).toContainEqual({ type: "SEND_MESSAGE", text: "open the library", source: "voice" });

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
    const spoke = transition(push.ctx, { type: "TRANSCRIPT", text: "open the library", isFinal: true, now: 2 });
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

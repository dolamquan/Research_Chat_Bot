import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptionHandlers } from "../liveTranscription";
import { AssistantProvider, useAssistant, type AssistantValue } from "../AssistantProvider";

const audio = vi.hoisted(() => ({ handlers: null as TranscriptionHandlers | null, start: vi.fn(), abort: vi.fn(), cancel: vi.fn(), speak: vi.fn() }));
vi.mock("../../api", () => ({ UNAUTHORIZED_EVENT: "test-auth", assistantSocketUrl: () => "ws://test/agent/ws", getAccessToken: () => "token", createNote: vi.fn() }));
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => ({ status: "disabled", user: { id: "local-dev" } }) }));
vi.mock("../useLiveTranscription", () => ({
  speechRecognitionSupported: () => true,
  useLiveTranscription: (handlers: TranscriptionHandlers) => {
    audio.handlers = handlers;
    return { start: audio.start, abort: audio.abort, isRunning: () => true, level: { current: 0 } };
  },
}));
vi.mock("../useSpeechSynthesis", () => ({
  speechSynthesisSupported: () => true,
  useSpeechSynthesis: () => ({ cancel: audio.cancel, speak: audio.speak, voices: [], voice: null, setVoice: vi.fn(), level: { current: 0 } }),
}));

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror = null;
  constructor() { Socket.instances.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

let assistant: AssistantValue;
function Probe() { assistant = useAssistant(); return <div>{assistant.caption.status}</div>; }
function connect() {
  render(<AssistantProvider><Probe /></AssistantProvider>);
  const socket = Socket.instances[0];
  act(() => {
    socket.readyState = 1;
    socket.onopen?.();
    socket.receive({ type: "session", session_id: "s1", history: [], pending_action: null, catalog_tool_count: 100 });
  });
  return socket;
}

describe("hands-free provider integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    Socket.instances = [];
    vi.stubGlobal("WebSocket", Socket);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("enables once, collects multiple instructions, queues follow-ups, and keeps listening after answers", () => {
    const socket = connect();
    act(() => assistant.actions.toggleMute());
    expect(audio.start).toHaveBeenCalledOnce();
    act(() => {
      audio.handlers!.onStart();
      audio.handlers!.onTranscript("Find graph papers.", true);
      vi.advanceTimersByTime(1000);
      audio.handlers!.onSpeechStart?.();
      audio.handlers!.onTranscript("Then open", false);
      vi.advanceTimersByTime(2000);
    });
    expect(socket.sent.filter((frame) => frame.type === "user_message")).toHaveLength(0);
    act(() => {
      audio.handlers!.onSpeechEnd?.();
      audio.handlers!.onTranscript("Then open the newest one.", true);
      vi.advanceTimersByTime(1400);
    });
    const first = socket.sent.find((frame) => frame.type === "user_message");
    expect(first.text).toBe("Find graph papers. Then open the newest one.");
    act(() => socket.receive({ type: "turn_start", turn_id: "t1", message_id: first.id }));
    act(() => {
      audio.handlers!.onTranscript("Summarize that paper.", true);
      vi.advanceTimersByTime(1400);
      assistant.actions.sendText("Then save it as a note.");
    });
    const followUps = socket.sent.filter((frame) => frame.type === "user_message").slice(1);
    expect(followUps.map((frame) => frame.text)).toEqual(["Summarize that paper.", "Then save it as a note."]);
    expect(socket.sent.filter((frame) => frame.type === "cancel")).toHaveLength(0);
    act(() => {
      socket.receive({ type: "queue_state", message_ids: followUps.map((frame) => frame.id), count: 2 });
    });
    expect(assistant.caption.status).toContain("2 queued");
    act(() => {
      socket.receive({ type: "done", turn_id: "t1", status: "ok", reason: null });
      socket.receive({ type: "queue_state", message_ids: [], count: 0 });
      socket.receive({ type: "turn_start", turn_id: "t2", message_id: followUps[0].id, message_ids: followUps.map((frame) => frame.id) });
      socket.receive({ type: "answer", turn_id: "t2", answer: "Saved.", spoken: "Saved.", sources: [], tool_trace: [], intent: "action" });
      socket.receive({ type: "done", turn_id: "t2", status: "ok", reason: null });
    });
    expect(assistant.turns).toHaveLength(2);
    expect(assistant.turns[1]).toMatchObject({ user: { text: "Summarize that paper.\n\nThen save it as a note." }, answer: "Saved.", status: "done" });
    expect(assistant.ctx.state).toBe("idle_listening");
    expect(assistant.ctx.recognitionActive).toBe(true);
    expect(audio.abort).not.toHaveBeenCalled();
  });

  it("preserves a request typed before the server's session handshake", () => {
    render(<AssistantProvider><Probe /></AssistantProvider>);
    const socket = Socket.instances[0];
    act(() => assistant.actions.sendText("Find papers."));
    act(() => { socket.readyState = 1; socket.onopen?.(); });
    expect(socket.sent.map((frame) => frame.type)).toEqual(["hello"]);
    act(() => socket.receive({ type: "session", session_id: "s1", history: [], pending_action: null, catalog_tool_count: 100 }));
    const frame = socket.sent.find((item) => item.type === "user_message");
    act(() => socket.receive({ type: "turn_start", turn_id: "t1", message_id: frame.id }));
    expect(assistant.turns[0]).toMatchObject({ id: "t1", user: { text: "Find papers." }, status: "running" });
  });

  it("retains unsent requests through a connection failure before the handshake", () => {
    render(<AssistantProvider><Probe /></AssistantProvider>);
    const first = Socket.instances[0];
    act(() => assistant.actions.sendText("Find papers."));
    act(() => { first.readyState = 3; first.onclose?.({ code: 1006 }); });
    expect(assistant.turns[0].status).toBe("pending");
    act(() => vi.advanceTimersByTime(1500));
    const reconnected = Socket.instances[1];
    act(() => {
      reconnected.readyState = 1;
      reconnected.onopen?.();
      reconnected.receive({ type: "session", session_id: "s1", history: [], pending_action: null, catalog_tool_count: 100 });
    });
    const frame = reconnected.sent.find((item) => item.type === "user_message");
    act(() => reconnected.receive({ type: "turn_start", turn_id: "t1", message_id: frame.id }));
    expect(assistant.turns[0]).toMatchObject({ id: "t1", status: "running" });
  });
});

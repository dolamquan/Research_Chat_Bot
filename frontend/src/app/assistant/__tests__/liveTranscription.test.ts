import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTranscription, SpeechAudioGate, TranscriptBuffer } from "../liveTranscription";
import workletSource from "../pcmCapture.worklet.js?raw";

describe("transcript reconciliation", () => {
  it("accumulates deltas, uses corrected finals and ignores duplicates", () => {
    const emit = vi.fn(), buffer = new TranscriptBuffer(emit);
    buffer.accept({ type: "transcription.delta", item_id: "a", delta: "open " });
    buffer.accept({ type: "transcription.delta", item_id: "a", delta: "paper" });
    buffer.accept({ type: "transcription.completed", item_id: "a", transcript: "Open the paper." });
    buffer.accept({ type: "transcription.completed", item_id: "a", transcript: "Open the paper." });
    expect(emit.mock.calls).toEqual([["open ", false], ["open paper", false], ["Open the paper.", true]]);
  });
  it("delivers completed turns in audio order", () => {
    const emit = vi.fn(), buffer = new TranscriptBuffer(emit);
    buffer.accept({ type: "input_audio_buffer.committed", item_id: "a" });
    buffer.accept({ type: "input_audio_buffer.committed", item_id: "b" });
    buffer.accept({ type: "transcription.completed", item_id: "b", transcript: "second" });
    expect(emit).not.toHaveBeenCalled();
    buffer.accept({ type: "transcription.completed", item_id: "a", transcript: "first" });
    expect(emit.mock.calls).toEqual([["first", true], ["second", true]]);
  });
});

describe("audio", () => {
  it("skips silence, retains pre-roll, and commits after trailing silence", () => {
    const send = vi.fn(), started = vi.fn(), gate = new SpeechAudioGate(send, started);
    for (let i = 0; i < 100; i++) gate.accept(new ArrayBuffer(4800), 0);
    expect(send).not.toHaveBeenCalled();
    gate.accept(new ArrayBuffer(4800), 0.1);
    expect(started).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 6; i++) gate.accept(new ArrayBuffer(4800), 0);
    expect(send).not.toHaveBeenCalledWith("commit");
    gate.accept(new ArrayBuffer(4800), 0);
    expect(send).toHaveBeenLastCalledWith("commit");
    send.mockClear();
    gate.accept(new ArrayBuffer(4800), 0);
    expect(send).not.toHaveBeenCalled();
  });
  it("encodes clipped little-endian PCM16 and mixes channels", () => {
    let Processor: any;
    const postMessage = vi.fn();
    class Base { port = { postMessage }; }
    new Function("AudioWorkletProcessor", "registerProcessor", workletSource)(Base, (_name: string, ctor: any) => { Processor = ctor; });
    const processor = new Processor();
    processor.process([[new Float32Array(2400).fill(-2)]]);
    expect(new DataView(postMessage.mock.calls[0][0].audio).getInt16(0, true)).toBe(-32768);
    processor.process([[new Float32Array(2400).fill(1), new Float32Array(2400).fill(-1)]]);
    expect(new DataView(postMessage.mock.calls[1][0].audio).getInt16(0, true)).toBe(0);
    expect(postMessage.mock.calls[1][0].rms).toBe(0);
  });
});

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  onopen: any; onmessage: any; onerror: any; onclose: any;
  send = vi.fn(); close = vi.fn();
  constructor() { FakeSocket.instances.push(this); }
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

describe("capture lifecycle", () => {
  let stop: ReturnType<typeof vi.fn>, getUserMedia: ReturnType<typeof vi.fn>;
  let node: any, handlers: any, client: LiveTranscription;
  beforeEach(() => {
    vi.useFakeTimers();
    stop = vi.fn();
    getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop, onended: null }] });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", class {
      sampleRate = 24000;
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      destination = {};
    });
    vi.stubGlobal("AudioWorkletNode", class {
      port = { onmessage: null, close: vi.fn() };
      connect = vi.fn(); disconnect = vi.fn();
      constructor() { node = this; }
    });
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    handlers = { onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn(), onTranscript: vi.fn(), onSpeechStart: vi.fn() };
    client = new LiveTranscription({ url: () => "ws://localhost/transcribe", token: () => "app-token", handlers });
  });
  afterEach(() => { client.stop(false); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("authenticates before streaming and stops all audio on mute", async () => {
    await client.start();
    const socket = FakeSocket.instances[0];
    socket.onopen();
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: "hello", token: "app-token" });
    node.port.onmessage({ data: { audio: new ArrayBuffer(4800), rms: 0.1 } });
    expect(socket.send).toHaveBeenCalledTimes(1);
    socket.receive({ type: "ready" });
    expect(handlers.onStart).toHaveBeenCalledOnce();
    node.port.onmessage({ data: { audio: new ArrayBuffer(4800), rms: 0.1 } });
    expect(socket.send.mock.calls[1][0]).toBeInstanceOf(ArrayBuffer);
    client.stop();
    expect(stop).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(node.port.onmessage).toBeNull();
    expect(client.level.current).toBe(0);
    expect(handlers.onEnd).toHaveBeenCalledOnce();
  });
  it("releases a microphone granted after cancellation without opening a socket", async () => {
    let grant!: (stream: unknown) => void;
    getUserMedia.mockReturnValue(new Promise(resolve => { grant = resolve; }));
    const starting = client.start();
    client.stop();
    grant({ getTracks: () => [{ stop }] });
    await starting;
    expect(stop).toHaveBeenCalledOnce();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(client.isRunning()).toBe(false);
  });
  it("ends once on provider failures and preserves the retry decision", async () => {
    await client.start();
    FakeSocket.instances[0].receive({ type: "error", code: "provider", message: "Unavailable", retryable: false });
    expect(handlers.onError).toHaveBeenCalledWith("provider", "Unavailable", false);
    expect(handlers.onEnd).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(client.isRunning()).toBe(false);
  });
});

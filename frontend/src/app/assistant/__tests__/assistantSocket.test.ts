import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantSocket } from "../assistantSocket";
import type { ServerMessage, SocketStatus } from "../assistantTypes";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  serverOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  serverSend(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  frames(): Array<{ type: string } & Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

function make(extra: Partial<ConstructorParameters<typeof AssistantSocket>[0]> = {}) {
  const messages: ServerMessage[] = [];
  const statuses: SocketStatus[] = [];
  const unauthorized = vi.fn();
  const socket = new AssistantSocket({
    url: () => "ws://test/agent/ws?access_token=t1",
    hello: () => ({ token: "t1", session_id: "s-old", client_tools: [], workspace: { active_view: "chat" }, client: { tts: true, locale: "en-US" } }),
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    onUnauthorized: unauthorized,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    random: () => 0.5,
    ...extra,
  });
  return { socket, messages, statuses, unauthorized };
}

describe("AssistantSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("says hello on open with the stored session and forwards server frames", () => {
    const { socket, messages, statuses } = make();
    socket.connect();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    expect(ws.frames()[0]).toMatchObject({ type: "hello", session_id: "s-old", workspace: { active_view: "chat" } });
    ws.serverSend({ type: "pong" });
    expect(messages).toEqual([{ type: "pong" }]);
    expect(statuses).toEqual(["connecting", "open"]);
    socket.close();
  });

  it("queues user messages while offline and flushes them after hello", () => {
    const { socket } = make();
    expect(socket.send({ type: "user_message", id: "m1", text: "hi", source: "text", workspace: {} })).toBe(false);
    expect(socket.send({ type: "client_tool_result", call_id: "stale", ok: true })).toBe(false);
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    const types = ws.frames().map((f) => f.type);
    expect(types).toEqual(["hello", "user_message"]);
    socket.close();
  });

  it("reconnects with backoff after an unexpected close", () => {
    const { socket, statuses } = make({ minBackoffMs: 1000 });
    socket.connect();
    FakeWebSocket.instances[0].serverOpen();
    FakeWebSocket.instances[0].serverClose();
    expect(statuses.at(-1)).toBe("closed");
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].serverClose();
    vi.advanceTimersByTime(1500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(600);
    expect(FakeWebSocket.instances).toHaveLength(3);
    socket.close();
  });

  it("reports an auth close and does not reconnect after close()", () => {
    const { socket, unauthorized } = make();
    socket.connect();
    FakeWebSocket.instances[0].serverClose(4401);
    expect(unauthorized).toHaveBeenCalledTimes(1);
    socket.close();
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("refresh() drops the current socket and dials again immediately", () => {
    const { socket } = make();
    socket.connect();
    FakeWebSocket.instances[0].serverOpen();
    socket.refresh();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED);
    socket.close();
  });
});

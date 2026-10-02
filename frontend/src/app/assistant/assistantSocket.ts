/**
 * The websocket to /agent/ws with reconnection, a hello on every open, and a
 * small outbox for frames typed while offline.
 */
import type { ClientMessage, ServerMessage, SocketStatus } from "./assistantTypes";

export type AssistantSocketOptions = {
  url: () => string;
  hello: () => Omit<Extract<ClientMessage, { type: "hello" }>, "type">;
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: SocketStatus) => void;
  onUnauthorized?: () => void;
  WebSocketImpl?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
};

const QUEUEABLE = new Set(["user_message", "confirm", "cancel"]);
const MAX_QUEUE = 32;

export class AssistantSocket {
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private outbox: ClientMessage[] = [];
  private helloSent = false;
  private sessionReady = false;
  private readonly Impl: typeof WebSocket;
  status: SocketStatus = "closed";

  constructor(private readonly options: AssistantSocketOptions) {
    this.Impl = options.WebSocketImpl ?? WebSocket;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  connect(): void {
    this.closedByUs = false;
    if (this.socket && (this.socket.readyState === this.Impl.OPEN || this.socket.readyState === this.Impl.CONNECTING)) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus("connecting");
    let socket: WebSocket;
    try {
      socket = new this.Impl(this.options.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.helloSent = false;
    this.sessionReady = false;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.sendRaw({ type: "hello", ...this.options.hello() });
      this.helloSent = true;
      this.setStatus("open");
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        this.options.onMessage(parsed as ServerMessage);
        if ((parsed as ServerMessage).type === "session") {
          this.sessionReady = true;
          const pending = this.outbox;
          this.outbox = [];
          pending.forEach((frame) => this.sendRaw(frame));
        }
      }
    };
    socket.onerror = () => {
      /* onclose follows and handles reconnection */
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus("closed");
      if (event.code === 4401 || event.code === 1008) {
        this.options.onUnauthorized?.();
      }
      if (!this.closedByUs) this.scheduleReconnect();
    };
  }

  /** Reconnect now with a fresh URL (e.g. after the auth token changed). */
  refresh(): void {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onclose = null;
      try {
        socket.close(1000, "refresh");
      } catch {
        /* ignore */
      }
      this.setStatus("closed");
    }
    this.attempts = 0;
    this.connect();
  }

  close(): void {
    this.closedByUs = true;
    this.outbox = [];
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close(1000, "closed");
      } catch {
        /* ignore */
      }
    }
    this.setStatus("closed");
  }

  /** Requests still in the local outbox have not run on the server. */
  pendingMessageIds(): Set<string> {
    return new Set(this.outbox.flatMap((frame) => "id" in frame && frame.id ? [frame.id] : []));
  }

  /** True when the frame went out immediately; false when queued or dropped. */
  send(frame: ClientMessage): boolean {
    if (frame.type === "cancel") {
      // Nothing buffered has run yet. Stop must discard it, including before
      // the first session handshake or when starting a new conversation.
      this.outbox = [];
    }
    if (this.socket && this.socket.readyState === this.Impl.OPEN && this.helloSent && this.sessionReady) {
      this.sendRaw(frame);
      return true;
    }
    if (QUEUEABLE.has(frame.type)) {
      if (this.outbox.length >= MAX_QUEUE) {
        this.options.onMessage({ type: "request_rejected", message_id: "id" in frame ? frame.id ?? null : null,
          message: "The instruction queue is full. Please wait before adding more." });
        return false;
      }
      this.outbox.push(frame);
      if (!this.closedByUs) this.connect();
    }
    return false;
  }

  private sendRaw(frame: ClientMessage): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      /* the close handler reconnects */
    }
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.reconnectTimer) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const min = this.options.minBackoffMs ?? 1000;
    const max = this.options.maxBackoffMs ?? 30000;
    const random = this.options.random ?? Math.random;
    const delay = Math.min(max, min * 2 ** this.attempts) * (0.8 + random() * 0.4);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && !this.closedByUs && !this.socket) {
      this.attempts = 0;
      this.connect();
    }
  };
}

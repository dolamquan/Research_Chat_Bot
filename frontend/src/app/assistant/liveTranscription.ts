export type TranscriptionHandlers = {
  onStart: () => void;
  onEnd: () => void;
  onError: (code: string, message?: string, retryable?: boolean) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
  onSpeechStart?: () => void;
};

/** Serialize finals in audio order, even when the provider completes out of order. */
export class TranscriptBuffer {
  private items = new Map<string, { text: string; final: boolean }>();
  private completed = new Set<string>();

  constructor(private emit: (text: string, isFinal: boolean) => void) {}

  accept(event: { type: string; item_id?: string; delta?: string; transcript?: string }): void {
    const id = event.item_id;
    if (!id || this.completed.has(id)) return;
    if (!this.items.has(id)) this.items.set(id, { text: "", final: false });
    const item = this.items.get(id)!;
    if (event.type.endsWith(".delta")) item.text += event.delta ?? "";
    if (event.type.endsWith(".completed")) {
      item.text = event.transcript ?? "";
      item.final = true;
    }
    while (this.items.size) {
      const [firstId, first] = this.items.entries().next().value!;
      if (!first.final) {
        if (first.text) this.emit(first.text, false);
        break;
      }
      this.items.delete(firstId);
      this.completed.add(firstId);
      if (this.completed.size > 128) this.completed.delete(this.completed.values().next().value!);
      this.emit(first.text, true);
    }
  }
}

export function speechRecognitionSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined"
    && typeof WebSocket !== "undefined";
}

/** 100 ms frames with 300 ms pre-roll and 700 ms trailing silence. */
export class SpeechAudioGate {
  private preRoll: ArrayBuffer[] = [];
  private speaking = false;
  private quietFrames = 0;
  private turnFrames = 0;

  constructor(private send: (audio: ArrayBuffer | "commit") => void, private onSpeechStart: () => void) {}

  accept(audio: ArrayBuffer, rms: number): void {
    const voiced = rms >= 0.015;
    if (!this.speaking) {
      this.preRoll.push(audio);
      if (!voiced) {
        this.preRoll = this.preRoll.slice(-3);
        return;
      }
      this.speaking = true;
      this.turnFrames = 0;
      this.quietFrames = 0;
      this.onSpeechStart();
      for (const frame of this.preRoll) this.send(frame);
      this.preRoll = [];
    } else {
      this.send(audio);
    }
    this.turnFrames++;
    this.quietFrames = voiced ? 0 : this.quietFrames + 1;
    if (this.quietFrames >= 7 || this.turnFrames >= 200) {
      this.send("commit");
      this.speaking = false;
    }
  }
}

type Capture = {
  context: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  node?: AudioWorkletNode;
  socket?: WebSocket;
  timer?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  ready: boolean;
};

/** One cancellable microphone + socket lifecycle. The voice reducer owns retries. */
export class LiveTranscription {
  private capture: Capture | null = null;
  readonly level = { current: 0 };

  constructor(private options: {
    url: () => string;
    token: () => string | null;
    handlers: TranscriptionHandlers;
  }) {}

  isRunning(): boolean { return this.capture !== null; }

  async start(): Promise<void> {
    if (this.capture) return;
    const handlers = this.options.handlers;
    let capture: Capture | undefined;
    try {
      const context = new AudioContext({ sampleRate: 24000 });
      const current: Capture = { context, ready: false };
      capture = current;
      this.capture = current;
      // Resume immediately while a push-to-talk click still has user activation.
      const resumed = context.resume();
      void resumed.catch(() => undefined);
      current.timer = setTimeout(() => this.fail(current, "network", "Voice input took too long to connect.", true), 20000);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (this.capture !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      for (const track of stream.getTracks()) {
        track.onended = () => this.fail(current, "audio-capture", "Microphone disconnected.", false);
      }
      await resumed;
      if (this.capture !== current) return;
      if (context.sampleRate !== 24000) throw new Error("Unsupported microphone sample rate");
      await context.audioWorklet.addModule(new URL("./pcmCapture.worklet.js", import.meta.url));
      if (this.capture !== current) return;
      const node = new AudioWorkletNode(context, "pcm-capture");
      current.node = node;
      current.source = context.createMediaStreamSource(stream);
      node.onprocessorerror = () => this.fail(current, "audio-capture", "Microphone processing failed.", false);
      const socket = new WebSocket(this.options.url());
      current.socket = socket;
      const transcripts = new TranscriptBuffer(handlers.onTranscript);
      const gate = new SpeechAudioGate(
        (frame) => socket.send(frame === "commit" ? JSON.stringify({ type: "commit" }) : frame),
        () => handlers.onSpeechStart?.(),
      );
      socket.onopen = () => {
        if (this.capture === current) socket.send(JSON.stringify({ type: "hello", token: this.options.token() ?? "" }));
      };
      socket.onmessage = (message) => {
        if (this.capture !== current) return;
        let event;
        try { event = JSON.parse(String(message.data)); } catch { return; }
        if (!event || typeof event.type !== "string") return;
        if (event.type === "ready" && !current.ready) {
          clearTimeout(current.timer);
          current.ready = true;
          current.heartbeat = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
          }, 10000);
          current.source!.connect(node);
          node.connect(context.destination);
          handlers.onStart();
        } else if (event.type === "error") {
          this.fail(current, event.code, event.message, Boolean(event.retryable));
        } else if (event.type === "input_audio_buffer.speech_started") {
          transcripts.accept(event);
          handlers.onSpeechStart?.();
        } else if (event.type === "input_audio_buffer.committed"
          || event.type === "conversation.item.input_audio_transcription.delta"
          || event.type === "conversation.item.input_audio_transcription.completed") {
          transcripts.accept(event);
        }
      };
      socket.onerror = () => this.fail(current, "network", "Speech recognition lost its connection.", true);
      socket.onclose = () => this.fail(current, "network", "Speech recognition lost its connection.", true);
      node.port.onmessage = (event: MessageEvent<{ audio: ArrayBuffer; rms: number }>) => {
        if (this.capture !== current || !current.ready || socket.readyState !== WebSocket.OPEN) return;
        // Never accumulate stale speech during a slow or broken connection.
        if (socket.bufferedAmount > 96000) {
          this.fail(current, "network", "Voice connection is too slow. Please try again.", true);
          return;
        }
        const gated = event.data.rms < 0.02 ? 0 : Math.min(1, (event.data.rms - 0.02) * 4);
        this.level.current = gated > this.level.current ? gated : this.level.current * 0.88 + gated * 0.12;
        gate.accept(event.data.audio, event.data.rms);
      };
    } catch (error) {
      // An old permission/setup promise may settle after mute or a newer start.
      if (capture && this.capture !== capture) return;
      const name = (error as { name?: string }).name;
      const denied = name === "NotAllowedError" || name === "SecurityError";
      const code = denied ? "not-allowed" : "audio-capture";
      const message = denied ? "Microphone access was denied." : "Could not start microphone capture.";
      if (capture) this.fail(capture, code, message, false);
      else { handlers.onError(code, message, false); handlers.onEnd(); }
    }
  }

  stop(notify = true): void {
    const capture = this.capture;
    if (!capture) return;
    this.capture = null;
    clearTimeout(capture.timer);
    clearInterval(capture.heartbeat);
    if (capture.socket) {
      capture.socket.onopen = capture.socket.onmessage = capture.socket.onerror = capture.socket.onclose = null;
      capture.socket.close();
    }
    if (capture.node) {
      capture.node.port.onmessage = null;
      capture.node.disconnect();
      capture.node.port.close();
    }
    capture.source?.disconnect();
    capture.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    void capture.context.close().catch(() => undefined);
    this.level.current = 0;
    if (notify) this.options.handlers.onEnd();
  }

  private fail(capture: Capture, code: string, message: string, retryable: boolean): void {
    if (this.capture !== capture) return;
    this.stop(false);
    this.options.handlers.onError(code, message, retryable);
    this.options.handlers.onEnd();
  }
}

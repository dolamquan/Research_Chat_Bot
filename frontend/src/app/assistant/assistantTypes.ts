import type { AgentToolTrace, Source } from "../types";

// ------------------------------------------------------------ wire protocol

export type ClientToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  effect: "read" | "write" | "destructive";
};

export type AssistantWorkspace = {
  active_view?: string | null;
  selected_paper?: { title?: string; source?: string; article_id?: string; cluster_label?: string } | null;
  reader?: { source?: string; title?: string; page?: number | null; total_pages?: number | null } | null;
  open_note?: { id?: string; title?: string; folder?: string } | null;
  selected_cluster?: { cluster_id?: number; cluster_label?: string } | null;
  visualizer?: { article_id?: string; title?: string; viz_id?: string | null } | null;
  library_filter?: { domain?: string | null; category?: string | null } | null;
  library_search?: string | null;
  pinned_sources?: Source[];
  active_chat_session?: { id?: string; title?: string | null } | null;
  context_mode?: string | null;
  retrieval_strategy?: string | null;
  visible_summary?: string | null;
  [key: string]: unknown;
};

export type ClientMessage =
  | {
      type: "hello";
      token: string;
      session_id: string | null;
      /**
       * The user asked for a fresh session. Without this the server cannot
       * tell this apart from a reconnect — both arrive with a null
       * `session_id` — and resumes the latest session instead.
       */
      new_session: boolean;
      client_tools: ClientToolSpec[];
      workspace: AssistantWorkspace;
      client: { tts: boolean; locale: string; app_version?: string };
    }
  | { type: "user_message"; id: string; text: string; source: "voice" | "text"; workspace: AssistantWorkspace }
  | { type: "client_tool_result"; call_id: string; ok: boolean; result?: unknown; error?: string }
  | { type: "confirm"; action_id: string | null; approved: boolean; workspace: AssistantWorkspace }
  | { type: "cancel"; reason: "barge_in" | "user" }
  | { type: "auth"; token: string }
  | { type: "workspace"; workspace: AssistantWorkspace }
  | { type: "ping" };

export type HistoryEntry = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
  spoken?: string | null;
  source?: string | null;
  tool_trace?: AgentToolTrace[];
  sources?: Source[];
};

export type PendingActionInfo = {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  effect: string;
  summary: string;
  expires_in?: number;
};

export type ServerMessage =
  | {
      type: "session";
      session_id: string;
      user: { id: string; email: string };
      client_tools: string[];
      history: HistoryEntry[];
      pending_action: PendingActionInfo | null;
      catalog_tool_count: number;
    }
  | { type: "turn_start"; turn_id: string; message_id: string | null }
  | { type: "thinking"; turn_id: string; step: number }
  | { type: "token"; turn_id: string; text: string }
  | {
      type: "tool_start";
      turn_id: string;
      call_id: string;
      tool: string;
      execution: string;
      effect: string;
      arguments: string;
      say: string;
    }
  | {
      type: "tool_result";
      turn_id: string;
      call_id: string;
      tool: string;
      status: string;
      message: string;
      effect: string;
      execution: string;
      duration_ms: number;
    }
  | { type: "client_tool_call"; turn_id: string; call_id: string; tool: string; arguments: Record<string, unknown> }
  | {
      type: "confirmation_required";
      turn_id: string;
      action_id: string;
      tool: string;
      effect: string;
      arguments: Record<string, unknown>;
      summary: string;
      expires_in?: number;
    }
  | { type: "speak"; turn_id: string; text: string }
  | {
      type: "answer";
      turn_id: string;
      answer: string;
      spoken: string;
      sources: Source[];
      tool_trace: AgentToolTrace[];
      intent: string;
      topology?: unknown;
    }
  | { type: "error"; turn_id: string | null; code: string; message: string }
  | { type: "done"; turn_id: string; status: "ok" | "cancelled" | "error"; reason: string | null }
  | { type: "pong" }
  | { type: "auth_ok" };

export type SocketStatus = "connecting" | "open" | "closed";

// ------------------------------------------------------------ UI-side model

export type UiAction = (...args: any[]) => unknown | Promise<unknown>;

export type LiveToolEvent = AgentToolTrace & {
  call_id: string;
  status: "running" | "success" | "error" | "skipped" | string;
  origin: "server" | "client";
  say?: string;
  startedAt: number;
  endedAt?: number;
  execution?: string;
};

export type AssistantTurn = {
  id: string;
  user: { text: string; source: "voice" | "text" };
  streamingText: string;
  answer: string | null;
  spoken: string | null;
  tools: LiveToolEvent[];
  sources: Source[];
  error: string | null;
  status: "pending" | "running" | "done" | "cancelled" | "error";
  createdAt: number;
};

export type PendingConfirmation = {
  actionId: string | null;
  tool: string;
  effect: string;
  summary: string;
  arguments: Record<string, unknown>;
  receivedAt: number;
};

// ------------------------------------------------------------ voice machine

export type VoiceState =
  | "text_only"
  | "dormant"
  | "muted"
  | "idle_listening"
  | "capturing"
  | "sending"
  | "thinking"
  | "executing"
  | "awaiting_confirmation"
  | "error";

export type VoiceContext = {
  state: VoiceState;
  supported: boolean;
  synthesisSupported: boolean;
  textOnlyReason: string | null;
  muted: boolean;
  voiceEnabled: boolean;
  oneShot: boolean;
  recognitionActive: boolean;
  restartDelayMs: number;
  speaking: boolean;
  spokenText: string;
  cooldownUntil: number;
  inTurn: boolean;
  pendingTools: number;
  committed: string;
  interim: string;
  captureSource: "wake" | "push" | null;
  confirmation: PendingConfirmation | null;
  error: string | null;
  socket: SocketStatus;
};

export type VoiceEvent =
  | { type: "CAPS"; recognition: boolean; synthesis: boolean }
  | { type: "ENABLE_VOICE" }
  | { type: "MIC_DENIED" }
  | { type: "MUTE" }
  | { type: "UNMUTE" }
  | { type: "RECOGNITION_STARTED" }
  | { type: "RECOGNITION_ENDED" }
  | { type: "RECOGNITION_ERROR"; code: string; message?: string; retryable?: boolean }
  | { type: "RECOGNITION_SPEECH_STARTED" }
  | { type: "TRANSCRIPT"; text: string; isFinal: boolean; now: number }
  | { type: "SILENCE_TIMEOUT" }
  | { type: "CAPTURE_TIMEOUT" }
  | { type: "PUSH_TO_TALK" }
  | { type: "SUBMIT_TEXT"; text: string }
  | { type: "SERVER"; message: ServerMessage }
  | { type: "CONFIRM_CLICK"; approved: boolean }
  | { type: "CONFIRM_TIMEOUT" }
  | { type: "TTS_STARTED"; text: string }
  | { type: "TTS_ENDED"; now: number }
  | { type: "CANCEL" }
  | { type: "SOCKET_STATUS"; status: SocketStatus }
  | { type: "ERROR_CLEARED" };

export type VoiceEffect =
  | { type: "START_RECOGNITION" }
  | { type: "ABORT_RECOGNITION" }
  | { type: "SCHEDULE_RESTART"; delayMs: number }
  | { type: "CANCEL_TTS" }
  | { type: "SPEAK"; text: string }
  | { type: "SEND_MESSAGE"; text: string; source: "voice" | "text" }
  | { type: "SEND_CONFIRM"; approved: boolean }
  | { type: "SEND_CANCEL"; reason: "barge_in" | "user" }
  | { type: "START_SILENCE_TIMER"; ms: number }
  | { type: "CLEAR_SILENCE_TIMER" }
  | { type: "START_CAPTURE_TIMER"; ms: number }
  | { type: "CLEAR_CAPTURE_TIMER" }
  | { type: "START_CONFIRM_TIMER"; ms: number }
  | { type: "CLEAR_CONFIRM_TIMER" }
  | { type: "RESET_ERROR_LATER"; ms: number };

import type {
  ChatHistoryItem,
  ChatResponse,
  ChatSession,
  ChatSessionDetail,
  ClusterGraph,
  ContextMode,
  DocumentDetail,
  Source,
} from "./types";

export const API_URL =
  import.meta.env.VITE_API_URL?.replace(/\/$/, "") ||
  (import.meta.env.DEV ? "/api" : "http://127.0.0.1:8002");

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, options);

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;

    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {
      // Keep the HTTP status when the response is not JSON.
    }

    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

export function getHealth(): Promise<{ status: string }> {
  return requestJson("/health");
}

export function getClusters(): Promise<ClusterGraph> {
  return requestJson("/clusters");
}

export function getDocumentDetail(source: string): Promise<DocumentDetail> {
  return requestJson(
    `/clusters/documents/detail?source=${encodeURIComponent(source)}&chunk_limit=5`,
  );
}

export function getPdfUrl(source: string): string {
  return `${API_URL}/documents/pdf?source=${encodeURIComponent(source)}`;
}

export function sendChat({
  sessionId,
  question,
  chatHistory,
  pinnedSources,
  clusterId,
  documentSource,
  contextMode = "retrieval",
}: {
  sessionId?: string;
  question: string;
  chatHistory: ChatHistoryItem[];
  pinnedSources: Source[];
  clusterId?: number;
  documentSource?: string;
  contextMode?: ContextMode;
}): Promise<ChatResponse> {
  return requestJson("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId ?? null,
      question,
      retrieval_limit: 20,
      context_limit: 5,
      context_mode: contextMode,
      use_reranking: true,
      parallel_reranking: true,
      rerank_workers: 3,
      chat_history: chatHistory,
      pinned_sources: pinnedSources,
      cluster_id: clusterId ?? null,
      document_source: documentSource ?? null,
    }),
  });
}

export function getChatSessions(): Promise<{ sessions: ChatSession[] }> {
  return requestJson("/chat/sessions");
}

export function getChatSession(sessionId: string): Promise<ChatSessionDetail> {
  return requestJson(`/chat/sessions/${encodeURIComponent(sessionId)}`);
}

export function deleteChatSession(sessionId: string): Promise<{ status: string }> {
  return requestJson(`/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

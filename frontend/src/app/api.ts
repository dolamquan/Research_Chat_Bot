import type {
  Article,
  ArticleDomain,
  ChatHistoryItem,
  ChatResponse,
  ChatSession,
  ChatSessionDetail,
  ClusterGraph,
  ContextMode,
  DocumentDetail,
  IngestUrlPayload,
  IngestUrlResponse,
  IngestionJob,
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

function scopedQuery({
  domain,
  category,
}: {
  domain?: string;
  category?: string;
} = {}): string {
  const params = new URLSearchParams();
  if (domain) params.set("domain", domain);
  if (category) params.set("category", category);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function getClusters(scope?: {
  domain?: string;
  category?: string;
}): Promise<ClusterGraph> {
  return requestJson(`/clusters${scopedQuery(scope)}`);
}

export function buildClusters(scope?: {
  domain?: string;
  category?: string;
  clusterCount?: number;
}): Promise<ClusterGraph> {
  return requestJson("/clusters/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cluster_count: scope?.clusterCount ?? null,
      domain: scope?.domain || null,
      category: scope?.category || null,
    }),
  });
}

export function getArticleDomains(): Promise<{ domains: ArticleDomain[] }> {
  return requestJson("/articles/domains");
}

export function getArticles({
  domain,
  category,
  limit = 5,
}: {
  domain?: string;
  category?: string;
  limit?: number;
} = {}): Promise<{ articles: Article[] }> {
  const params = new URLSearchParams();
  if (domain) params.set("domain", domain);
  if (category) params.set("category", category);
  params.set("limit", String(limit));

  return requestJson(`/articles?${params.toString()}`);
}

export function getDocumentDetail(source: string): Promise<DocumentDetail> {
  return requestJson(
    `/clusters/documents/detail?source=${encodeURIComponent(source)}&chunk_limit=5`,
  );
}

export function getPdfUrl(source: string): string {
  return `${API_URL}/documents/pdf?source=${encodeURIComponent(source)}`;
}

export function ingestUrlPaper(
  payload: IngestUrlPayload,
): Promise<IngestUrlResponse> {
  return requestJson("/ingest/url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function getIngestionJobs(
  limit = 10,
): Promise<{ jobs: IngestionJob[] }> {
  return requestJson(`/ingest/jobs?limit=${limit}`);
}

export function sendChat({
  sessionId,
  question,
  chatHistory,
  pinnedSources,
  clusterId,
  documentSource,
  domain,
  category,
  tags,
  contextMode = "retrieval",
}: {
  sessionId?: string;
  question: string;
  chatHistory: ChatHistoryItem[];
  pinnedSources: Source[];
  clusterId?: number;
  documentSource?: string;
  domain?: string;
  category?: string;
  tags?: string[];
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
      domain: domain ?? null,
      category: category ?? null,
      tags: tags ?? [],
    }),
  });
}

export function sendAgentChat({
  sessionId,
  question,
  chatHistory,
  pinnedSources,
  clusterId,
  documentSource,
  domain,
  category,
  tags,
  contextMode = "retrieval",
}: {
  sessionId?: string;
  question: string;
  chatHistory: ChatHistoryItem[];
  pinnedSources: Source[];
  clusterId?: number;
  documentSource?: string;
  domain?: string;
  category?: string;
  tags?: string[];
  contextMode?: ContextMode;
}): Promise<ChatResponse> {
  return requestJson("/agent/chat", {
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
      domain: domain ?? null,
      category: category ?? null,
      tags: tags ?? [],
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

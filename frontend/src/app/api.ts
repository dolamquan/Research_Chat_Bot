import type {
  AgentSession,
  AgentSessionDetail,
  Article,
  ArticleDomain,
  Annotation,
  AnnotationPayload,
  PaperSearchPayload,
  PaperSearchResponse,
  PaperVisualization,
  ChatHistoryItem,
  DiagramKind,
  ChatResponse,
  ChatSession,
  ChatSessionDetail,
  ClusterGraph,
  ContextMode,
  DocumentDetail,
  EvaluationRun,
  EvaluationRunPayload,
  EvaluationRunsResponse,
  GraphRagGraph,
  GraphRagNeighborsResponse,
  GraphRagPathResponse,
  GraphRagQueryResponse,
  IngestUrlPayload,
  IngestUrlResponse,
  IngestionJob,
  McpCallResponse,
  McpToolsResponse,
  NodeExpansion,
  RetrievalStrategy,
  Source,
  VisualAsset,
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

export function getGraphRag(scope?: {
  domain?: string;
  category?: string;
  articleIds?: string[];
}): Promise<GraphRagGraph> {
  const params = new URLSearchParams(scopedQuery(scope).replace(/^\?/, ""));
  for (const articleId of scope?.articleIds || []) {
    params.append("article_ids", articleId);
  }
  const query = params.toString();
  return requestJson(`/graph-rag${query ? `?${query}` : ""}`);
}

export function buildGraphRag(scope?: {
  domain?: string;
  category?: string;
  articleIds?: string[];
  conceptLimit?: number;
  similarityThreshold?: number;
}): Promise<GraphRagGraph> {
  return requestJson("/graph-rag/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      domain: scope?.domain || null,
      category: scope?.category || null,
      article_ids: scope?.articleIds || [],
      concept_limit: scope?.conceptLimit ?? 12,
      similarity_threshold: scope?.similarityThreshold ?? 2,
    }),
  });
}

export function queryGraphRag(payload: {
  query: string;
  domain?: string;
  category?: string;
  articleIds?: string[];
  limit?: number;
}): Promise<GraphRagQueryResponse> {
  return requestJson("/graph-rag/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: payload.query,
      domain: payload.domain || null,
      category: payload.category || null,
      article_ids: payload.articleIds || [],
      limit: payload.limit ?? 8,
    }),
  });
}

export function getGraphRagNeighbors(payload: {
  nodeId: string;
  domain?: string;
  category?: string;
  articleIds?: string[];
  limit?: number;
}): Promise<GraphRagNeighborsResponse> {
  return requestJson("/graph-rag/neighbors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: payload.nodeId,
      domain: payload.domain || null,
      category: payload.category || null,
      article_ids: payload.articleIds || [],
      limit: payload.limit ?? 30,
    }),
  });
}

export function explainGraphRagPath(payload: {
  sourceId: string;
  targetId: string;
  domain?: string;
  category?: string;
  articleIds?: string[];
  maxDepth?: number;
}): Promise<GraphRagPathResponse> {
  return requestJson("/graph-rag/path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_id: payload.sourceId,
      target_id: payload.targetId,
      domain: payload.domain || null,
      category: payload.category || null,
      article_ids: payload.articleIds || [],
      max_depth: payload.maxDepth ?? 5,
    }),
  });
}

export function getEvaluationRuns(): Promise<EvaluationRunsResponse> {
  return requestJson("/evaluate/runs");
}

export function getEvaluationRun(runId: string): Promise<EvaluationRun> {
  return requestJson(`/evaluate/runs/${encodeURIComponent(runId)}`);
}

export function runRagasEvaluation(
  payload: EvaluationRunPayload = {},
): Promise<unknown> {
  return requestJson("/evaluate/ragas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      retrieval_limit: payload.retrieval_limit ?? 20,
      context_limit: payload.context_limit ?? 5,
      use_reranking: payload.use_reranking ?? true,
      parallel_reranking: payload.parallel_reranking ?? true,
      rerank_workers: payload.rerank_workers ?? 3,
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

export function getVisualImageUrl(imageUrl: string): string {
  if (imageUrl.startsWith("http")) return imageUrl;
  return `${API_URL}${imageUrl}`;
}

export function getVisualAssets(
  source?: string,
  limit = 100,
): Promise<{ visuals: VisualAsset[] }> {
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  params.set("limit", String(limit));
  return requestJson(`/visuals?${params.toString()}`);
}

export function extractDocumentVisuals(
  source: string,
  maxImages = 20,
): Promise<{ status: string; visuals: VisualAsset[] }> {
  return requestJson(
    `/visuals/extract?source=${encodeURIComponent(source)}&max_images=${maxImages}`,
    { method: "POST" },
  );
}

export function captureDocumentVisual({
  source,
  imageData,
  articleId,
  title,
  page,
  caption,
}: {
  source: string;
  imageData: string;
  articleId?: string;
  title?: string;
  page?: number;
  caption?: string;
}): Promise<{ status: string; visual: VisualAsset }> {
  return requestJson("/visuals/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source,
      image_data: imageData,
      article_id: articleId,
      title,
      page,
      caption,
    }),
  });
}

export function uploadImageAsset({
  file,
  title,
  domain,
  category,
}: {
  file: File;
  title?: string;
  domain?: string;
  category?: string;
}): Promise<{ status: string; asset: VisualAsset }> {
  const formData = new FormData();
  formData.set("file", file);
  formData.set("title", title || "");
  formData.set("domain", domain || "research");
  formData.set("category", category || "uncategorized");

  return requestJson("/upload/image", {
    method: "POST",
    body: formData,
  });
}

export function getAnnotations(
  source?: string,
  limit = 100,
): Promise<{ annotations: Annotation[] }> {
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  params.set("limit", String(limit));
  return requestJson(`/annotations?${params.toString()}`);
}

export function createAnnotation(
  payload: AnnotationPayload,
): Promise<{ annotation: Annotation }> {
  return requestJson("/annotations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteAnnotation(
  annotationId: string,
): Promise<{ status: string }> {
  return requestJson(`/annotations/${encodeURIComponent(annotationId)}`, {
    method: "DELETE",
  });
}

export function searchArxivPapers(
  payload: PaperSearchPayload,
): Promise<PaperSearchResponse> {
  return requestJson("/crawler/arxiv/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function searchPapers(
  payload: PaperSearchPayload,
): Promise<PaperSearchResponse> {
  try {
    return await requestJson("/crawler/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (detail === "Not Found" || detail.includes("404")) {
      const fallback = await searchArxivPapers(payload);
      return {
        ...fallback,
        provider: "arxiv_fallback",
        sources: ["arxiv"],
        warning:
          "The multi-source crawler endpoint is not available on the running backend, so arXiv fallback was used.",
      };
    }
    throw error;
  }
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

export function getMcpTools(): Promise<McpToolsResponse> {
  return requestJson("/mcp/tools");
}

export function callMcpTool({
  toolName,
  arguments: args,
}: {
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<McpCallResponse> {
  return requestJson("/mcp/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool_name: toolName,
      arguments: args,
    }),
  });
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
  retrievalStrategy = "vector",
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
  retrievalStrategy?: RetrievalStrategy;
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
      retrieval_strategy: retrievalStrategy,
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

export function getAgentSessions(): Promise<{ sessions: AgentSession[] }> {
  return requestJson("/agent/sessions");
}

export function getAgentSession(sessionId: string): Promise<AgentSessionDetail> {
  return requestJson(`/agent/sessions/${encodeURIComponent(sessionId)}`);
}

export function deleteAgentSession(sessionId: string): Promise<{ status: string }> {
  return requestJson(`/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
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

export function generateVisualization({
  articleId,
  diagramKind = "auto",
  force = false,
}: {
  articleId: string;
  diagramKind?: "auto" | DiagramKind;
  force?: boolean;
}): Promise<{ visualization: PaperVisualization }> {
  return requestJson("/visualizer/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      article_id: articleId,
      diagram_kind: diagramKind,
      force,
    }),
  });
}

export function getVisualizations(
  articleId: string,
): Promise<{ visualizations: PaperVisualization[] }> {
  return requestJson(`/visualizer/${encodeURIComponent(articleId)}`);
}

export function deleteVisualization(vizId: string): Promise<{ status: string }> {
  return requestJson(`/visualizer/item/${encodeURIComponent(vizId)}`, {
    method: "DELETE",
  });
}

export function expandVisualizationNode({
  vizId,
  nodeId,
  force = false,
}: {
  vizId: string;
  nodeId: string;
  force?: boolean;
}): Promise<{ expansion: NodeExpansion }> {
  return requestJson("/visualizer/expand-node", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viz_id: vizId, node_id: nodeId, force }),
  });
}

export function getPreparedStages(
  vizId: string,
): Promise<{ prepared: string[]; expansions: NodeExpansion[] }> {
  return requestJson(
    `/visualizer/item/${encodeURIComponent(vizId)}/expansions`,
  );
}

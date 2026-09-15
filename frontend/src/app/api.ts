import type {
  RefineOutcome,
  SceneRecord,
  StageSceneRecord,
} from "./components/visualization/sceneTypes";
import type { LayoutReport, RuntimeVerdict } from "./components/visualization/sceneRuntime";
import { hasSketch, sketchFingerprint, renderSketch, CANVAS_ATTACHMENT_ID } from "./sketchExport";
import type {
  AgentContext,
  AgentSession,
  AgentSessionDetail,
  AgentTool,
  AgentToolCallResponse,
  AgentToolsResponse,
  Article,
  ArticleDomain,
  AuthMe,
  IntegrationStatus,
  NotionDatabase,
  Annotation,
  AnnotationPayload,
  PaperSearchPayload,
  PaperSearchResponse,
  PaperVisualization,
  AlgorithmVariant,
  ChatHistoryItem,
  DiagramKind,
  DiscussionMessage,
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
  ModificationPatch,
  NodeExpansion,
  NoteExportResult,
  NoteFolder,
  NoteSearchHit,
  NotionTarget,
  ResearchNote,
  PatchResultData,
  RetrievalStrategy,
  Source,
  VariantProposal,
  VariantTreeRow,
  VerificationReportData,
  VerificationRun,
  VisualAsset,
} from "./types";

export const API_URL =
  import.meta.env.VITE_API_URL?.replace(/\/$/, "") ||
  "/api";

let accessTokenProvider: () => string | null | undefined = () => undefined;

/** Registered by AuthProvider so every request carries the current session token. */
export function setAccessTokenProvider(provider: () => string | null | undefined): void {
  accessTokenProvider = provider;
}

/** Fired when the API refuses the current token; AuthProvider refreshes or signs out. */
export const UNAUTHORIZED_EVENT = "zoetrope:unauthorized";

/** For <img>, <iframe> and PDF viewers, which cannot send an Authorization header. */
function withAccessToken(url: string): string {
  const token = accessTokenProvider();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
}

/** The current session token, for transports that cannot set headers (the assistant websocket). */
export function getAccessToken(): string | null {
  return accessTokenProvider() ?? null;
}

/** ws(s):// address of the assistant socket, resolved against the page origin (dev: through the Vite proxy). */
export function assistantSocketUrl(): string {
  const base = new URL(API_URL, window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/$/, "")}/agent/ws`;
  base.search = "";
  return withAccessToken(base.toString());
}

/** Voice socket authenticates its first message; no token in the URL. */
export function transcriptionSocketUrl(): string {
  const base = new URL(API_URL, window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/$/, "")}/agent/transcribe`;
  base.search = "";
  return base.toString();
}

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const token = accessTokenProvider();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (response.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

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
  return withAccessToken(`${API_URL}/documents/pdf?source=${encodeURIComponent(source)}`);
}

export function getVisualImageUrl(imageUrl: string): string {
  if (imageUrl.startsWith("http")) return imageUrl;
  return withAccessToken(`${API_URL}${imageUrl}`);
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

// ------------------------------------------------------------------ notes

export type NoteCreatePayload = {
  note_type?: string;
  source_type?: string;
  source_ref?: string;
  source_title?: string;
  article_id?: string;
  page?: number;
  selected_text?: string;
  title?: string;
  body_md?: string;
  tags?: string[];
  folder_id?: string;
  sketch?: unknown;
};

export type NoteUpdatePayload = Partial<
  Pick<
    NoteCreatePayload,
    "title" | "body_md" | "selected_text" | "source_title" | "page" | "tags" | "folder_id" | "sketch"
  >
>;

export function listNotes(params: {
  noteType?: string;
  sourceRef?: string;
  folderId?: string;
  query?: string;
  limit?: number;
} = {}): Promise<{ notes: ResearchNote[] }> {
  const search = new URLSearchParams();
  if (params.noteType) search.set("note_type", params.noteType);
  if (params.sourceRef) search.set("source_ref", params.sourceRef);
  if (params.folderId) search.set("folder_id", params.folderId);
  if (params.query) search.set("q", params.query);
  search.set("limit", String(params.limit ?? 500));
  return requestJson(`/notes?${search.toString()}`);
}

export function createNote(payload: NoteCreatePayload): Promise<{ note: ResearchNote }> {
  return requestJson("/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function updateNote(
  noteId: string,
  payload: NoteUpdatePayload,
): Promise<{ note: ResearchNote }> {
  return requestJson(`/notes/${encodeURIComponent(noteId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteNote(noteId: string): Promise<{ status: string }> {
  return requestJson(`/notes/${encodeURIComponent(noteId)}`, {
    method: "DELETE",
  });
}

export function addNoteAttachment(
  noteId: string,
  payload: { kind: string; name: string; data_url: string; scene?: unknown; client_id?: string },
): Promise<{ attachment: { attachment_id: string } }> {
  return requestJson(`/notes/${encodeURIComponent(noteId)}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteNoteAttachment(attachmentId: string): Promise<{ status: string }> {
  return requestJson(`/notes/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}

export function noteAttachmentUrl(attachmentId: string): string {
  return withAccessToken(`${API_URL}/notes/attachments/${encodeURIComponent(attachmentId)}`);
}

export function getNoteAttachmentScene(
  attachmentId: string,
): Promise<{ scene: unknown }> {
  return requestJson(`/notes/attachments/${encodeURIComponent(attachmentId)}/scene`);
}

export function listNoteFolders(): Promise<{ folders: NoteFolder[] }> {
  return requestJson("/notes/folders");
}

export function createServerNoteFolder(
  name: string,
  parentId = "",
): Promise<{ folder: NoteFolder }> {
  return requestJson("/notes/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parent_id: parentId }),
  });
}

export function updateNoteFolder(
  folderId: string,
  payload: { name?: string; parent_id?: string },
): Promise<{ folder: NoteFolder }> {
  return requestJson(`/notes/folders/${encodeURIComponent(folderId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteNoteFolder(folderId: string): Promise<{
  status: string;
  parent_id: string;
  notes_moved: number;
  folders_moved: number;
}> {
  return requestJson(`/notes/folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
  });
}

export function listNotionTargets(): Promise<{ targets: NotionTarget[] }> {
  return requestJson("/notes/notion/targets");
}

export function createNotionTarget(payload: {
  name: string;
  database_id: string;
}): Promise<{ target: NotionTarget }> {
  return requestJson("/notes/notion/targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteNotionTarget(targetId: string): Promise<{ status: string }> {
  return requestJson(`/notes/notion/targets/${encodeURIComponent(targetId)}`, {
    method: "DELETE",
  });
}

export async function exportNoteToNotion(
  noteId: string,
  payload: { target_id?: string; database_id?: string } = {},
): Promise<NoteExportResult> {
  // Older saved notes may contain only editable canvas JSON. Render it in
  // the browser before the backend uploads the note's images to Notion.
  const { note } = await requestJson<{ note: ResearchNote }>(`/notes/${encodeURIComponent(noteId)}`);
  if (hasSketch(note.sketch)) {
    const fingerprint = sketchFingerprint(note.sketch);
    let hasSnapshot = false;
    for (const attachment of note.attachments.filter(item => item.has_scene)) {
      const { scene } = await getNoteAttachmentScene(attachment.attachment_id);
      if (hasSketch(scene) && sketchFingerprint(scene) === fingerprint) {
        hasSnapshot = true;
        break;
      }
    }
    if (!hasSnapshot) {
      await addNoteAttachment(noteId, {
        client_id: CANVAS_ATTACHMENT_ID, kind: "sketch", name: "Current sketch.png",
        data_url: await renderSketch(note.sketch), scene: note.sketch,
      });
    }
  }
  return requestJson(`/notes/${encodeURIComponent(noteId)}/export-notion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target_id: payload.target_id || "",
      database_id: payload.database_id || "",
    }),
  });
}

export function searchNotes(
  query: string,
  limit = 8,
): Promise<{ results: NoteSearchHit[] }> {
  return requestJson("/notes/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
}

export function migrateWorkspaceNotes(payload: {
  folders: { id: string; name: string }[];
  notes: {
    id: string;
    title: string;
    body: string;
    folder_id: string;
    scope_id: string;
    scope_title: string;
    sketch?: unknown;
    created_at: string;
    updated_at: string;
    attachments: { kind: string; name: string; data_url: string; scene?: unknown }[];
  }[];
}): Promise<{ status: string; imported: number; skipped: number }> {
  return requestJson("/notes/migrate-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
  workspace,
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
  workspace?: Record<string, unknown>;
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
      workspace: workspace ?? {},
    }),
  });
}

export function getAgentTools({
  query = "",
  category = "",
  offset = 0,
  limit = 200,
}: {
  query?: string;
  category?: string;
  offset?: number;
  limit?: number;
} = {}): Promise<AgentToolsResponse> {
  const params = new URLSearchParams({
    query,
    category,
    offset: String(offset),
    limit: String(limit),
  });
  return requestJson(`/agent/tools?${params.toString()}`);
}

export function getAgentTool(name: string): Promise<AgentTool> {
  return requestJson(`/agent/tools/${encodeURIComponent(name)}`);
}

export function callAgentTool({
  name,
  arguments: args,
  workspace,
}: {
  name: string;
  arguments: Record<string, unknown>;
  workspace?: Record<string, unknown>;
}): Promise<AgentToolCallResponse> {
  return requestJson("/agent/tools/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, arguments: args, workspace: workspace ?? {} }),
  });
}

export function getAgentContext(): Promise<AgentContext> {
  return requestJson("/agent/context");
}

/** Identity as the backend sees it; an admin's first call adopts pre-account data. */
export function getAuthMe(): Promise<AuthMe> {
  return requestJson("/auth/me");
}

export function setArticleVisibility(
  articleId: string,
  isPublic: boolean,
): Promise<Article> {
  return requestJson(`/articles/${encodeURIComponent(articleId)}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public: isPublic }),
  });
}

export function getIntegrations(): Promise<{ integrations: IntegrationStatus[] }> {
  return requestJson("/integrations");
}

export function setIntegrationSecret(
  provider: string,
  secret: string,
): Promise<{ integration: IntegrationStatus }> {
  return requestJson(`/integrations/${encodeURIComponent(provider)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
}

export function deleteIntegrationSecret(
  provider: string,
): Promise<{ status: string; integration: IntegrationStatus }> {
  return requestJson(`/integrations/${encodeURIComponent(provider)}`, { method: "DELETE" });
}

/** Notion's consent page for the signed-in user; navigate the browser there. */
export function getNotionAuthorizeUrl(): Promise<{ url: string }> {
  return requestJson("/integrations/notion/authorize");
}

export function listNotionDatabases(): Promise<{ databases: NotionDatabase[] }> {
  return requestJson("/integrations/notion/databases");
}

/** `agent` is the retired Agent tab's sessions, `assistant` Zoe's, `all` both. */
export function getAgentSessions(
  kind: "agent" | "assistant" | "all" = "agent",
): Promise<{ sessions: AgentSession[] }> {
  return requestJson(`/agent/sessions?kind=${kind}`);
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

// --- algorithm scenes --------------------------------------------------------
//
// A scene is a model-written Three.js program (see backend/app/rag/
// scene_coder.py). It executes only inside the sandboxed iframe built by
// components/visualization/sceneRuntime.ts, never in the app's own realm.

export function generateAlgorithmScene({
  vizId,
  force = false,
  provider,
  model,
  allowOfflineFallback = false,
  runtimeError,
  layoutReport,
}: {
  vizId: string;
  force?: boolean;
  provider?: string;
  model?: string;
  allowOfflineFallback?: boolean;
  /** With `force`, the stored code is repaired against this crash… */
  runtimeError?: string;
  /** …or against these measured label collisions, instead of rewritten blind. */
  layoutReport?: LayoutReport;
}): Promise<{ scene: SceneRecord; fallback?: string }> {
  return requestJson("/visualizer/generate-scene", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      viz_id: vizId,
      force,
      provider: provider ?? null,
      model: model ?? null,
      allow_offline_fallback: allowOfflineFallback,
      runtime_error: runtimeError ?? null,
      layout_report: layoutReport ?? null,
    }),
  });
}

export function getAlgorithmScene(
  vizId: string,
): Promise<{ scene: SceneRecord }> {
  return requestJson(
    `/visualizer/item/${encodeURIComponent(vizId)}/scene`,
  );
}

export function verifyAlgorithmScene(
  vizId: string,
): Promise<{ scene: SceneRecord }> {
  return requestJson(
    `/visualizer/item/${encodeURIComponent(vizId)}/verify-scene`,
    { method: "POST" },
  );
}

export function listSceneProviders(): Promise<{ providers: string[] }> {
  return requestJson("/visualizer/providers");
}

// Per-node stage scenes: the same generated-code pipeline, scoped to one
// diagram node. Rendered by the stage overlay in the visualizer.

const pendingStageScenes = new Map<string, Promise<{ stage_scene: StageSceneRecord }>>();

export function generateStageScene({
  vizId,
  nodeId,
  force = false,
  provider,
  model,
  runtimeError,
  layoutReport,
}: {
  vizId: string;
  nodeId: string;
  force?: boolean;
  provider?: string;
  model?: string;
  runtimeError?: string;
  layoutReport?: LayoutReport;
}): Promise<{ stage_scene: StageSceneRecord }> {
  const key = JSON.stringify([
    vizId, nodeId, force, provider ?? null, model ?? null, runtimeError ?? null, layoutReport ?? null,
  ]);
  const pending = pendingStageScenes.get(key);
  if (pending) return pending;
  const request = requestJson<{ stage_scene: StageSceneRecord }>("/visualizer/generate-stage-scene", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      viz_id: vizId,
      node_id: nodeId,
      force,
      provider: provider ?? null,
      model: model ?? null,
      runtime_error: runtimeError ?? null,
      layout_report: layoutReport ?? null,
    }),
  }).finally(() => pendingStageScenes.delete(key));
  pendingStageScenes.set(key, request);
  return request;
}

export function getStageScenes(
  vizId: string,
): Promise<{ stage_scenes: StageSceneRecord[] }> {
  return requestJson(
    `/visualizer/item/${encodeURIComponent(vizId)}/stage-scenes`,
  );
}

// Runtime verdicts. The server cannot run Three.js; after the browser has
// probed a scene it posts what happened so "ready" survives a reload and a
// crashing scene is never counted as prepared.

function verdictBody(verdict: RuntimeVerdict): string {
  return JSON.stringify({
    status: verdict.status,
    error: verdict.error ?? null,
    overlaps: verdict.overlaps,
    samples: verdict.samples,
  });
}

export function reportAlgorithmSceneRuntime({
  vizId,
  verdict,
}: {
  vizId: string;
  verdict: RuntimeVerdict;
}): Promise<{ scene: SceneRecord }> {
  return requestJson(`/visualizer/item/${encodeURIComponent(vizId)}/runtime`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: verdictBody(verdict),
  });
}

export function reportStageSceneRuntime({
  vizId,
  nodeId,
  verdict,
}: {
  vizId: string;
  nodeId: string;
  verdict: RuntimeVerdict;
}): Promise<{ stage_scene: StageSceneRecord }> {
  return requestJson(
    `/visualizer/item/${encodeURIComponent(vizId)}/stage-scenes/${encodeURIComponent(nodeId)}/runtime`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: verdictBody(verdict) },
  );
}

// User-directed refinement. A 409 is not an error here: it is the server
// saying the change alters the method and asking the user to confirm, with
// nothing generated yet. `requestJson` would flatten that into a thrown
// "[object Object]", so this path reads the body itself.
async function refineRequest<T>(
  path: string,
  body: { instruction: string; acknowledge_fundamental: boolean },
  key: "scene" | "stage_scene",
): Promise<RefineOutcome<T>> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = accessTokenProvider();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (response.status === 409) {
    const payload = await response.json().catch(() => ({}));
    const detail = (payload?.detail ?? {}) as { kind?: string; reason?: string; basis?: string };
    return {
      status: "needs_acknowledgement",
      classification: {
        kind: detail.kind === "cosmetic" ? "cosmetic" : "fundamental",
        reason: String(detail.reason ?? ""),
        basis: String(detail.basis ?? ""),
      },
    };
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (typeof payload?.detail === "string") detail = payload.detail;
    } catch {
      // Keep the HTTP status when the response is not JSON.
    }
    throw new Error(detail);
  }
  const payload = await response.json();
  return { status: "refined", record: payload[key] as T, classification: payload.classification };
}

export function refineAlgorithmScene({
  vizId,
  instruction,
  acknowledgeFundamental = false,
}: {
  vizId: string;
  instruction: string;
  acknowledgeFundamental?: boolean;
}): Promise<RefineOutcome<SceneRecord>> {
  return refineRequest<SceneRecord>(
    `/visualizer/item/${encodeURIComponent(vizId)}/refine`,
    { instruction, acknowledge_fundamental: acknowledgeFundamental },
    "scene",
  );
}

export function refineStageScene({
  vizId,
  nodeId,
  instruction,
  acknowledgeFundamental = false,
}: {
  vizId: string;
  nodeId: string;
  instruction: string;
  acknowledgeFundamental?: boolean;
}): Promise<RefineOutcome<StageSceneRecord>> {
  return refineRequest<StageSceneRecord>(
    `/visualizer/item/${encodeURIComponent(vizId)}/stage-scenes/${encodeURIComponent(nodeId)}/refine`,
    { instruction, acknowledge_fundamental: acknowledgeFundamental },
    "stage_scene",
  );
}

export function proposeModification({
  targetId,
  intent,
  maxOps = 8,
  signal,
}: {
  targetId: string;
  intent: string;
  maxOps?: number;
  signal?: AbortSignal;
}): Promise<{ proposal: VariantProposal }> {
  return requestJson("/variants/propose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_id: targetId, intent, max_ops: maxOps }),
    signal,
  });
}

export function applyModification({
  targetId,
  intent,
  patch,
  dropOpIndices = [],
}: {
  targetId: string;
  intent: string;
  patch: ModificationPatch;
  dropOpIndices?: number[];
}): Promise<{
  variant: AlgorithmVariant;
  patch_result: PatchResultData;
  run: VerificationRun;
}> {
  return requestJson("/variants/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target_id: targetId,
      intent,
      patch,
      drop_op_indices: dropOpIndices,
    }),
  });
}

export function getVariantsForVisualization(vizId: string): Promise<{
  variants: AlgorithmVariant[];
  tree: VariantTreeRow[];
}> {
  return requestJson(`/variants/for-visualization/${encodeURIComponent(vizId)}`);
}

export function verifyTarget(
  targetId: string,
): Promise<{ run: VerificationRun; report: VerificationReportData }> {
  return requestJson(`/variants/item/${encodeURIComponent(targetId)}/verify`, {
    method: "POST",
  });
}

export function deleteVariant(
  variantId: string,
): Promise<{ status: string; deleted: number }> {
  return requestJson(`/variants/item/${encodeURIComponent(variantId)}`, {
    method: "DELETE",
  });
}

export function discussChange({
  targetId,
  message,
  signal,
}: {
  targetId: string;
  message: string;
  signal?: AbortSignal;
}): Promise<{ message: DiscussionMessage; history: DiscussionMessage[] }> {
  return requestJson(`/variants/item/${encodeURIComponent(targetId)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });
}

export function getDiscussion(
  targetId: string,
): Promise<{ history: DiscussionMessage[] }> {
  return requestJson(`/variants/item/${encodeURIComponent(targetId)}/chat`);
}

export function clearDiscussion(
  targetId: string,
): Promise<{ status: string; removed: number }> {
  return requestJson(`/variants/item/${encodeURIComponent(targetId)}/chat`, {
    method: "DELETE",
  });
}

/**
 * Routes the visualizer needs. A backend running older code answers 404 for
 * these, which surfaces as a bare "Not Found" on every action — so we detect
 * it up front and say what is actually wrong.
 */
export const REQUIRED_ROUTES = [
  "/variants/propose",
  "/variants/apply",
  "/variants/item/{target_id}/verify",
  "/variants/item/{target_id}/chat",
  "/visualizer/generate",
] as const;

export async function getMissingBackendRoutes(): Promise<string[]> {
  try {
    const response = await fetch(`${API_URL}/openapi.json`);
    if (!response.ok) return [];
    const spec = (await response.json()) as { paths?: Record<string, unknown> };
    const paths = new Set(Object.keys(spec.paths ?? {}));
    return REQUIRED_ROUTES.filter((route) => !paths.has(route));
  } catch {
    // A network failure is a different problem; don't cry "stale" over it.
    return [];
  }
}

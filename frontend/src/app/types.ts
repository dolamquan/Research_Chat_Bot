export type ChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type Source = {
  id?: string | number;
  text?: string;
  source?: string;
  article_id?: string;
  title?: string;
  url?: string;
  domain?: string;
  category?: string;
  tags?: string[];
  score?: number;
  rerank_score?: number;
  topic?: string;
  document_type?: string;
  section_type?: string;
  keywords?: string[];
  summary?: string;
  page?: number;
  selection?: boolean;
  asset_id?: string;
  image_url?: string;
  image_path?: string;
  [key: string]: unknown;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  pinnedSources?: Source[];
  timestamp: Date;
};

export type Cluster = {
  cluster_id: number;
  cluster_label: string;
  document_count: number;
};

export type ClusterDocument = {
  document_id?: string;
  article_id?: string;
  title?: string;
  url?: string;
  domain?: string;
  category?: string;
  tags?: string[];
  source: string;
  chunk_count: number;
  cluster_id: number;
  cluster_label: string;
  x: number;
  y: number;
};

export type ClusterGraph = {
  clusters: Cluster[];
  documents: ClusterDocument[];
  scope?: {
    domain?: string | null;
    category?: string | null;
  };
  stale?: boolean;
};

export type DocumentDetail = ClusterDocument & {
  preview_chunks?: Source[];
};

export type Article = {
  article_id: string;
  title: string;
  source: string;
  url?: string;
  pdf_url?: string;
  domain: string;
  category: string;
  tags: string[];
  abstract?: string;
  authors?: string[];
  published_at?: string;
  updated_at_source?: string;
  status: "indexed" | "failed" | string;
  error?: string | null;
  created_at: string;
  updated_at: string;
};

export type IngestUrlPayload = {
  url: string;
  title?: string;
  domain?: string;
  category?: string;
  tags?: string[];
};

export type IngestUrlResponse = {
  status: string;
  job: IngestionJob;
  article?: Article;
  pdf_path?: string;
  pdf_url?: string;
};

export type IngestionJob = {
  job_id: string;
  url: string;
  title?: string;
  domain: string;
  category: string;
  tags: string[];
  status: "queued" | "running" | "indexed" | "failed" | string;
  stage: string;
  message: string;
  article_id?: string | null;
  article_title?: string | null;
  source?: string | null;
  pdf_url?: string | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

export type Annotation = {
  annotation_id: string;
  source: string;
  article_id?: string | null;
  title?: string | null;
  page: number;
  selected_text: string;
  note: string;
  created_at: string;
  updated_at: string;
};

export type AnnotationPayload = {
  source: string;
  page: number;
  selected_text: string;
  note?: string;
  article_id?: string;
  title?: string;
};

export type ArxivPaper = {
  arxiv_id: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  published_at: string;
  updated_at: string;
  url: string;
  pdf_url: string;
};

export type ArxivSearchPayload = {
  description: string;
  max_results?: number;
  category?: string;
  sort_by?: "relevance" | "newest" | "last_updated";
};

export type ArxivSearchResponse = {
  query: string;
  papers: ArxivPaper[];
};

export type VisualAsset = {
  asset_id: string;
  source: string;
  article_id?: string | null;
  title?: string | null;
  page?: number | null;
  image_path: string;
  image_url: string;
  caption: string;
  asset_type: "pdf_image" | "uploaded_image" | string;
  created_at: string;
  updated_at: string;
};

export type ArticleDomain = {
  domain: string;
  category: string;
  article_count: number;
};

export type ChatResponse = {
  session_id: string;
  answer: string;
  sources: Source[];
  intent?: string;
  topology?: ClusterGraph | null;
};

export type ContextMode = "retrieval" | "whole_document";

export type ChatSession = {
  id: string;
  title: string;
  cluster_id?: number | null;
  document_source?: string | null;
  context_mode: ContextMode;
  created_at: string;
  updated_at: string;
};

export type StoredChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  created_at: string;
};

export type ChatSessionDetail = {
  session: ChatSession;
  messages: StoredChatMessage[];
};

export type ChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type Source = {
  id?: string | number;
  text?: string;
  source?: string;
  score?: number;
  rerank_score?: number;
  topic?: string;
  document_type?: string;
  section_type?: string;
  keywords?: string[];
  summary?: string;
  page?: number;
  selection?: boolean;
  [key: string]: unknown;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  timestamp: Date;
};

export type Cluster = {
  cluster_id: number;
  cluster_label: string;
  document_count: number;
};

export type ClusterDocument = {
  document_id?: string;
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
};

export type DocumentDetail = ClusterDocument & {
  preview_chunks?: Source[];
};

export type ChatResponse = {
  session_id: string;
  answer: string;
  sources: Source[];
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

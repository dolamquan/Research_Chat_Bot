/**
 * Pure helpers shared by App and the chat message components.
 *
 * Nothing here touches React, the network or the DOM, which is what makes it
 * testable on its own (`appHelpers.test.ts`).
 */
import type {
  Article,
  Cluster,
  ClusterDocument,
  IngestionJob,
  Message,
  Source,
} from "./types";

/** A `Source` field is whatever the backend sent; treat a non-string as absent. */
export function sourceTextValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A readable title from a stored filename: `2401.12345v2_deep_rag.pdf` -> `deep rag`. */
export function titleFromSource(source: string): string {
  return source
    .replace(/\.pdf$/i, "")
    .replace(/^\d{4}\.\d+(?:v\d+)?_/i, "")
    .replace(/[_-]+/g, " ");
}

export function articleTitle(article: Article): string {
  return article.title || titleFromSource(article.source);
}

export function initialMessage(cluster?: Cluster): Message {
  return {
    id: `welcome-${cluster?.cluster_id ?? "all"}`,
    role: "assistant",
    synthetic: true,
    content: cluster
      ? `You are now exploring **${cluster.cluster_label}**. I will retrieve answers only from this cluster. Select an article on the right to read it, or ask a question across the cluster.`
      : "Welcome to **Zoetrope**. Explore the paper topology to focus on a research cluster, or ask a question across all indexed papers. Every response is grounded in retrieved passages from your collection.",
    timestamp: new Date(),
  };
}

export function articleInitialMessage(article: Article): Message {
  const title = articleTitle(article);
  return {
    id: `welcome-article-${article.article_id}-${Date.now()}`,
    role: "assistant",
    synthetic: true,
    content: `You are now chatting with **${title}**. The PDF is open on the side, and questions will retrieve from this paper first.`,
    timestamp: new Date(),
  };
}

/** Identity for deduping and for React keys; two passages of one page differ by text. */
export function sourceKey(source: Source): string {
  const text = sourceTextValue(source?.text);
  return [
    source?.id,
    sourceTextValue(source?.source),
    typeof source?.page === "number" ? source.page : "",
    text.slice(0, 100),
  ].join(":");
}

export function scopeLabelFor(domain: string, category: string): string {
  if (domain && category) return `${domain} / ${category}`;
  if (domain) return domain;
  if (category) return category;
  return "all papers";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function jobStatusLabel(job: IngestionJob): string {
  if (job.status === "queued") return "Queued";
  if (job.status === "running") return job.stage === "downloading" ? "Downloading" : "Indexing";
  if (job.status === "indexed") return "Indexed";
  if (job.status === "failed") return "Failed";
  return job.status;
}

export function jobTitle(job: IngestionJob): string {
  return job.article_title || job.title || titleFromSource(job.url);
}

/** A library article shown on the topology map, which has no cluster of its own. */
export function documentFromArticle(article: Article): ClusterDocument {
  return {
    article_id: article.article_id,
    title: article.title,
    url: article.url,
    domain: article.domain,
    category: article.category,
    tags: article.tags,
    source: article.source,
    chunk_count: 0,
    cluster_id: -1,
    cluster_label: article.category || article.domain || "Library",
    x: 0,
    y: 0,
  };
}

export function contextLabel(source: Source, index: number): string {
  if (source.document_type === "visual_asset" || source.image_url) {
    return typeof source.page === "number" ? `Figure/image - p.${source.page}` : "Figure/image";
  }
  if (source.selection) {
    return typeof source.page === "number" ? `PDF selection - p.${source.page}` : "PDF selection";
  }
  return sourceTextValue(source.title) || sourceTextValue(source.source) || `Context ${index + 1}`;
}

export function sourceCitationLabel(source: Source, index: number): string {
  if (typeof source.page === "number") return `[p.${source.page}]`;
  return `[${index + 1}]`;
}

export function citationTitle(source: Source): string {
  return sourceTextValue(source.title) || sourceTextValue(source.source) || "Open source";
}

export function paperSourceKey(source: Source): string {
  return String(source?.article_id || source?.source || source?.id || "");
}

/** A whole indexed paper, as opposed to a PDF selection or an extracted figure. */
export function isPaperSource(source: Source): boolean {
  if (!source || typeof source !== "object") return false;
  return Boolean(
    typeof source.source === "string" &&
      source.source &&
      !source.selection &&
      source.document_type !== "visual_asset" &&
      !source.image_url,
  );
}

export function paperTitle(source: Source): string {
  const title = sourceTextValue(source.title);
  const file = sourceTextValue(source.source);
  return title || (file ? titleFromSource(file) : "Indexed paper");
}

export function paperSubtitle(source: Source): string {
  return [sourceTextValue(source.category), sourceTextValue(source.domain)]
    .filter(Boolean)
    .join(" - ");
}

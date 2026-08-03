import {
  BookOpen,
  ExternalLink,
  FileText,
  Link2,
  MessageSquarePlus,
} from "lucide-react";

import { getPdfUrl, getVisualImageUrl } from "../api";
import type {
  Cluster,
  ClusterDocument,
  ContextMode,
  DocumentDetail,
  Source,
} from "../types";

function titleFromSource(source: string): string {
  return source
    .replace(/\.pdf$/i, "")
    .replace(/^\d{4}\.\d+(?:v\d+)?_/i, "")
    .replace(/[_-]+/g, " ");
}

function scoreFor(source: Source): string | undefined {
  const score = source.rerank_score ?? source.score;
  return typeof score === "number" ? score.toFixed(3) : undefined;
}

function sourceTextValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sourceKeyPart(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

export function ResearchPanel({
  selectedCluster,
  documents,
  selectedDocument,
  detail,
  sources,
  pinnedSources,
  onSelectDocument,
  contextMode,
  onContextModeChange,
  onOpenDocument,
  onPinSource,
}: {
  selectedCluster?: Cluster;
  documents: ClusterDocument[];
  selectedDocument?: ClusterDocument;
  detail?: DocumentDetail;
  sources: Source[];
  pinnedSources: Source[];
  onSelectDocument: (document: ClusterDocument) => void;
  contextMode: ContextMode;
  onContextModeChange: (mode: ContextMode) => void;
  onOpenDocument: (document: ClusterDocument) => void;
  onPinSource: (source: Source) => void;
}) {
  return (
    <aside className="hidden xl:flex w-[360px] 2xl:w-[400px] shrink-0 border-l border-border bg-card flex-col min-h-0">
      <div className="h-12 px-4 border-b border-border flex items-center gap-2 shrink-0">
        <BookOpen size={14} className="text-primary" />
        <h2 className="text-sm font-semibold text-foreground">
          {selectedCluster ? "Cluster Articles" : "Retrieved Sources"}
        </h2>
      </div>

      {selectedCluster ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-4 py-3 border-b border-border shrink-0">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Active cluster
            </p>
            <p className="text-sm text-primary mt-1 leading-snug">
              {selectedCluster.cluster_label}
            </p>
          </div>

          <div className="max-h-[38%] overflow-y-auto p-3 space-y-1 border-b border-border">
            {documents.map((document) => {
              const active = selectedDocument?.source === document.source;

              return (
                <button
                  type="button"
                  key={document.source}
                  onClick={() => onSelectDocument(document)}
                  className={`w-full p-3 rounded border text-left transition-colors ${
                    active
                      ? "border-primary/35 bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-secondary"
                  }`}
                >
                  <p
                    className={`text-xs font-medium leading-snug line-clamp-2 ${
                      active ? "text-primary" : "text-foreground"
                    }`}
                  >
                    {titleFromSource(document.source)}
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground mt-1">
                    {document.chunk_count} chunks
                  </p>
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {selectedDocument ? (
              <>
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Article
                </p>
                <h3 className="text-sm font-semibold text-foreground mt-2 leading-snug">
                  {titleFromSource(selectedDocument.source)}
                </h3>
                <p className="font-mono text-[10px] text-muted-foreground mt-2 break-all">
                  {selectedDocument.source}
                </p>

                <div className="grid grid-cols-2 gap-2 mt-4">
                  <button
                    type="button"
                    onClick={() => onOpenDocument(selectedDocument)}
                    className="h-9 rounded bg-primary text-primary-foreground flex items-center justify-center gap-2 text-xs"
                  >
                    <FileText size={13} />
                    Read PDF
                  </button>
                  <a
                    href={getPdfUrl(selectedDocument.source)}
                    target="_blank"
                    rel="noreferrer"
                    className="h-9 rounded border border-border flex items-center justify-center gap-2 text-xs text-foreground hover:bg-secondary"
                  >
                    <ExternalLink size={13} />
                    New tab
                  </a>
                </div>

                <div className="mt-4 rounded border border-border bg-background p-3">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Chat context
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => onContextModeChange("retrieval")}
                      className={`h-9 rounded border text-xs ${
                        contextMode === "retrieval"
                          ? "border-primary/35 bg-primary/10 text-primary"
                          : "border-border text-foreground hover:bg-secondary"
                      }`}
                    >
                      Best passages
                    </button>
                    <button
                      type="button"
                      onClick={() => onContextModeChange("whole_document")}
                      className={`h-9 rounded border text-xs ${
                        contextMode === "whole_document"
                          ? "border-primary/35 bg-primary/10 text-primary"
                          : "border-border text-foreground hover:bg-secondary"
                      }`}
                    >
                      Entire paper
                    </button>
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                    {contextMode === "whole_document"
                      ? "Questions use the selected paper's chunks in reading order."
                      : "Questions use the most relevant chunks from this paper."}
                  </p>
                </div>

                {detail?.preview_chunks && detail.preview_chunks.length > 0 && (
                  <div className="mt-5 space-y-2">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Representative passages
                    </p>
                    {detail.preview_chunks.slice(0, 3).map((chunk, index) => (
                      <div
                        key={String(chunk.id ?? index)}
                        className="border border-border rounded bg-background p-3"
                      >
                        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">
                          {chunk.text || "No text available."}
                        </p>
                        <button
                          type="button"
                          onClick={() => onPinSource(chunk)}
                          className="mt-2 text-[10px] text-primary flex items-center gap-1.5"
                        >
                          <MessageSquarePlus size={11} />
                          Use passage in chat
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-center px-8">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Select an article to inspect its metadata and open the full PDF.
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {sources.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center px-8">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Sources retrieved for the conversation will appear here.
              </p>
            </div>
          ) : (
            sources.map((source, index) => {
              const pinned = pinnedSources.some(
                (item) =>
                  item.id === source.id &&
                  item.source === source.source &&
                  item.text === source.text,
              );
              const sourceName = sourceTextValue(source.source);
              const sourceTitle = sourceTextValue(source.title);
              const sourceSummary = sourceTextValue(source.summary);
              const sourceText = sourceTextValue(source.text);
              const sourcePreview = sourceText || sourceSummary || "No preview available.";

              return (
                <article
                  key={`${sourceKeyPart(source.id) || sourceName || index}-${index}`}
                  className="border border-border rounded bg-background p-3"
                >
                  <div className="flex items-center gap-2">
                    <Link2 size={12} className="text-primary" />
                    <p className="text-xs font-semibold text-foreground truncate">
                      Source {index + 1}
                    </p>
                    {scoreFor(source) && (
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        {scoreFor(source)}
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-[10px] text-primary/80 mt-2 truncate">
                    {sourceName || "Indexed document"}
                  </p>
                  {typeof source.image_url === "string" && source.image_url && (
                    <img
                      src={getVisualImageUrl(source.image_url)}
                      alt={sourceTitle || sourceName || "Retrieved visual"}
                      className="mt-2 w-full max-h-40 rounded border border-border object-contain bg-card"
                    />
                  )}
                  <p className="text-xs text-muted-foreground leading-relaxed mt-2 line-clamp-5">
                    {sourcePreview}
                  </p>
                  <button
                    type="button"
                    disabled={pinned}
                    onClick={() => onPinSource(source)}
                    className="mt-3 w-full h-8 border border-border rounded flex items-center justify-center gap-2 text-xs text-primary hover:bg-secondary disabled:text-muted-foreground disabled:opacity-60"
                  >
                    <MessageSquarePlus size={12} />
                    {pinned ? "Added to chat" : "Use in chat"}
                  </button>
                </article>
              );
            })
          )}
        </div>
      )}
    </aside>
  );
}

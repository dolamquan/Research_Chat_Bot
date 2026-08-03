import {
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileText,
  ImagePlus,
  MessageSquarePlus,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import { getPdfUrl, uploadImageAsset } from "../api";
import type { Article, IngestionJob } from "../types";

function titleFromSource(source: string): string {
  return source
    .replace(/\.pdf$/i, "")
    .replace(/^\d{4}\.\d+(?:v\d+)?_/i, "")
    .replace(/[_-]+/g, " ");
}

function articleTitle(article: Article): string {
  return article.title || titleFromSource(article.source);
}

function jobTitle(job: IngestionJob): string {
  return job.article_title || job.title || titleFromSource(job.url);
}

function jobStatusLabel(job: IngestionJob): string {
  if (job.status === "queued") return "Queued";
  if (job.status === "running") return job.stage === "downloading" ? "Downloading" : "Indexing";
  if (job.status === "indexed") return "Indexed";
  if (job.status === "failed") return "Failed";
  return job.status;
}

function dateLabel(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function PaperLibraryView({
  articles,
  ingestionJobs,
  domainOptions,
  categoryOptions,
  selectedDomain,
  selectedCategory,
  search,
  isBuildingTopology,
  onSearchChange,
  onDomainChange,
  onCategoryChange,
  onOpenArticle,
  onChatWithArticle,
  onRebuildTopology,
}: {
  articles: Article[];
  ingestionJobs: IngestionJob[];
  domainOptions: string[];
  categoryOptions: string[];
  selectedDomain: string;
  selectedCategory: string;
  search: string;
  isBuildingTopology: boolean;
  onSearchChange: (value: string) => void;
  onDomainChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onOpenArticle: (article: Article) => void;
  onChatWithArticle: (article: Article) => void;
  onRebuildTopology: () => void;
}) {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageTitle, setImageTitle] = useState("");
  const [imageStatus, setImageStatus] = useState("");
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showImageUpload, setShowImageUpload] = useState(false);
  const query = search.trim().toLowerCase();
  const filteredArticles = articles.filter((article) => {
    if (selectedDomain && article.domain !== selectedDomain) return false;
    if (selectedCategory && article.category !== selectedCategory) return false;
    if (!query) return true;

    const haystack = [
      article.title,
      article.source,
      article.domain,
      article.category,
      article.abstract,
      ...(article.tags || []),
      ...(article.authors || []),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });

  const activeJobs = ingestionJobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  );

  return (
    <section className="h-full min-h-0 flex flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-background px-5 md:px-10 py-7">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Paper library
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              Your research library
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Search indexed papers, open the PDF, or start a focused chat from one document.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowImageUpload((value) => !value)}
              className="h-9 px-3 rounded border border-border bg-background text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              Add image
            </button>
            <button
              type="button"
              onClick={onRebuildTopology}
              disabled={isBuildingTopology}
              className="h-9 px-3 rounded border border-border bg-background text-xs font-medium text-muted-foreground flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-secondary hover:text-foreground"
            >
              <RefreshCw
                size={13}
                className={isBuildingTopology ? "animate-spin" : ""}
              />
              {isBuildingTopology ? "Rebuilding" : "Rebuild topology"}
            </button>
          </div>
        </div>

        <div className="mx-auto mt-6 grid max-w-5xl gap-3 lg:grid-cols-[1fr_auto]">
          <label className="relative block">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search by title, author, tag, source..."
              className="w-full h-10 rounded border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
            />
          </label>
          <button
            type="button"
            onClick={() => setShowFilters((value) => !value)}
            className="h-10 rounded border border-border bg-background px-3 text-sm text-foreground hover:bg-secondary flex items-center gap-2"
          >
            Filters
            <ChevronDown
              size={14}
              className={`transition-transform ${showFilters ? "rotate-180" : ""}`}
            />
          </button>
        </div>

        {showFilters && (
          <div className="mx-auto mt-3 grid max-w-5xl gap-3 lg:grid-cols-[180px_180px]">
            <select
              value={selectedDomain}
              onChange={(event) => onDomainChange(event.target.value)}
              className="h-10 rounded border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary/60"
            >
              <option value="">All domains</option>
              {domainOptions.map((domain) => (
                <option key={domain} value={domain}>
                  {domain}
                </option>
              ))}
            </select>
            <select
              value={selectedCategory}
              onChange={(event) => onCategoryChange(event.target.value)}
              className="h-10 rounded border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary/60"
            >
              <option value="">All categories</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 md:px-10 py-8">
        {showImageUpload && (
          <form
          className="mx-auto mb-6 max-w-5xl rounded border border-border bg-card p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!imageFile || isUploadingImage) return;

            setIsUploadingImage(true);
            setImageStatus("Uploading and reading image...");

            try {
              const result = await uploadImageAsset({
                file: imageFile,
                title: imageTitle,
                domain: selectedDomain || "research",
                category: selectedCategory || "uncategorized",
              });
              setImageFile(null);
              setImageTitle("");
              setImageStatus(`Indexed image: ${result.asset.title || result.asset.source}`);
            } catch (error) {
              setImageStatus(
                error instanceof Error
                  ? `Could not upload image: ${error.message}`
                  : "Could not upload image.",
              );
            } finally {
              setIsUploadingImage(false);
            }
          }}
        >
          <div className="flex items-center gap-2">
            <ImagePlus size={14} className="text-primary" />
            <p className="text-sm font-semibold text-foreground">
              Add image or graph
            </p>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-[1fr_1fr_140px]">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => setImageFile(event.target.files?.[0] ?? null)}
              className="h-10 rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground file:mr-3 file:border-0 file:bg-primary/10 file:px-2 file:py-1 file:text-primary"
            />
            <input
              value={imageTitle}
              onChange={(event) => setImageTitle(event.target.value)}
              placeholder="Optional image title"
              className="h-10 rounded border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
            />
            <button
              type="submit"
              disabled={!imageFile || isUploadingImage}
              className="h-10 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40"
            >
              {isUploadingImage ? "Reading..." : "Upload image"}
            </button>
          </div>
          {imageStatus && (
            <p
              className={`mt-2 text-xs ${
                imageStatus.startsWith("Could not")
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {imageStatus}
            </p>
          )}
          </form>
        )}

        {activeJobs.length > 0 && (
          <details className="mx-auto mb-6 max-w-5xl rounded border border-border bg-card">
            <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-foreground">
              Active ingestion jobs
            </summary>
            <div className="divide-y divide-border">
              {activeJobs.map((job) => (
                <div key={job.job_id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {jobTitle(job)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {job.message}
                      </p>
                    </div>
                    <span className="shrink-0 rounded border border-primary/25 bg-primary/10 px-2 py-1 font-mono text-[10px] text-primary">
                      {jobStatusLabel(job)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="mx-auto grid max-w-6xl gap-4 xl:grid-cols-2">
          {filteredArticles.length === 0 ? (
            <div className="rounded border border-border bg-card px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">
                No papers match the current library filters.
              </p>
            </div>
          ) : (
            <>
              {filteredArticles.map((article) => {
                const failed = article.status === "failed";

                return (
                  <article
                    key={article.article_id}
                    className="flex min-h-[210px] flex-col rounded border border-border bg-card px-5 py-5 transition-colors hover:border-border/80 hover:bg-secondary/40"
                  >
                    <div className="flex flex-1 flex-col">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-3">
                          {failed ? (
                            <XCircle size={15} className="mt-1 shrink-0 text-destructive" />
                          ) : (
                            <CheckCircle2 size={15} className="mt-1 shrink-0 text-muted-foreground" />
                          )}
                          <div className="min-w-0">
                            <h3 className="line-clamp-2 text-base font-semibold leading-snug text-foreground">
                              {articleTitle(article)}
                            </h3>
                            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                              {(article.domain || "research")} / {(article.category || "uncategorized")}
                            </p>
                          </div>
                        </div>
                      {article.abstract && (
                        <p className="mt-4 text-sm leading-6 text-muted-foreground line-clamp-2">
                          {article.abstract}
                        </p>
                      )}
                      <div className="mt-4 flex flex-wrap gap-2">
                        {dateLabel(article.updated_at) && (
                          <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                            {dateLabel(article.updated_at)}
                          </span>
                        )}
                        {(article.tags || []).slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="mt-5 flex shrink-0 items-center justify-start gap-2 border-t border-border/70 pt-4">
                      <button
                        type="button"
                        disabled={failed}
                        onClick={() => onChatWithArticle(article)}
                        className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 inline-flex items-center gap-2"
                        title="Chat with paper"
                      >
                        <MessageSquarePlus size={13} />
                        Chat
                      </button>
                      <button
                        type="button"
                        disabled={failed}
                        onClick={() => onOpenArticle(article)}
                        className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 inline-flex items-center gap-2"
                        title="Read PDF"
                      >
                        <FileText size={13} />
                        Read PDF
                      </button>
                      <a
                        href={getPdfUrl(article.source)}
                        target="_blank"
                        rel="noreferrer"
                        className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex items-center gap-2"
                        title="Open PDF in new tab"
                      >
                        <ExternalLink size={13} />
                        Open
                      </a>
                    </div>
                    </div>
                  </article>
                );
              })}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

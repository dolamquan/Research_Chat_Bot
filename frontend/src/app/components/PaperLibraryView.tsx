import {
  CheckCircle2,
  ExternalLink,
  FileText,
  MessageSquarePlus,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";

import { getPdfUrl } from "../api";
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
    <section className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-border bg-card px-5 md:px-8 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Paper library
            </p>
            <h2
              className="mt-1 text-2xl font-semibold tracking-tight text-foreground"
              style={{ fontFamily: "'Epilogue', sans-serif" }}
            >
              Indexed research papers
            </h2>
          </div>

          <button
            type="button"
            onClick={onRebuildTopology}
            disabled={isBuildingTopology}
            className="h-9 px-3 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <RefreshCw
              size={13}
              className={isBuildingTopology ? "animate-spin" : ""}
            />
            {isBuildingTopology ? "Rebuilding" : "Rebuild topology"}
          </button>
        </div>

        <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_180px_180px]">
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
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 md:px-8 py-5">
        {activeJobs.length > 0 && (
          <div className="mb-5 rounded border border-primary/25 bg-primary/5">
            <div className="px-4 py-3 border-b border-primary/15 flex items-center gap-2">
              <RefreshCw size={13} className="text-primary animate-spin" />
              <p className="text-xs font-medium text-primary">
                Active ingestion jobs
              </p>
            </div>
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
          </div>
        )}

        <div className="rounded border border-border bg-card">
          <div className="grid grid-cols-[1fr_120px_120px_150px] gap-3 border-b border-border px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <span>Paper</span>
            <span>Domain</span>
            <span>Category</span>
            <span className="text-right">Actions</span>
          </div>

          {filteredArticles.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">
                No papers match the current library filters.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredArticles.map((article) => {
                const failed = article.status === "failed";

                return (
                  <article
                    key={article.article_id}
                    className="grid grid-cols-1 gap-3 px-4 py-4 lg:grid-cols-[1fr_120px_120px_150px] lg:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {failed ? (
                          <XCircle size={13} className="shrink-0 text-destructive" />
                        ) : (
                          <CheckCircle2 size={13} className="shrink-0 text-green-500" />
                        )}
                        <h3 className="text-sm font-semibold text-foreground truncate">
                          {articleTitle(article)}
                        </h3>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground truncate">
                        {article.source}
                      </p>
                      {article.abstract && (
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                          {article.abstract}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(article.tags || []).slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                        {dateLabel(article.updated_at) && (
                          <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {dateLabel(article.updated_at)}
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="text-xs text-muted-foreground truncate">
                      {article.domain || "research"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {article.category || "uncategorized"}
                    </p>

                    <div className="flex items-center justify-start gap-2 lg:justify-end">
                      <button
                        type="button"
                        disabled={failed}
                        onClick={() => onChatWithArticle(article)}
                        className="h-8 w-8 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-secondary disabled:opacity-40"
                        title="Chat with paper"
                      >
                        <MessageSquarePlus size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={failed}
                        onClick={() => onOpenArticle(article)}
                        className="h-8 w-8 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-secondary disabled:opacity-40"
                        title="Read PDF"
                      >
                        <FileText size={13} />
                      </button>
                      <a
                        href={getPdfUrl(article.source)}
                        target="_blank"
                        rel="noreferrer"
                        className="h-8 w-8 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-secondary"
                        title="Open PDF in new tab"
                      >
                        <ExternalLink size={13} />
                      </a>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

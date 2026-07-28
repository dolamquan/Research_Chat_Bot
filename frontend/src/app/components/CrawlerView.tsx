import {
  ExternalLink,
  FilePlus2,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";

import type { ArxivPaper, IngestionJob } from "../types";

function dateLabel(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function isPaperQueued(paper: ArxivPaper, ingestionJobs: IngestionJob[]): boolean {
  return ingestionJobs.some(
    (job) =>
      job.url === paper.url ||
      job.url === paper.pdf_url ||
      job.pdf_url === paper.pdf_url ||
      job.article_title === paper.title,
  );
}

export function CrawlerView({
  description,
  category,
  sortBy,
  maxResults,
  results,
  query,
  status,
  isSearching,
  addingPaperId,
  ingestionJobs,
  onDescriptionChange,
  onCategoryChange,
  onSortByChange,
  onMaxResultsChange,
  onSearch,
  onAddPaper,
}: {
  description: string;
  category: string;
  sortBy: "relevance" | "newest" | "last_updated";
  maxResults: number;
  results: ArxivPaper[];
  query: string;
  status: string;
  isSearching: boolean;
  addingPaperId?: string;
  ingestionJobs: IngestionJob[];
  onDescriptionChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onSortByChange: (value: "relevance" | "newest" | "last_updated") => void;
  onMaxResultsChange: (value: number) => void;
  onSearch: () => void;
  onAddPaper: (paper: ArxivPaper) => void;
}) {
  return (
    <section className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-border bg-card px-5 md:px-8 py-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
            <Sparkles size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              arXiv crawler
            </p>
            <h2
              className="mt-1 text-2xl font-semibold tracking-tight text-foreground"
              style={{ fontFamily: "'Epilogue', sans-serif" }}
            >
              Discover papers by topic
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Describe the research area and add promising arXiv papers directly to your library.
            </p>
          </div>
        </div>

        <form
          className="mt-5 rounded border border-border bg-background p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch();
          }}
        >
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Research topic
            </span>
            <textarea
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              rows={3}
              placeholder="Example: recent papers about graph RAG, query decomposition, and multi-hop retrieval"
              className="mt-2 block w-full resize-none rounded border border-border bg-card px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
            />
          </label>

          <div className="mt-3 grid gap-2 md:grid-cols-[1fr_150px_150px_140px]">
            <label className="block">
              <span className="sr-only">Optional arXiv category</span>
              <input
                value={category}
                onChange={(event) => onCategoryChange(event.target.value)}
                placeholder="Optional category, e.g. cs.CL"
                className="h-9 w-full rounded border border-border bg-card px-3 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
              />
            </label>
            <select
              value={sortBy}
              onChange={(event) =>
                onSortByChange(event.target.value as "relevance" | "newest" | "last_updated")
              }
              className="h-9 rounded border border-border bg-card px-3 text-xs text-foreground outline-none focus:border-primary/60"
            >
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="last_updated">Recently updated</option>
            </select>
            <select
              value={maxResults}
              onChange={(event) => onMaxResultsChange(Number(event.target.value))}
              className="h-9 rounded border border-border bg-card px-3 text-xs text-foreground outline-none focus:border-primary/60"
            >
              {[5, 10, 15, 20, 25].map((value) => (
                <option key={value} value={value}>
                  {value} results
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!description.trim() || isSearching}
              className="h-9 rounded bg-primary text-primary-foreground text-xs font-medium flex items-center justify-center gap-2 disabled:opacity-40"
            >
              {isSearching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              Search arXiv
            </button>
          </div>
        </form>

        {(status || query) && (
          <div className="mt-3 flex flex-col gap-1">
            {status && (
              <p
                className={`text-xs ${
                  status.startsWith("Could not") ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {status}
              </p>
            )}
            {query && (
              <p className="font-mono text-[10px] text-muted-foreground truncate">
                arXiv query: {query}
              </p>
            )}
          </div>
        )}

      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 md:px-8 py-5">
        {results.length === 0 ? (
          <div className="h-full min-h-80 rounded border border-border bg-card flex items-center justify-center text-center px-8">
            <p className="max-w-md text-sm text-muted-foreground">
              Search results will appear here. Start broad, then narrow with a category such as cs.CL, cs.AI, or cs.IR.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {results.map((paper) => {
              const queued = isPaperQueued(paper, ingestionJobs);
              const adding = addingPaperId === paper.arxiv_id;

              return (
                <article
                  key={paper.arxiv_id}
                  className="rounded border border-border bg-card p-4"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded border border-primary/25 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
                          {paper.arxiv_id}
                        </span>
                        {dateLabel(paper.published_at) && (
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {dateLabel(paper.published_at)}
                          </span>
                        )}
                      </div>
                      <h3 className="mt-2 text-base font-semibold text-foreground leading-snug">
                        {paper.title}
                      </h3>
                      {paper.authors.length > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-1">
                          {paper.authors.slice(0, 6).join(", ")}
                          {paper.authors.length > 6 ? " et al." : ""}
                        </p>
                      )}
                      <p className="mt-3 text-sm leading-relaxed text-muted-foreground line-clamp-4">
                        {paper.abstract}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {paper.categories.slice(0, 6).map((item) => (
                          <span
                            key={item}
                            className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="shrink-0 flex lg:flex-col gap-2">
                      <button
                        type="button"
                        disabled={queued || adding}
                        onClick={() => onAddPaper(paper)}
                        className="h-9 px-3 rounded bg-primary text-primary-foreground text-xs font-medium flex items-center justify-center gap-2 disabled:opacity-45"
                      >
                        {adding ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <FilePlus2 size={13} />
                        )}
                        {queued ? "Queued" : adding ? "Adding" : "Add to library"}
                      </button>
                      <a
                        href={paper.url}
                        target="_blank"
                        rel="noreferrer"
                        className="h-9 px-3 rounded border border-border text-xs text-foreground flex items-center justify-center gap-2 hover:bg-secondary"
                      >
                        <ExternalLink size={13} />
                        arXiv
                      </a>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

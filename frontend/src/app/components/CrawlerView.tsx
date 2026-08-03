import { ExternalLink, FilePlus2, Loader2, Search } from "lucide-react";

import type { ArxivPaper, IngestionJob } from "../types";

const SOURCE_OPTIONS = [
  { id: "arxiv", label: "arXiv" },
  { id: "pubmed", label: "PubMed" },
  { id: "biorxiv", label: "bioRxiv" },
  { id: "medrxiv", label: "medRxiv" },
  { id: "semantic_scholar", label: "Semantic Scholar" },
  { id: "crossref", label: "Crossref" },
  { id: "openalex", label: "OpenAlex" },
];

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

function paperKey(paper: ArxivPaper): string {
  return paper.arxiv_id || paper.paper_id || paper.pdf_url || paper.url || paper.title;
}

export function CrawlerView({
  description,
  category,
  sortBy,
  maxResults,
  sources,
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
  onSourcesChange,
  onSearch,
  onAddPaper,
}: {
  description: string;
  category: string;
  sortBy: "relevance" | "newest" | "last_updated";
  maxResults: number;
  sources: string[];
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
  onSourcesChange: (value: string[]) => void;
  onSearch: () => void;
  onAddPaper: (paper: ArxivPaper) => void;
}) {
  return (
    <section className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-5 py-8 md:px-8">
        <header className="shrink-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            paper crawler
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            Discover papers by topic
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Search academic sources, review promising papers, and queue the useful ones for your library.
          </p>
        </header>

        <form
          className="mt-7 rounded border border-border bg-card/40 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch();
          }}
        >
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Research topic
            </span>
            <textarea
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              rows={2}
              placeholder="Example: recent papers about graph RAG, query decomposition, and multi-hop retrieval"
              className="mt-2 block w-full resize-none rounded border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/50"
            />
          </label>

          <div className="mt-4 flex flex-wrap gap-2">
            {SOURCE_OPTIONS.map((source) => {
              const selected = sources.includes(source.id);
              return (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => {
                    if (selected && sources.length === 1) return;
                    onSourcesChange(
                      selected
                        ? sources.filter((item) => item !== source.id)
                        : [...sources, source.id],
                    );
                  }}
                  className={`rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide ${
                    selected
                      ? "border-foreground/35 bg-secondary text-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {source.label}
                </button>
              );
            })}
          </div>

          <div className="mt-4 grid gap-2 md:grid-cols-[1fr_150px_140px_auto]">
            <label className="block">
              <span className="sr-only">Optional arXiv category</span>
              <input
                value={category}
                onChange={(event) => onCategoryChange(event.target.value)}
                placeholder="Optional category/filter, e.g. cs.CL"
                className="h-10 w-full rounded border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/50"
              />
            </label>
            <select
              value={sortBy}
              onChange={(event) =>
                onSortByChange(event.target.value as "relevance" | "newest" | "last_updated")
              }
              className="h-10 rounded border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-foreground/50"
            >
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="last_updated">Recently updated</option>
            </select>
            <select
              value={maxResults}
              onChange={(event) => onMaxResultsChange(Number(event.target.value))}
              className="h-10 rounded border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-foreground/50"
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
              className="h-10 rounded bg-foreground px-4 text-sm font-medium text-background flex items-center justify-center gap-2 disabled:opacity-40"
            >
              {isSearching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              Search papers
            </button>
          </div>
        </form>

        {(status || query) && (
          <div className="mt-4 flex flex-col gap-1 border-l border-border pl-3">
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
                Query: {query}
              </p>
            )}
          </div>
        )}

        <div className="mt-8 flex-1">
          {results.length === 0 ? (
          <div className="flex min-h-72 items-center justify-center border-t border-border text-center">
            <div>
              <Search className="mx-auto mb-4 text-muted-foreground" size={24} />
              <p className="text-sm font-medium text-foreground">No search results yet</p>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Start with a broad topic, then narrow it with a category such as cs.CL, cs.AI, or cs.IR.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {results.map((paper) => {
              const queued = isPaperQueued(paper, ingestionJobs);
              const adding = addingPaperId === paperKey(paper);

              return (
                <article
                  key={`${paper.source_provider || "paper"}-${paperKey(paper)}`}
                  className="group rounded border border-border bg-card/40 p-4 transition-colors hover:border-foreground/25 hover:bg-card"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {paper.source_provider || "paper"}
                        </span>
                        {paper.arxiv_id && (
                          <span className="rounded border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {paper.arxiv_id}
                          </span>
                        )}
                        {dateLabel(paper.published_at) && (
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {dateLabel(paper.published_at)}
                          </span>
                        )}
                      </div>
                      <h3 className="mt-2 max-w-4xl text-base font-semibold leading-snug text-foreground">
                        {paper.title}
                      </h3>
                      {paper.authors.length > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-1">
                          {paper.authors.slice(0, 6).join(", ")}
                          {paper.authors.length > 6 ? " et al." : ""}
                        </p>
                      )}
                      <p className="mt-3 max-w-5xl text-sm leading-6 text-muted-foreground line-clamp-3">
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

                    <div className="shrink-0 flex gap-2 lg:flex-col">
                      <button
                        type="button"
                        disabled={queued || adding || (!paper.pdf_url && !paper.url)}
                        onClick={() => onAddPaper(paper)}
                        className="h-9 min-w-32 px-3 rounded bg-foreground text-background text-xs font-medium flex items-center justify-center gap-2 disabled:opacity-45"
                      >
                        {adding ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <FilePlus2 size={13} />
                        )}
                        {queued ? "Queued" : adding ? "Adding" : paper.pdf_url || paper.url ? "Add to library" : "No PDF URL"}
                      </button>
                      <a
                        href={paper.url}
                        target="_blank"
                        rel="noreferrer"
                        className="h-9 min-w-32 px-3 rounded border border-border text-xs text-foreground flex items-center justify-center gap-2 hover:bg-secondary"
                      >
                        <ExternalLink size={13} />
                        Open
                      </a>
                    </div>
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

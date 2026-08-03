import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  FileText,
  Loader2,
  MessageSquarePlus,
  NotebookPen,
  Search,
  Trash2,
} from "lucide-react";

import { deleteAnnotation, getAnnotations } from "../api";
import type { Annotation, Source } from "../types";

function titleFromAnnotation(annotation: Annotation): string {
  return (
    annotation.title ||
    annotation.source
      .replace(/\.pdf$/i, "")
      .replace(/^\d{4}\.\d+(?:v\d+)?_/i, "")
      .replace(/[_-]+/g, " ")
  );
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

export function NotesView({
  onOpenNote,
  onPinNote,
}: {
  onOpenNote: (annotation: Annotation) => void;
  onPinNote: (source: Source) => void;
}) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [noteFilter, setNoteFilter] = useState<"all" | "with-note" | "highlight-only">("all");

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setStatus("");

    getAnnotations(undefined, 500)
      .then((result) => {
        if (active) setAnnotations(result.annotations);
      })
      .catch((error) => {
        if (active) {
          setStatus(
            error instanceof Error
              ? `Could not load notes: ${error.message}`
              : "Could not load notes.",
          );
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const filteredAnnotations = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filteredByKind = annotations.filter((annotation) => {
      if (noteFilter === "with-note") return annotation.note.trim().length > 0;
      if (noteFilter === "highlight-only") return annotation.note.trim().length === 0;
      return true;
    });

    if (!needle) return filteredByKind;

    return filteredByKind.filter((annotation) =>
      [
        annotation.source,
        annotation.title || "",
        annotation.selected_text,
        annotation.note,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [annotations, noteFilter, query]);

  async function removeAnnotation(annotationId: string) {
    setAnnotations((current) =>
      current.filter((annotation) => annotation.annotation_id !== annotationId),
    );

    try {
      await deleteAnnotation(annotationId);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not delete note: ${error.message}`
          : "Could not delete note.",
      );
      const result = await getAnnotations(undefined, 500);
      setAnnotations(result.annotations);
    }
  }

  function pinAnnotation(annotation: Annotation) {
    onPinNote({
      id: `annotation:${annotation.annotation_id}`,
      source: annotation.source,
      page: annotation.page,
      text: annotation.note
        ? `${annotation.selected_text}\n\nNote: ${annotation.note}`
        : annotation.selected_text,
      selection: true,
      annotation_id: annotation.annotation_id,
      title: annotation.title || titleFromAnnotation(annotation),
      article_id: annotation.article_id || undefined,
    });
  }

  return (
    <section className="h-full min-h-0 flex flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-background px-5 md:px-10 py-7">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Research notes
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              Your saved notes
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Review highlighted passages, reopen the PDF, or send a saved note back into chat.
            </p>
          </div>
        </div>

        <div className="mx-auto mt-6 grid max-w-5xl gap-3 lg:grid-cols-[1fr_auto]">
          <label className="relative block">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by note, selected text, paper title..."
              className="w-full h-10 rounded border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-muted-foreground"
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
          <div className="mx-auto mt-3 grid max-w-5xl gap-3 lg:grid-cols-[190px_auto]">
            <select
              value={noteFilter}
              onChange={(event) =>
                setNoteFilter(event.target.value as "all" | "with-note" | "highlight-only")
              }
              className="h-10 rounded border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-muted-foreground"
            >
              <option value="all">All notes</option>
              <option value="with-note">With description</option>
              <option value="highlight-only">Highlights only</option>
            </select>
            <p className="self-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {filteredAnnotations.length} shown
            </p>
          </div>
        )}

        {status && (
          <p className="mx-auto mt-3 max-w-5xl text-xs text-destructive">
            {status}
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 md:px-10 py-8">
        {isLoading ? (
          <div className="mx-auto h-full min-h-80 max-w-5xl rounded border border-border bg-card flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" />
            Loading notes...
          </div>
        ) : filteredAnnotations.length === 0 ? (
          <div className="mx-auto h-full min-h-80 max-w-5xl rounded border border-border bg-card flex items-center justify-center text-center px-8">
            <p className="max-w-md text-sm text-muted-foreground">
              No saved notes found. Highlight text inside a PDF and save a note to build your research notebook.
            </p>
          </div>
        ) : (
          <div className="mx-auto grid max-w-6xl gap-4 xl:grid-cols-2">
            {filteredAnnotations.map((annotation) => (
              <article
                key={annotation.annotation_id}
                className="flex min-h-[250px] min-w-0 flex-col overflow-hidden rounded border border-border bg-card px-5 py-5 transition-colors hover:border-border/80 hover:bg-secondary/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-3">
                    <NotebookPen
                      size={15}
                      className="mt-1 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0">
                      <h3 className="line-clamp-2 break-words text-base font-semibold leading-snug text-foreground">
                      {titleFromAnnotation(annotation)}
                      </h3>
                      <p className="mt-2 max-w-full font-mono text-[11px] text-muted-foreground break-all">
                        p.{annotation.page} / {annotation.source}
                      </p>
                    </div>
                  </div>

                  <p className="mt-4 overflow-hidden border-l border-border pl-4 text-sm leading-6 text-muted-foreground line-clamp-3 break-words">
                    {annotation.selected_text}
                  </p>
                  {annotation.note && (
                    <p className="mt-4 overflow-hidden rounded border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground line-clamp-3 break-words">
                      {annotation.note}
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {dateLabel(annotation.updated_at) && (
                      <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                        {dateLabel(annotation.updated_at)}
                      </span>
                    )}
                    {annotation.note ? (
                      <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                        note
                      </span>
                    ) : (
                      <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                        highlight
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-5 flex shrink-0 items-center justify-start gap-2 border-t border-border/70 pt-4">
                  <button
                    type="button"
                    onClick={() => onOpenNote(annotation)}
                    className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex items-center gap-2"
                  >
                    <FileText size={13} />
                    Open PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => pinAnnotation(annotation)}
                    className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex items-center gap-2"
                  >
                    <MessageSquarePlus size={13} />
                    Use in chat
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeAnnotation(annotation.annotation_id)}
                    className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-destructive sm:ml-auto inline-flex items-center gap-2"
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

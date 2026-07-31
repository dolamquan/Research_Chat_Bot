import { useEffect, useMemo, useState } from "react";
import {
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
    if (!needle) return annotations;

    return annotations.filter((annotation) =>
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
  }, [annotations, query]);

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
    <section className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-border bg-card px-5 md:px-8 py-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
            <NotebookPen size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              research notes
            </p>
            <h2
              className="mt-1 text-2xl font-semibold tracking-tight text-foreground"
              style={{ fontFamily: "'Epilogue', sans-serif" }}
            >
              Saved highlights
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Search notes and highlighted passages across your indexed papers.
            </p>
          </div>
        </div>

        <div className="mt-5 relative max-w-2xl">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes, selected text, paper titles..."
            className="h-10 w-full rounded border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
          />
        </div>

        {status && (
          <p className="mt-3 text-xs text-destructive">
            {status}
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 md:px-8 py-5">
        {isLoading ? (
          <div className="h-full min-h-80 rounded border border-border bg-card flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" />
            Loading notes...
          </div>
        ) : filteredAnnotations.length === 0 ? (
          <div className="h-full min-h-80 rounded border border-border bg-card flex items-center justify-center text-center px-8">
            <p className="max-w-md text-sm text-muted-foreground">
              No saved notes found. Highlight text inside a PDF and save a note to build your research notebook.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {filteredAnnotations.map((annotation) => (
              <article
                key={annotation.annotation_id}
                className="min-w-0 overflow-hidden rounded border border-border bg-card p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 shrink-0 rounded border border-border bg-background flex items-center justify-center text-primary">
                    <NotebookPen size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground line-clamp-2 break-words">
                      {titleFromAnnotation(annotation)}
                    </p>
                    <p className="mt-1 max-w-full font-mono text-[10px] text-primary break-all">
                      p.{annotation.page} - {annotation.source}
                    </p>
                  </div>
                </div>

                <p className="mt-3 overflow-hidden text-sm leading-relaxed text-muted-foreground line-clamp-4 break-words">
                  {annotation.selected_text}
                </p>
                {annotation.note && (
                  <p className="mt-3 overflow-hidden rounded border border-primary/20 bg-primary/10 px-3 py-2 text-sm leading-relaxed text-foreground line-clamp-4 break-words">
                    {annotation.note}
                  </p>
                )}

                <div className="mt-4 flex min-w-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenNote(annotation)}
                    className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs flex items-center gap-2"
                  >
                    <FileText size={12} />
                    Open PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => pinAnnotation(annotation)}
                    className="h-8 px-3 rounded border border-border text-primary text-xs flex items-center gap-2 hover:bg-secondary"
                  >
                    <MessageSquarePlus size={12} />
                    Use in chat
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeAnnotation(annotation.annotation_id)}
                    className="h-8 px-3 rounded border border-border text-muted-foreground text-xs flex items-center gap-2 hover:text-destructive hover:bg-secondary sm:ml-auto"
                  >
                    <Trash2 size={12} />
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

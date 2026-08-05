import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  Loader2,
  MessageSquarePlus,
  NotebookPen,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { deleteAnnotation, getAnnotations } from "../api";
import type { Annotation, Source } from "../types";
import {
  createNoteFolder,
  DEFAULT_FOLDER_ID,
  deleteWorkspaceNote,
  loadNoteFolders,
  loadSavedWorkspaceNotes,
  saveWorkspaceNote,
  type SavedNoteFolder,
  type SavedWorkspaceNote,
} from "../workspaceNoteStore";

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
  const [savedNotes, setSavedNotes] = useState<SavedWorkspaceNote[]>([]);
  const [folders, setFolders] = useState<SavedNoteFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState(DEFAULT_FOLDER_ID);
  const [activeExplorerNode, setActiveExplorerNode] = useState<"workspace" | "pdf">("workspace");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [noteFilter, setNoteFilter] = useState<"all" | "with-note" | "highlight-only">("all");
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState("");

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setStatus("");
    setFolders(loadNoteFolders());
    setSavedNotes(loadSavedWorkspaceNotes());

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

  const filteredSavedNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return savedNotes.filter((note) => {
      const folderMatch =
        activeFolderId === DEFAULT_FOLDER_ID || note.folderId === activeFolderId;
      if (!folderMatch) return false;
      if (!needle) return true;
      return [
        note.title,
        note.body,
        note.scopeTitle,
        ...note.attachments.map((attachment) => attachment.name),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [activeFolderId, query, savedNotes]);

  const savedNoteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    counts.set(DEFAULT_FOLDER_ID, savedNotes.length);
    savedNotes.forEach((note) => {
      counts.set(note.folderId, (counts.get(note.folderId) || 0) + 1);
    });
    return counts;
  }, [savedNotes]);

  const activeFolder = useMemo(
    () => folders.find((folder) => folder.id === activeFolderId) || folders[0],
    [activeFolderId, folders],
  );

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

  function openFolderDialog() {
    setFolderName("");
    setFolderError("");
    setFolderDialogOpen(true);
  }

  function createFolder() {
    const name = folderName.trim();
    if (!name) {
      setFolderError("Folder name is required.");
      return;
    }

    try {
      const folder = createNoteFolder(name);
      setFolders(loadNoteFolders());
      setActiveFolderId(folder.id);
      setFolderName("");
      setFolderDialogOpen(false);
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Could not create folder.");
    }
  }

  function moveSavedNote(note: SavedWorkspaceNote, folderId: string) {
    const saved = saveWorkspaceNote({
      ...note,
      folderId,
    });
    setSavedNotes((current) =>
      [saved, ...current.filter((item) => item.id !== saved.id)].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    );
  }

  function removeSavedNote(noteId: string) {
    deleteWorkspaceNote(noteId);
    setSavedNotes(loadSavedWorkspaceNotes());
  }

  function pinSavedNote(note: SavedWorkspaceNote) {
    onPinNote({
      id: `saved-workspace-note:${note.id}`,
      source: note.scopeId,
      text: note.body,
      selection: true,
      title: note.title,
      document_type: "workspace_note",
      attachments: note.attachments,
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
        <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-h-[520px] rounded border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-3 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <FolderOpen size={15} className="shrink-0 text-primary" />
                <h3 className="truncate text-sm font-semibold text-foreground">
                  Notes explorer
                </h3>
              </div>
              <button
                type="button"
                title="Create folder"
                onClick={openFolderDialog}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <FolderPlus size={14} />
              </button>
            </div>

            <div className="p-2">
              <button
                type="button"
                onClick={() => {
                  setActiveExplorerNode("workspace");
                  setActiveFolderId(DEFAULT_FOLDER_ID);
                }}
                className={`flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm ${
                  activeExplorerNode === "workspace" && activeFolderId === DEFAULT_FOLDER_ID
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                <FolderOpen size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">All workspace notes</span>
                <span className="font-mono text-[10px]">
                  {savedNoteCounts.get(DEFAULT_FOLDER_ID) || 0}
                </span>
              </button>

              <div className="mt-1 space-y-1 border-l border-border/80 pl-3">
                {folders
                  .filter((folder) => folder.id !== DEFAULT_FOLDER_ID)
                  .map((folder) => {
                    const active =
                      activeExplorerNode === "workspace" && activeFolderId === folder.id;
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => {
                          setActiveExplorerNode("workspace");
                          setActiveFolderId(folder.id);
                        }}
                        className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm ${
                          active
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                        }`}
                      >
                        <Folder size={14} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                        <span className="font-mono text-[10px]">
                          {savedNoteCounts.get(folder.id) || 0}
                        </span>
                      </button>
                    );
                  })}
              </div>

              <button
                type="button"
                onClick={() => setActiveExplorerNode("pdf")}
                className={`mt-3 flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm ${
                  activeExplorerNode === "pdf"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                <FileText size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">PDF highlights</span>
                <span className="font-mono text-[10px]">
                  {filteredAnnotations.length}
                </span>
              </button>

              <button
                type="button"
                onClick={openFolderDialog}
                className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded border border-border text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <FolderPlus size={13} />
                New folder
              </button>
            </div>
          </aside>

          <div className="min-w-0 space-y-8">
            {activeExplorerNode === "workspace" && (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <NotebookPen size={14} className="text-primary" />
                  <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
                    {activeFolder?.name || "Workspace notes"}
                  </h3>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {filteredSavedNotes.length}
                  </span>
                </div>

                {filteredSavedNotes.length === 0 ? (
                  <div className="rounded border border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">
                    Save a workspace note from the left notes pane to add it here.
                  </div>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-2">
                    {filteredSavedNotes.map((note) => (
                      <article
                        key={note.id}
                        className="flex min-h-[240px] min-w-0 flex-col overflow-hidden rounded border border-border bg-card px-5 py-5 transition-colors hover:border-border/80 hover:bg-secondary/40"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-3">
                            <NotebookPen
                              size={15}
                              className="mt-1 shrink-0 text-muted-foreground"
                            />
                            <div className="min-w-0 flex-1">
                              <h3 className="line-clamp-2 break-words text-base font-semibold leading-snug text-foreground">
                                {note.title}
                              </h3>
                              <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                                {note.scopeTitle}
                              </p>
                            </div>
                          </div>

                          {note.body ? (
                            <p className="mt-4 overflow-hidden rounded border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground line-clamp-5 break-words">
                              {note.body}
                            </p>
                          ) : (
                            <p className="mt-4 text-sm text-muted-foreground">
                              Image-only note
                            </p>
                          )}

                          {note.attachments.length > 0 && (
                            <div className="mt-4 grid grid-cols-3 gap-2">
                              {note.attachments.slice(0, 3).map((attachment) => (
                                <img
                                  key={attachment.id}
                                  src={attachment.dataUrl}
                                  alt={attachment.name}
                                  className="h-20 w-full rounded border border-border bg-white object-contain"
                                />
                              ))}
                            </div>
                          )}
                          <div className="mt-4 flex flex-wrap gap-2">
                            <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                              {dateLabel(note.updatedAt)}
                            </span>
                            {note.attachments.length > 0 && (
                              <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground inline-flex items-center gap-1">
                                <Image size={11} />
                                {note.attachments.length}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="mt-5 flex shrink-0 flex-wrap items-center gap-2 border-t border-border/70 pt-4">
                          <button
                            type="button"
                            onClick={() => pinSavedNote(note)}
                            className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex items-center gap-2"
                          >
                            <MessageSquarePlus size={13} />
                            Use in chat
                          </button>
                          <select
                            value={note.folderId}
                            onChange={(event) => moveSavedNote(note, event.target.value)}
                            className="h-9 min-w-32 rounded border border-border bg-background px-2 text-xs text-muted-foreground outline-none hover:bg-secondary hover:text-foreground"
                          >
                            {folders.map((folder) => (
                              <option key={folder.id} value={folder.id}>
                                {folder.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => removeSavedNote(note.id)}
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
              </section>
            )}

            {activeExplorerNode === "pdf" && (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <FileText size={14} className="text-primary" />
                  <h3 className="text-sm font-semibold text-foreground">
                    PDF highlights
                  </h3>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {filteredAnnotations.length}
                  </span>
                </div>

                {isLoading ? (
                  <div className="h-60 rounded border border-border bg-card flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={15} className="animate-spin" />
                    Loading notes...
                  </div>
                ) : filteredAnnotations.length === 0 ? (
                  <div className="rounded border border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">
                    Highlight text inside a PDF and save a note to add PDF highlights here.
                  </div>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-2">
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
              </section>
            )}
          </div>
        </div>
      </div>

      {folderDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
          <div className="w-full max-w-md rounded border border-border bg-card shadow-2xl">
            <div className="flex items-start gap-3 border-b border-border px-5 py-4">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded border border-primary/25 bg-primary/10 text-primary">
                <FolderPlus size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-foreground">
                  Create folder
                </h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  Organize saved workspace notes into a research folder.
                </p>
              </div>
              <button
                type="button"
                title="Close"
                onClick={() => setFolderDialogOpen(false)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X size={15} />
              </button>
            </div>

            <div className="px-5 py-5">
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Folder name
                </span>
                <input
                  value={folderName}
                  onChange={(event) => {
                    setFolderName(event.target.value);
                    setFolderError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      createFolder();
                    }
                    if (event.key === "Escape") {
                      setFolderDialogOpen(false);
                    }
                  }}
                  autoFocus
                  placeholder="e.g. Graph RAG literature review"
                  className="mt-2 h-10 w-full rounded border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
                />
              </label>
              {folderError && (
                <p className="mt-2 text-xs text-destructive">
                  {folderError}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <button
                type="button"
                onClick={() => setFolderDialogOpen(false)}
                className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={createFolder}
                disabled={!folderName.trim()}
                className="h-9 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                Create folder
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

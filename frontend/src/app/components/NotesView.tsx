import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  Loader2,
  MessageSquarePlus,
  NotebookPen,
  Search,
  Send,
  Settings2,
  Trash2,
  X,
} from "lucide-react";

import {
  createNotionTarget,
  createServerNoteFolder,
  deleteNote,
  deleteNotionTarget,
  exportNoteToNotion,
  listNoteFolders,
  listNotes,
  listNotionTargets,
  noteAttachmentUrl,
  updateNote,
} from "../api";
import type {
  Annotation,
  NoteFolder,
  NotionTarget,
  ResearchNote,
  Source,
} from "../types";
import {
  DEFAULT_FOLDER_ID,
  migrateLocalWorkspaceNotes,
} from "../workspaceNoteStore";

function titleFromHighlight(note: ResearchNote): string {
  return (
    note.source_title ||
    note.title ||
    note.source_ref
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

function noteToAnnotation(note: ResearchNote): Annotation {
  return {
    annotation_id: note.note_id,
    source: note.source_ref,
    article_id: note.article_id || null,
    title: note.source_title || note.title || null,
    page: note.page || 1,
    selected_text: note.selected_text,
    note: note.body_md,
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
}

function NotionStatusChip({ note }: { note: ResearchNote }) {
  if (!note.notion_page_id) return null;
  return (
    <a
      href={note.notion_page_url || undefined}
      target="_blank"
      rel="noreferrer"
      className={`rounded border px-2 py-1 font-mono text-[10px] inline-flex items-center gap-1 ${
        note.notion_dirty
          ? "border-amber-500/40 bg-amber-500/10 text-amber-600"
          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
      }`}
      title={
        note.notion_dirty
          ? "Edited since the last Notion export - export again to update the page"
          : "Synced to Notion"
      }
    >
      <ExternalLink size={10} />
      {note.notion_dirty ? "Notion (edited)" : "Notion"}
    </a>
  );
}

export function NotesView({
  onOpenNote,
  onPinNote,
}: {
  onOpenNote: (annotation: Annotation) => void;
  onPinNote: (source: Source) => void;
}) {
  const [notes, setNotes] = useState<ResearchNote[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [targets, setTargets] = useState<NotionTarget[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
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
  const [targetsDialogOpen, setTargetsDialogOpen] = useState(false);
  const [targetName, setTargetName] = useState("");
  const [targetDatabaseId, setTargetDatabaseId] = useState("");
  const [targetError, setTargetError] = useState("");
  const [isSavingTarget, setIsSavingTarget] = useState(false);
  const [exportingNoteId, setExportingNoteId] = useState("");

  const loadAll = useCallback(async () => {
    const [notesResult, foldersResult] = await Promise.all([
      listNotes({ limit: 500 }),
      listNoteFolders(),
    ]);
    setNotes(notesResult.notes);
    setFolders(foldersResult.folders);

    try {
      const targetsResult = await listNotionTargets();
      setTargets(targetsResult.targets);
      setSelectedTargetId((current) =>
        current && targetsResult.targets.some((target) => target.target_id === current)
          ? current
          : targetsResult.targets[0]?.target_id || "",
      );
    } catch {
      // Notion targets are optional; the rest of the view still works.
    }
  }, []);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setStatus("");

    (async () => {
      try {
        const migration = await migrateLocalWorkspaceNotes();
        if (active && migration.migrated && migration.imported > 0) {
          setStatus(
            `Moved ${migration.imported} workspace note${
              migration.imported === 1 ? "" : "s"
            } from this browser into the research database.`,
          );
        }
      } catch {
        // Migration retries on the next load; keep the view usable.
      }

      try {
        await loadAll();
      } catch (error) {
        if (active) {
          setStatus(
            error instanceof Error
              ? `Could not load notes: ${error.message}`
              : "Could not load notes.",
          );
        }
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [loadAll]);

  const highlightNotes = useMemo(
    () => notes.filter((note) => note.note_type === "highlight"),
    [notes],
  );
  const workspaceNotes = useMemo(
    () => notes.filter((note) => note.note_type !== "highlight"),
    [notes],
  );

  const filteredHighlights = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filteredByKind = highlightNotes.filter((note) => {
      if (noteFilter === "with-note") return note.body_md.trim().length > 0;
      if (noteFilter === "highlight-only") return note.body_md.trim().length === 0;
      return true;
    });

    if (!needle) return filteredByKind;

    return filteredByKind.filter((note) =>
      [note.source_ref, note.source_title, note.title, note.selected_text, note.body_md]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [highlightNotes, noteFilter, query]);

  const filteredWorkspaceNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return workspaceNotes.filter((note) => {
      const folderMatch =
        activeFolderId === DEFAULT_FOLDER_ID || note.folder_id === activeFolderId;
      if (!folderMatch) return false;
      if (!needle) return true;
      return [
        note.title,
        note.body_md,
        note.source_title,
        ...note.attachments.map((attachment) => attachment.name),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [activeFolderId, query, workspaceNotes]);

  const workspaceNoteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    counts.set(DEFAULT_FOLDER_ID, workspaceNotes.length);
    workspaceNotes.forEach((note) => {
      counts.set(note.folder_id, (counts.get(note.folder_id) || 0) + 1);
    });
    return counts;
  }, [workspaceNotes]);

  const activeFolder = useMemo(
    () => folders.find((folder) => folder.folder_id === activeFolderId) || folders[0],
    [activeFolderId, folders],
  );

  function replaceNote(updated: ResearchNote) {
    setNotes((current) =>
      current.map((note) => (note.note_id === updated.note_id ? updated : note)),
    );
  }

  async function removeNote(noteId: string) {
    setNotes((current) => current.filter((note) => note.note_id !== noteId));
    try {
      await deleteNote(noteId);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not delete note: ${error.message}`
          : "Could not delete note.",
      );
      void loadAll();
    }
  }

  async function moveNote(note: ResearchNote, folderId: string) {
    try {
      const result = await updateNote(note.note_id, { folder_id: folderId });
      replaceNote(result.note);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not move note: ${error.message}`
          : "Could not move note.",
      );
    }
  }

  async function exportNote(note: ResearchNote) {
    if (targets.length > 0 && !selectedTargetId) {
      setStatus("Pick a Notion database first.");
      return;
    }

    setExportingNoteId(note.note_id);
    setStatus("");
    try {
      const result = await exportNoteToNotion(note.note_id, {
        target_id: selectedTargetId,
      });
      replaceNote(result.note);
      const verb = result.updated ? "Updated the Notion page for" : "Exported";
      const warnings = result.warnings.length
        ? ` (${result.warnings.join("; ")})`
        : "";
      setStatus(`${verb} "${result.note.title || titleFromHighlight(result.note)}".${warnings}`);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Notion export failed: ${error.message}`
          : "Notion export failed.",
      );
    } finally {
      setExportingNoteId("");
    }
  }

  function pinHighlight(note: ResearchNote) {
    onPinNote({
      id: `annotation:${note.note_id}`,
      source: note.source_ref,
      page: note.page || 1,
      text: note.body_md
        ? `${note.selected_text}\n\nNote: ${note.body_md}`
        : note.selected_text,
      selection: true,
      annotation_id: note.note_id,
      title: titleFromHighlight(note),
      article_id: note.article_id || undefined,
    });
  }

  function pinWorkspaceNote(note: ResearchNote) {
    onPinNote({
      id: `saved-workspace-note:${note.note_id}`,
      source: note.source_ref,
      text: note.body_md,
      selection: true,
      title: note.title || note.source_title || "Workspace note",
      document_type: "workspace_note",
    });
  }

  function openFolderDialog() {
    setFolderName("");
    setFolderError("");
    setFolderDialogOpen(true);
  }

  async function createFolder() {
    const name = folderName.trim();
    if (!name) {
      setFolderError("Folder name is required.");
      return;
    }

    try {
      const result = await createServerNoteFolder(name);
      const foldersResult = await listNoteFolders();
      setFolders(foldersResult.folders);
      setActiveFolderId(result.folder.folder_id);
      setActiveExplorerNode("workspace");
      setFolderName("");
      setFolderDialogOpen(false);
    } catch (error) {
      setFolderError(
        error instanceof Error ? error.message : "Could not create folder.",
      );
    }
  }

  async function addTarget() {
    const databaseId = targetDatabaseId.trim();
    if (!databaseId) {
      setTargetError("Paste the Notion database id.");
      return;
    }

    setIsSavingTarget(true);
    setTargetError("");
    try {
      const result = await createNotionTarget({
        name: targetName.trim(),
        database_id: databaseId,
      });
      const targetsResult = await listNotionTargets();
      setTargets(targetsResult.targets);
      setSelectedTargetId(result.target.target_id);
      setTargetName("");
      setTargetDatabaseId("");
    } catch (error) {
      setTargetError(
        error instanceof Error ? error.message : "Could not add the Notion database.",
      );
    } finally {
      setIsSavingTarget(false);
    }
  }

  async function removeTarget(targetId: string) {
    try {
      await deleteNotionTarget(targetId);
      const targetsResult = await listNotionTargets();
      setTargets(targetsResult.targets);
      setSelectedTargetId((current) =>
        current === targetId ? targetsResult.targets[0]?.target_id || "" : current,
      );
    } catch (error) {
      setTargetError(
        error instanceof Error ? error.message : "Could not remove the target.",
      );
    }
  }

  const exportDisabledReason =
    targets.length === 0
      ? "Add a Notion database first (Notion button above)"
      : "";

  function renderExportButton(note: ResearchNote) {
    const busy = exportingNoteId === note.note_id;
    return (
      <button
        type="button"
        title={
          exportDisabledReason ||
          (note.notion_page_id
            ? "Update the existing Notion page"
            : "Export this note to Notion")
        }
        disabled={busy || targets.length === 0}
        onClick={() => void exportNote(note)}
        className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-35 inline-flex items-center gap-2"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
        {note.notion_page_id ? "Re-sync" : "Notion"}
      </button>
    );
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
              Review highlights and workspace notes, send them back into chat, or
              publish them to Notion.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {targets.length > 0 && (
              <select
                value={selectedTargetId}
                onChange={(event) => setSelectedTargetId(event.target.value)}
                title="Notion database used by the export buttons"
                className="h-9 max-w-52 rounded border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-muted-foreground"
              >
                {targets.map((target) => (
                  <option key={target.target_id} value={target.target_id}>
                    {target.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => {
                setTargetError("");
                setTargetsDialogOpen(true);
              }}
              className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex items-center gap-2"
            >
              <Settings2 size={13} />
              Notion
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
              {filteredHighlights.length} shown
            </p>
          </div>
        )}

        {status && (
          <p className="mx-auto mt-3 max-w-5xl text-xs text-muted-foreground">
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
                  {workspaceNoteCounts.get(DEFAULT_FOLDER_ID) || 0}
                </span>
              </button>

              <div className="mt-1 space-y-1 border-l border-border/80 pl-3">
                {folders
                  .filter((folder) => folder.folder_id !== DEFAULT_FOLDER_ID)
                  .map((folder) => {
                    const active =
                      activeExplorerNode === "workspace" && activeFolderId === folder.folder_id;
                    return (
                      <button
                        key={folder.folder_id}
                        type="button"
                        onClick={() => {
                          setActiveExplorerNode("workspace");
                          setActiveFolderId(folder.folder_id);
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
                          {workspaceNoteCounts.get(folder.folder_id) || 0}
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
                  {filteredHighlights.length}
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
                    {filteredWorkspaceNotes.length}
                  </span>
                </div>

                {isLoading ? (
                  <div className="h-60 rounded border border-border bg-card flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={15} className="animate-spin" />
                    Loading notes...
                  </div>
                ) : filteredWorkspaceNotes.length === 0 ? (
                  <div className="rounded border border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">
                    Save a workspace note from the left notes pane, or capture a chat
                    answer, to add notes here.
                  </div>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-2">
                    {filteredWorkspaceNotes.map((note) => (
                      <article
                        key={note.note_id}
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
                                {note.title || note.source_title || "Workspace note"}
                              </h3>
                              <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                                {note.source_title || note.source_ref}
                              </p>
                            </div>
                          </div>

                          {note.body_md ? (
                            <p className="mt-4 overflow-hidden rounded border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground line-clamp-5 break-words">
                              {note.body_md}
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
                                  key={attachment.attachment_id}
                                  src={noteAttachmentUrl(attachment.attachment_id)}
                                  alt={attachment.name}
                                  loading="lazy"
                                  className="h-20 w-full rounded border border-border bg-white object-contain"
                                />
                              ))}
                            </div>
                          )}
                          <div className="mt-4 flex flex-wrap gap-2">
                            <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                              {dateLabel(note.updated_at)}
                            </span>
                            {note.note_type === "chat_capture" && (
                              <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                                from chat
                              </span>
                            )}
                            {note.attachments.length > 0 && (
                              <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground inline-flex items-center gap-1">
                                <Image size={11} />
                                {note.attachments.length}
                              </span>
                            )}
                            <NotionStatusChip note={note} />
                          </div>
                        </div>

                        <div className="mt-5 flex shrink-0 flex-wrap items-center gap-2 border-t border-border/70 pt-4">
                          <button
                            type="button"
                            onClick={() => pinWorkspaceNote(note)}
                            className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex items-center gap-2"
                          >
                            <MessageSquarePlus size={13} />
                            Use in chat
                          </button>
                          {renderExportButton(note)}
                          <select
                            value={note.folder_id}
                            onChange={(event) => void moveNote(note, event.target.value)}
                            className="h-9 min-w-32 rounded border border-border bg-background px-2 text-xs text-muted-foreground outline-none hover:bg-secondary hover:text-foreground"
                          >
                            {folders.map((folder) => (
                              <option key={folder.folder_id} value={folder.folder_id}>
                                {folder.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => void removeNote(note.note_id)}
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
                    {filteredHighlights.length}
                  </span>
                </div>

                {isLoading ? (
                  <div className="h-60 rounded border border-border bg-card flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={15} className="animate-spin" />
                    Loading notes...
                  </div>
                ) : filteredHighlights.length === 0 ? (
                  <div className="rounded border border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">
                    Highlight text inside a PDF and save a note to add PDF highlights here.
                  </div>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-2">
                    {filteredHighlights.map((note) => (
                      <article
                        key={note.note_id}
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
                                {titleFromHighlight(note)}
                              </h3>
                              <p className="mt-2 max-w-full font-mono text-[11px] text-muted-foreground break-all">
                                p.{note.page || 1} / {note.source_ref}
                              </p>
                            </div>
                          </div>

                          <p className="mt-4 overflow-hidden border-l border-border pl-4 text-sm leading-6 text-muted-foreground line-clamp-3 break-words">
                            {note.selected_text}
                          </p>
                          {note.body_md && (
                            <p className="mt-4 overflow-hidden rounded border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground line-clamp-3 break-words">
                              {note.body_md}
                            </p>
                          )}
                          <div className="mt-4 flex flex-wrap gap-2">
                            {dateLabel(note.updated_at) && (
                              <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                                {dateLabel(note.updated_at)}
                              </span>
                            )}
                            <span className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                              {note.body_md ? "note" : "highlight"}
                            </span>
                            <NotionStatusChip note={note} />
                          </div>
                        </div>

                        <div className="mt-5 flex shrink-0 flex-wrap items-center justify-start gap-2 border-t border-border/70 pt-4">
                          <button
                            type="button"
                            onClick={() => onOpenNote(noteToAnnotation(note))}
                            className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex items-center gap-2"
                          >
                            <FileText size={13} />
                            Open PDF
                          </button>
                          <button
                            type="button"
                            onClick={() => pinHighlight(note)}
                            className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex items-center gap-2"
                          >
                            <MessageSquarePlus size={13} />
                            Use in chat
                          </button>
                          {renderExportButton(note)}
                          <button
                            type="button"
                            onClick={() => void removeNote(note.note_id)}
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
                      void createFolder();
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
                onClick={() => void createFolder()}
                disabled={!folderName.trim()}
                className="h-9 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                Create folder
              </button>
            </div>
          </div>
        </div>
      )}

      {targetsDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
          <div className="w-full max-w-lg rounded border border-border bg-card shadow-2xl">
            <div className="flex items-start gap-3 border-b border-border px-5 py-4">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded border border-primary/25 bg-primary/10 text-primary">
                <Send size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-foreground">
                  Notion databases
                </h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  Register the Notion databases notes can be published to. Share each
                  database with your integration in Notion first.
                </p>
              </div>
              <button
                type="button"
                title="Close"
                onClick={() => setTargetsDialogOpen(false)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X size={15} />
              </button>
            </div>

            <div className="max-h-56 overflow-y-auto px-5 py-4 space-y-2">
              {targets.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No databases registered yet.
                </p>
              ) : (
                targets.map((target) => (
                  <div
                    key={target.target_id}
                    className="flex items-center gap-3 rounded border border-border bg-background px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {target.name}
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {target.database_id}
                        {target.schema?.properties
                          ? ` - ${Object.keys(target.schema.properties).length} properties`
                          : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      title="Remove target"
                      onClick={() => void removeTarget(target.target_id)}
                      className="h-8 w-8 rounded flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-destructive"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-border px-5 py-4 space-y-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                <input
                  value={targetName}
                  onChange={(event) => setTargetName(event.target.value)}
                  placeholder="Name (e.g. Papers)"
                  className="h-10 rounded border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
                />
                <input
                  value={targetDatabaseId}
                  onChange={(event) => {
                    setTargetDatabaseId(event.target.value);
                    setTargetError("");
                  }}
                  placeholder="Notion database id"
                  className="h-10 rounded border border-border bg-background px-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
                />
              </div>
              {targetError && (
                <p className="text-xs text-destructive">{targetError}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setTargetsDialogOpen(false)}
                  className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => void addTarget()}
                  disabled={isSavingTarget || !targetDatabaseId.trim()}
                  className="h-9 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 inline-flex items-center gap-2"
                >
                  {isSavingTarget && <Loader2 size={13} className="animate-spin" />}
                  Add database
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  ExternalLink,
  FileText,
  Folder,
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
  Pencil,
} from "lucide-react";
import { NoteEditor, NotePreview } from "./notes";
import { NotesExplorer } from "./notes/NotesExplorer";
import {
  NOTE_DRAG_TYPE,
  childFolders,
  countNotesByFolder,
  descendantIds,
  folderPath,
} from "./notes/folderTree";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";

import {
  createNotionTarget,
  createServerNoteFolder,
  deleteIntegrationSecret,
  deleteNote,
  deleteNoteFolder,
  deleteNotionTarget,
  exportNoteToNotion,
  getIntegrations,
  getNotionAuthorizeUrl,
  listNoteFolders,
  listNotes,
  listNotionDatabases,
  listNotionTargets,
  noteAttachmentUrl,
  setIntegrationSecret,
  updateNote,
  updateNoteFolder,
} from "../api";
import { useRegisterUiActions, useReportWorkspace } from "../assistant";
import type {
  Annotation,
  IntegrationStatus,
  NoteFolder,
  NotionDatabase,
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
  const [folderParentId, setFolderParentId] = useState(DEFAULT_FOLDER_ID);
  const [folderError, setFolderError] = useState("");
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const [targetsDialogOpen, setTargetsDialogOpen] = useState(false);
  const [targetName, setTargetName] = useState("");
  const [targetDatabaseId, setTargetDatabaseId] = useState("");
  const [targetError, setTargetError] = useState("");
  const [isSavingTarget, setIsSavingTarget] = useState(false);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus[]>([]);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [savingSecret, setSavingSecret] = useState("");
  const [secretError, setSecretError] = useState("");
  const [connectingNotion, setConnectingNotion] = useState(false);
  const [notionDatabases, setNotionDatabases] = useState<NotionDatabase[]>([]);
  const [pickedDatabaseId, setPickedDatabaseId] = useState("");

  const notionStatus = integrationStatus.find((item) => item.provider === "notion");
  const notionConnected = Boolean(notionStatus?.configured);

  // Returning from Notion's consent screen: open the dialog and report the outcome.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("notion");
    if (!outcome) return;
    if (outcome === "connected") {
      setStatus("Notion connected. Pick the database your notes should be published to.");
    } else {
      setSecretError(params.get("detail") || "Connecting Notion failed.");
    }
    setTargetsDialogOpen(true);
    params.delete("notion");
    params.delete("detail");
    const remaining = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${remaining ? `?${remaining}` : ""}`);
  }, []);

  useEffect(() => {
    if (!targetsDialogOpen) return;
    let active = true;
    getIntegrations()
      .then((result) => {
        if (active) setIntegrationStatus(result.integrations);
      })
      .catch(() => {
        if (active) setIntegrationStatus([]);
      });
    return () => {
      active = false;
    };
  }, [targetsDialogOpen]);

  useEffect(() => {
    if (!targetsDialogOpen || !notionConnected) {
      setNotionDatabases([]);
      return;
    }
    let active = true;
    listNotionDatabases()
      .then((result) => {
        if (active) setNotionDatabases(result.databases);
      })
      .catch(() => {
        if (active) setNotionDatabases([]);
      });
    return () => {
      active = false;
    };
  }, [notionConnected, targetsDialogOpen]);

  async function connectNotion() {
    setConnectingNotion(true);
    setSecretError("");
    try {
      const { url } = await getNotionAuthorizeUrl();
      window.location.assign(url);
    } catch (error) {
      setSecretError(error instanceof Error ? error.message : "Could not start Notion sign-in.");
      setConnectingNotion(false);
    }
  }

  async function addPickedDatabase() {
    const database = notionDatabases.find((item) => item.database_id === pickedDatabaseId);
    if (!database) return;
    setIsSavingTarget(true);
    setTargetError("");
    try {
      const result = await createNotionTarget({ name: database.title, database_id: database.database_id });
      const targetsResult = await listNotionTargets();
      setTargets(targetsResult.targets);
      setSelectedTargetId(result.target.target_id);
      setPickedDatabaseId("");
    } catch (error) {
      setTargetError(error instanceof Error ? error.message : "Could not add the Notion database.");
    } finally {
      setIsSavingTarget(false);
    }
  }

  async function saveSecret(provider: string) {
    const secret = (secretDrafts[provider] ?? "").trim();
    if (!secret) return;
    setSavingSecret(provider);
    setSecretError("");
    try {
      const result = await setIntegrationSecret(provider, secret);
      setIntegrationStatus((current) =>
        current.map((item) => (item.provider === provider ? result.integration : item)),
      );
      setSecretDrafts((current) => ({ ...current, [provider]: "" }));
    } catch (error) {
      setSecretError(error instanceof Error ? error.message : "Could not save the credential.");
    } finally {
      setSavingSecret("");
    }
  }

  async function forgetSecret(provider: string) {
    setSavingSecret(provider);
    setSecretError("");
    try {
      const result = await deleteIntegrationSecret(provider);
      setIntegrationStatus((current) =>
        current.map((item) => (item.provider === provider ? result.integration : item)),
      );
    } catch (error) {
      setSecretError(error instanceof Error ? error.message : "Could not remove the credential.");
    } finally {
      setSavingSecret("");
    }
  }
  const [exportingNoteId, setExportingNoteId] = useState("");
  const [editingNote, setEditingNote] = useState<ResearchNote | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  function editNote(note: ResearchNote) {
    setEditingNote(note); setEditTitle(note.title); setEditBody(note.body_md); setEditError("");
  }

  // The assistant can open a note by id and sees which note is being edited.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  useRegisterUiActions({
    "notes.openNote": async (noteId: string) => {
      let note = notesRef.current.find((item) => item.note_id === noteId);
      if (!note) {
        const result = await listNotes({ limit: 500 });
        note = result.notes.find((item) => item.note_id === noteId);
      }
      if (!note) throw new Error("No note with that id exists");
      setActiveFolderId(note.folder_id || DEFAULT_FOLDER_ID);
      setSelectedNoteIds(new Set([noteId]));
      editNote(note);
      return { opened: true, note_id: note.note_id, title: note.title };
    },
    "notes.refresh": () => loadAll(),
  });
  useReportWorkspace(
    () => ({ open_note: editingNote ? { id: editingNote.note_id, title: editingNote.title } : null }),
    [editingNote],
  );
  async function saveEdit() {
    if (!editingNote || savingEdit) return;
    setSavingEdit(true); setEditError("");
    try {
      const result = await updateNote(editingNote.note_id, {title: editTitle, body_md: editBody});
      replaceNote(result.note); setEditingNote(null);
    } catch (error) { setEditError(error instanceof Error ? error.message : "Could not save note"); }
    finally { setSavingEdit(false); }
  }

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

  const folderCounts = useMemo(
    () => countNotesByFolder(workspaceNotes, folders),
    [folders, workspaceNotes],
  );
  const activePath = useMemo(() => folderPath(folders, activeFolderId), [activeFolderId, folders]);
  const activeSubfolders = useMemo(
    () => childFolders(folders, activeFolderId),
    [activeFolderId, folders],
  );
  const moveTargets = useMemo(
    () =>
      folders.map((folder) => ({
        id: folder.folder_id,
        label:
          folder.folder_id === DEFAULT_FOLDER_ID
            ? "All workspace notes"
            : folderPath(folders, folder.folder_id).map((item) => item.name).join(" / "),
      })),
    [folders],
  );

  function selectFolder(folderId: string) {
    setActiveExplorerNode("workspace");
    setActiveFolderId(folderId);
    setSelectedNoteIds(new Set());
  }

  function toggleSelected(noteId: string) {
    setSelectedNoteIds((current) => {
      const next = new Set(current);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }

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

  async function moveNotes(noteIds: string[], folderId: string) {
    const targets = notes.filter(
      (note) => noteIds.includes(note.note_id) && note.folder_id !== folderId,
    );
    if (targets.length === 0) return;
    try {
      const results = await Promise.all(
        targets.map((note) => updateNote(note.note_id, { folder_id: folderId })),
      );
      const updated = new Map(results.map((result) => [result.note.note_id, result.note]));
      setNotes((current) => current.map((note) => updated.get(note.note_id) ?? note));
      setSelectedNoteIds(new Set());
      const destination =
        moveTargets.find((target) => target.id === folderId)?.label ?? "the folder";
      setStatus(`Moved ${targets.length} note${targets.length === 1 ? "" : "s"} to ${destination}.`);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not move notes: ${error.message}`
          : "Could not move notes.",
      );
      void loadAll();
    }
  }

  function moveNote(note: ResearchNote, folderId: string) {
    return moveNotes([note.note_id], folderId);
  }

  async function deleteSelectedNotes() {
    const ids = [...selectedNoteIds];
    if (ids.length === 0) return;
    setNotes((current) => current.filter((note) => !selectedNoteIds.has(note.note_id)));
    setSelectedNoteIds(new Set());
    try {
      await Promise.all(ids.map((id) => deleteNote(id)));
      setStatus(`Deleted ${ids.length} note${ids.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not delete notes: ${error.message}`
          : "Could not delete notes.",
      );
      void loadAll();
    }
  }

  async function renameFolder(folderId: string, name: string) {
    try {
      const result = await updateNoteFolder(folderId, { name });
      setFolders((current) =>
        current.map((folder) => (folder.folder_id === folderId ? result.folder : folder)),
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not rename folder: ${error.message}`
          : "Could not rename folder.",
      );
    }
  }

  async function moveFolder(folderId: string, parentId: string) {
    try {
      const result = await updateNoteFolder(folderId, { parent_id: parentId });
      setFolders((current) =>
        current.map((folder) => (folder.folder_id === folderId ? result.folder : folder)),
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not move folder: ${error.message}`
          : "Could not move folder.",
      );
    }
  }

  async function deleteFolder(folderId: string) {
    const removed = folders.find((folder) => folder.folder_id === folderId);
    const affected = descendantIds(folders, folderId);
    try {
      const result = await deleteNoteFolder(folderId);
      const [foldersResult, notesResult] = await Promise.all([
        listNoteFolders(),
        listNotes({ limit: 500 }),
      ]);
      setFolders(foldersResult.folders);
      setNotes(notesResult.notes);
      if (activeFolderId === folderId || affected.has(activeFolderId)) {
        selectFolder(result.parent_id || DEFAULT_FOLDER_ID);
      }
      const parts = [
        `Deleted folder "${removed?.name ?? folderId}".`,
        result.notes_moved > 0
          ? `${result.notes_moved} note${result.notes_moved === 1 ? "" : "s"} moved up.`
          : "",
        result.folders_moved > 0
          ? `${result.folders_moved} subfolder${result.folders_moved === 1 ? "" : "s"} moved up.`
          : "",
      ];
      setStatus(parts.filter(Boolean).join(" "));
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not delete folder: ${error.message}`
          : "Could not delete folder.",
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

  function openFolderDialog(parentId: string = DEFAULT_FOLDER_ID) {
    setFolderName("");
    setFolderParentId(parentId);
    setFolderError("");
    setFolderDialogOpen(true);
  }

  const folderDialogParentName =
    folderParentId === DEFAULT_FOLDER_ID
      ? ""
      : folders.find((folder) => folder.folder_id === folderParentId)?.name ?? "";

  async function createFolder() {
    const name = folderName.trim();
    if (!name) {
      setFolderError("Folder name is required.");
      return;
    }

    try {
      const result = await createServerNoteFolder(
        name,
        folderParentId === DEFAULT_FOLDER_ID ? "" : folderParentId,
      );
      const foldersResult = await listNoteFolders();
      setFolders(foldersResult.folders);
      selectFolder(result.folder.folder_id);
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
          <NotesExplorer
            folders={folders}
            counts={folderCounts}
            highlightCount={filteredHighlights.length}
            activeNode={activeExplorerNode}
            activeFolderId={activeFolderId}
            onSelectFolder={selectFolder}
            onSelectHighlights={() => setActiveExplorerNode("pdf")}
            onCreateFolder={openFolderDialog}
            onRenameFolder={renameFolder}
            onMoveFolder={moveFolder}
            onDeleteFolder={deleteFolder}
            onDropNotes={(noteIds, folderId) => void moveNotes(noteIds, folderId)}
          />

          <div className="min-w-0 space-y-8">
            {activeExplorerNode === "workspace" && (
              <section>
                <nav
                  aria-label="Folder path"
                  className="mb-3 flex flex-wrap items-center gap-1 text-sm"
                >
                  <NotebookPen size={14} className="mr-1 text-primary" />
                  <button
                    type="button"
                    onClick={() => selectFolder(DEFAULT_FOLDER_ID)}
                    className={`rounded px-1 font-semibold ${
                      activePath.length === 0
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    All workspace notes
                  </button>
                  {activePath.map((folder, index) => (
                    <span key={folder.folder_id} className="flex items-center gap-1">
                      <ChevronRight size={12} className="text-muted-foreground" />
                      <button
                        type="button"
                        onClick={() => selectFolder(folder.folder_id)}
                        className={`rounded px-1 font-semibold ${
                          index === activePath.length - 1
                            ? "text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {folder.name}
                      </button>
                    </span>
                  ))}
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                    {filteredWorkspaceNotes.length}
                  </span>
                </nav>

                {activeSubfolders.length > 0 && (
                  <div className="mb-4 flex flex-wrap gap-2">
                    {activeSubfolders.map((folder) => (
                      <button
                        key={folder.folder_id}
                        type="button"
                        onClick={() => selectFolder(folder.folder_id)}
                        className="inline-flex h-8 items-center gap-2 rounded border border-border bg-card px-3 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        <Folder size={13} />
                        {folder.name}
                        <span className="font-mono text-[10px]">
                          {folderCounts.total.get(folder.folder_id) ?? 0}
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => openFolderDialog(activeFolderId)}
                      className="inline-flex h-8 items-center gap-2 rounded border border-dashed border-border px-3 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <FolderPlus size={13} />
                      New folder
                    </button>
                  </div>
                )}

                {filteredWorkspaceNotes.length > 0 && (
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                    <label className="inline-flex h-8 items-center gap-2 rounded border border-border px-3 text-muted-foreground hover:text-foreground">
                      <input
                        type="checkbox"
                        aria-label="Select all notes in this folder"
                        checked={
                          filteredWorkspaceNotes.length > 0 &&
                          filteredWorkspaceNotes.every((note) => selectedNoteIds.has(note.note_id))
                        }
                        onChange={(event) =>
                          setSelectedNoteIds(
                            event.target.checked
                              ? new Set(filteredWorkspaceNotes.map((note) => note.note_id))
                              : new Set(),
                          )
                        }
                      />
                      Select all
                    </label>
                    {selectedNoteIds.size > 0 && (
                      <>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {selectedNoteIds.size} selected
                        </span>
                        <select
                          aria-label="Move selected notes to folder"
                          value=""
                          onChange={(event) => {
                            if (event.target.value) {
                              void moveNotes([...selectedNoteIds], event.target.value);
                            }
                          }}
                          className="h-8 rounded border border-border bg-background px-2 text-xs text-muted-foreground outline-none hover:bg-secondary hover:text-foreground"
                        >
                          <option value="">Move to...</option>
                          {moveTargets.map((target) => (
                            <option key={target.id} value={target.id}>
                              {target.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => void deleteSelectedNotes()}
                          className="inline-flex h-8 items-center gap-2 rounded border border-border px-3 text-muted-foreground hover:bg-secondary hover:text-destructive"
                        >
                          <Trash2 size={13} />
                          Delete selected
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedNoteIds(new Set())}
                          className="inline-flex h-8 items-center rounded px-2 text-muted-foreground hover:text-foreground"
                        >
                          Clear
                        </button>
                      </>
                    )}
                  </div>
                )}

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
                      <ContextMenu key={note.note_id}>
                      <ContextMenuTrigger asChild>
                      <article
                        draggable
                        onDragStart={(event) => {
                          const ids = selectedNoteIds.has(note.note_id)
                            ? [...selectedNoteIds]
                            : [note.note_id];
                          event.dataTransfer.setData(NOTE_DRAG_TYPE, JSON.stringify(ids));
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        className={`flex min-h-[240px] min-w-0 flex-col overflow-hidden rounded border bg-card px-5 py-5 transition-colors hover:bg-secondary/40 ${
                          selectedNoteIds.has(note.note_id)
                            ? "border-foreground/50"
                            : "border-border hover:border-border/80"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              aria-label={`Select note ${note.title || note.source_title || "Workspace note"}`}
                              checked={selectedNoteIds.has(note.note_id)}
                              onChange={() => toggleSelected(note.note_id)}
                              className="mt-1.5 shrink-0"
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
                            <NotePreview value={note.body_md} className="mt-4 max-h-48 overflow-auto rounded border border-border bg-background px-3 py-2" />
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
                          <button type="button" className="inline-flex h-9 items-center gap-2 rounded border border-border px-3 text-xs" onClick={() => editNote(note)}><Pencil size={13} /> Edit</button>
                          {renderExportButton(note)}
                          <select
                            aria-label="Move note to folder"
                            value={note.folder_id}
                            onChange={(event) => void moveNote(note, event.target.value)}
                            className="h-9 min-w-32 max-w-56 rounded border border-border bg-background px-2 text-xs text-muted-foreground outline-none hover:bg-secondary hover:text-foreground"
                          >
                            {moveTargets.map((target) => (
                              <option key={target.id} value={target.id}>
                                {target.label}
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
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-52">
                        <ContextMenuItem onSelect={() => pinWorkspaceNote(note)}>
                          <MessageSquarePlus size={14} /> Use in chat
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => editNote(note)}>
                          <Pencil size={14} /> Edit
                        </ContextMenuItem>
                        <ContextMenuSub>
                          <ContextMenuSubTrigger>
                            <CornerLeftUp size={14} className="mr-2" /> Move to
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                            {moveTargets
                              .filter((target) => target.id !== note.folder_id)
                              .map((target) => (
                                <ContextMenuItem
                                  key={target.id}
                                  onSelect={() => void moveNote(note, target.id)}
                                >
                                  <Folder size={13} /> {target.label}
                                </ContextMenuItem>
                              ))}
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                        <ContextMenuItem onSelect={() => toggleSelected(note.note_id)}>
                          {selectedNoteIds.has(note.note_id) ? "Deselect" : "Select"}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          onSelect={() => void removeNote(note.note_id)}
                        >
                          <Trash2 size={14} /> Delete
                        </ContextMenuItem>
                      </ContextMenuContent>
                      </ContextMenu>
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
                            <NotePreview value={note.body_md} className="mt-4 max-h-48 overflow-auto rounded border border-border bg-background px-3 py-2" />
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
                          <button type="button" className="inline-flex h-9 items-center gap-2 rounded border border-border px-3 text-xs" onClick={() => editNote(note)}><Pencil size={13} /> Edit note</button>
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
                  {folderDialogParentName ? `New folder in "${folderDialogParentName}"` : "Create folder"}
                </h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {folderDialogParentName
                    ? "Folders can nest as deep as you like. Drag it later to move it."
                    : "Organize saved workspace notes into a research folder."}
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
                  Notion &amp; integrations
                </h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  Your own credentials and Notion databases. Nothing here is shared with
                  other users; share each database with your Notion integration first.
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

            <div className="border-b border-border px-5 py-4 space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Your credentials
              </p>
              {integrationStatus.length === 0 ? (
                <p className="text-sm text-muted-foreground">Loading credential status...</p>
              ) : (
                integrationStatus.map((item) => {
                  const viaOauth = item.source === "user" && item.method === "oauth";
                  const tokenField = (
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                      <input
                        type="password"
                        autoComplete="off"
                        aria-label={`${item.label} credential`}
                        value={secretDrafts[item.provider] ?? ""}
                        onChange={(event) =>
                          setSecretDrafts((current) => ({ ...current, [item.provider]: event.target.value }))
                        }
                        placeholder={
                          item.provider === "notion"
                            ? "Notion internal integration token (ntn_...)"
                            : "GitHub personal access token"
                        }
                        className="h-9 rounded border border-border bg-background px-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void saveSecret(item.provider)}
                          disabled={savingSecret === item.provider || !(secretDrafts[item.provider] ?? "").trim()}
                          className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
                        >
                          Save
                        </button>
                        {item.source === "user" && !viaOauth && (
                          <button
                            type="button"
                            title="Forget this credential"
                            onClick={() => void forgetSecret(item.provider)}
                            disabled={savingSecret === item.provider}
                            className="h-9 w-9 rounded flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-destructive disabled:opacity-40"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  );

                  return (
                    <div key={item.provider} className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-start">
                      <div>
                        <p className="text-sm font-medium text-foreground">{item.label}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {!item.configured
                            ? "not connected"
                            : viaOauth
                              ? "connected"
                              : item.source === "user"
                                ? "your token"
                                : "server default"}
                        </p>
                      </div>

                      {item.provider === "notion" && item.oauth_available ? (
                        viaOauth ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm text-foreground">
                              {item.meta?.workspace_icon ? `${item.meta.workspace_icon} ` : ""}
                              {item.meta?.workspace_name || "Notion workspace"}
                            </span>
                            <button
                              type="button"
                              onClick={() => void connectNotion()}
                              disabled={connectingNotion}
                              className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
                            >
                              Change pages
                            </button>
                            <button
                              type="button"
                              onClick={() => void forgetSecret(item.provider)}
                              disabled={savingSecret === item.provider}
                              className="h-9 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-destructive disabled:opacity-40"
                            >
                              Disconnect
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-3">
                              <button
                                type="button"
                                onClick={() => void connectNotion()}
                                disabled={connectingNotion}
                                className="h-9 rounded bg-foreground px-3 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-40"
                              >
                                {connectingNotion ? "Opening Notion..." : "Connect Notion"}
                              </button>
                              <span className="text-xs text-muted-foreground">
                                You will sign in to Notion and choose which pages Zoetrope may use.
                              </span>
                            </div>
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer hover:text-foreground">
                                Use an internal integration token instead
                              </summary>
                              <div className="mt-2">{tokenField}</div>
                            </details>
                          </div>
                        )
                      ) : (
                        tokenField
                      )}
                    </div>
                  );
                })
              )}
              {secretError && <p className="text-xs text-destructive">{secretError}</p>}
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
              {notionConnected && notionDatabases.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <select
                    aria-label="Notion database to add"
                    value={pickedDatabaseId}
                    onChange={(event) => setPickedDatabaseId(event.target.value)}
                    className="h-10 rounded border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary/60"
                  >
                    <option value="">Pick a database Zoetrope can reach...</option>
                    {notionDatabases
                      .filter((database) => !targets.some((target) => target.database_id === database.database_id))
                      .map((database) => (
                        <option key={database.database_id} value={database.database_id}>
                          {database.title}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void addPickedDatabase()}
                    disabled={isSavingTarget || !pickedDatabaseId}
                    className="h-10 rounded border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              )}
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
      <Dialog open={editingNote !== null} onOpenChange={open => {if (!open && !savingEdit) setEditingNote(null);}}>
        <DialogContent className="flex h-[85vh] flex-col sm:max-w-5xl" onInteractOutside={event => event.preventDefault()}>
          <DialogTitle>Edit research note</DialogTitle>
          <DialogDescription>Format your notes, highlight key ideas, and write LaTeX equations.</DialogDescription>
          <input aria-label="Note title" className="rounded border bg-background px-3 py-2 text-lg font-semibold" value={editTitle} onChange={event => setEditTitle(event.target.value)} />
          <NoteEditor value={editBody} onChange={setEditBody} onSave={() => void saveEdit()} />
          {editError && <p role="alert" className="text-sm text-destructive">{editError}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="rounded border px-4 py-2 text-sm" disabled={savingEdit} onClick={() => setEditingNote(null)}>Cancel</button>
            <button type="button" className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40" disabled={savingEdit} onClick={() => void saveEdit()}>{savingEdit ? "Saving…" : "Save changes"}</button></div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

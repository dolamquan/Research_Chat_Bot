import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  Download,
  FileText,
  ImagePlus,
  MessageSquarePlus,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  PenTool,
  Save,
  Send,
} from "lucide-react";
import {
  Excalidraw,
  exportToBlob,
  getNonDeletedElements,
  THEME,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import type { Source } from "../types";
import {
  addNoteAttachment,
  createNote,
  exportNoteToNotion,
  listNotes,
  listNotionTargets,
  updateNote,
} from "../api";

type NoteMode = "notes" | "sketch";

type ExcalidrawScene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

type NoteAttachment = {
  id: string;
  kind: "image" | "sketch";
  name: string;
  dataUrl: string;
  createdAt: string;
  scene?: ExcalidrawScene;
};

type WorkspaceNoteDocument = {
  body: string;
  attachments: NoteAttachment[];
  sketch?: ExcalidrawScene;
};

type WorkspaceNotesPaneProps = {
  open: boolean;
  width: number;
  scopeId: string;
  scopeTitle: string;
  onToggle: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPinNote: (source: Source) => void;
};

const EXCALIDRAW_UI_OPTIONS = {
  canvasActions: {
    saveAsImage: true,
    export: {
      saveFileToDisk: true,
    },
    loadScene: true,
    saveToActiveFile: false,
    toggleTheme: false,
  },
};

function storageKey(scopeId: string): string {
  return `researchmind.workspace-note:${scopeId || "global"}`;
}

function emptyScene(): ExcalidrawScene {
  return {
    elements: [],
    appState: {
      theme: THEME.LIGHT,
      viewBackgroundColor: "#ffffff",
    },
    files: {},
  };
}

function parseStoredNote(raw: string | null): WorkspaceNoteDocument {
  if (!raw) {
    return { body: "", attachments: [], sketch: emptyScene() };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceNoteDocument>;
    return {
      body: typeof parsed.body === "string" ? parsed.body : "",
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      sketch: parsed.sketch || emptyScene(),
    };
  } catch {
    return { body: raw, attachments: [], sketch: emptyScene() };
  }
}

function serializeNote(
  body: string,
  attachments: NoteAttachment[],
  sketch: ExcalidrawScene,
): string {
  return JSON.stringify({ body, attachments, sketch });
}

function noteAsMarkdown(
  title: string,
  body: string,
  attachments: NoteAttachment[],
): string {
  return [
    `# ${title}`,
    "",
    body,
    attachments.length ? "\n## Attachments" : "",
    ...attachments.map(
      (attachment, index) =>
        `![${attachment.name || `Attachment ${index + 1}`}](${attachment.dataUrl})`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function downloadMarkdown(
  title: string,
  body: string,
  attachments: NoteAttachment[],
) {
  const blob = new Blob([noteAsMarkdown(title, body, attachments)], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "research-note"}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read blob"));
    reader.readAsDataURL(blob);
  });
}

function exportableAppState(appState: Partial<AppState>): Partial<AppState> {
  return {
    ...appState,
    exportBackground: true,
    viewBackgroundColor: appState.viewBackgroundColor || "#ffffff",
  };
}

export function WorkspaceNotesPane({
  open,
  width,
  scopeId,
  scopeTitle,
  onToggle,
  onResizeStart,
  onPinNote,
}: WorkspaceNotesPaneProps) {
  const [mode, setMode] = useState<NoteMode>("notes");
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState<NoteAttachment[]>([]);
  const [sketch, setSketch] = useState<ExcalidrawScene>(emptyScene);
  const [sketchElementCount, setSketchElementCount] = useState(0);
  const [savedAt, setSavedAt] = useState("");
  const [librarySavedAt, setLibrarySavedAt] = useState("");
  const [sketchStatus, setSketchStatus] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const sketchRef = useRef<ExcalidrawScene>(emptyScene());
  const sketchSaveTimeoutRef = useRef<number>();
  const serverNoteIdRef = useRef<string>("");
  const uploadedAttachmentIdsRef = useRef<Set<string>>(new Set());
  const noteKey = useMemo(() => storageKey(scopeId), [scopeId]);
  const initialSketchData = useMemo(
    () => ({
      elements: sketch.elements,
      appState: {
        ...sketch.appState,
        theme: THEME.LIGHT,
        viewBackgroundColor:
          sketch.appState.viewBackgroundColor || "#ffffff",
      },
      files: sketch.files,
    }),
    [sketch],
  );

  useEffect(() => {
    const stored = parseStoredNote(localStorage.getItem(noteKey));
    setNote(stored.body);
    setAttachments(stored.attachments);
    const storedSketch = stored.sketch || emptyScene();
    sketchRef.current = storedSketch;
    setSketch(storedSketch);
    setSketchElementCount(storedSketch.elements.length);
    setSavedAt("");
    setLibrarySavedAt("");
    setSketchStatus("");
    setSyncStatus("");
    serverNoteIdRef.current = "";
    uploadedAttachmentIdsRef.current = new Set();
  }, [noteKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      localStorage.setItem(
        noteKey,
        serializeNote(note, attachments, sketchRef.current),
      );
      if (note.trim() || attachments.length || sketchRef.current.elements.length) {
        setSavedAt(
          new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        );
      }
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [attachments, note, noteKey]);

  useEffect(() => {
    if (mode !== "sketch") return;
    window.setTimeout(() => excalidrawApiRef.current?.refresh(), 100);
  }, [mode, width]);

  function pinCurrentNote() {
    const markdown = noteAsMarkdown(scopeTitle, note.trim(), attachments);
    if (!note.trim() && attachments.length === 0) return;

    onPinNote({
      id: `workspace-note:${scopeId}:${Date.now()}`,
      title: `Workspace note: ${scopeTitle}`,
      text: markdown,
      source: scopeId,
      selection: true,
      document_type: "workspace_note",
    });
  }

  async function resolveServerNoteId(): Promise<string> {
    if (serverNoteIdRef.current) return serverNoteIdRef.current;

    // Notes migrated from localStorage kept their legacy scoped id, so a
    // lookup by scope reattaches to them instead of creating duplicates.
    const existing = await listNotes({
      noteType: "freeform",
      sourceRef: scopeId || "global",
      limit: 1,
    });
    if (existing.notes.length > 0) {
      serverNoteIdRef.current = existing.notes[0].note_id;
      uploadedAttachmentIdsRef.current = new Set(attachments.map((item) => item.id));
      return serverNoteIdRef.current;
    }

    const created = await createNote({
      note_type: "freeform",
      source_type: "scope",
      source_ref: scopeId || "global",
      source_title: scopeTitle,
      title: scopeTitle || "Workspace note",
      body_md: note,
      sketch: sketchRef.current,
    });
    serverNoteIdRef.current = created.note.note_id;
    return serverNoteIdRef.current;
  }

  async function saveCurrentNoteToLibrary(): Promise<string> {
    if (!note.trim() && attachments.length === 0 && sketchRef.current.elements.length === 0) {
      return "";
    }

    setIsSyncing(true);
    setSyncStatus("");
    try {
      const noteId = await resolveServerNoteId();
      await updateNote(noteId, {
        title: scopeTitle || "Workspace note",
        source_title: scopeTitle,
        body_md: note,
        sketch: sketchRef.current,
      });

      for (const attachment of attachments) {
        if (uploadedAttachmentIdsRef.current.has(attachment.id)) continue;
        await addNoteAttachment(noteId, {
          kind: attachment.kind,
          name: attachment.name,
          data_url: attachment.dataUrl,
          scene: attachment.scene,
        });
        uploadedAttachmentIdsRef.current.add(attachment.id);
      }

      setLibrarySavedAt(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      return noteId;
    } catch (error) {
      setSyncStatus(
        error instanceof Error
          ? `Could not save to the database: ${error.message}`
          : "Could not save to the database.",
      );
      return "";
    } finally {
      setIsSyncing(false);
    }
  }

  async function exportCurrentNoteToNotion() {
    const noteId = await saveCurrentNoteToLibrary();
    if (!noteId) return;

    setIsSyncing(true);
    setSyncStatus("Exporting to Notion...");
    try {
      const targets = await listNotionTargets();
      const result = await exportNoteToNotion(noteId, {
        target_id: targets.targets[0]?.target_id || "",
      });
      const warning = result.warnings.length ? ` (${result.warnings[0]})` : "";
      setSyncStatus(
        `${result.updated ? "Updated the" : "Created a"} Notion page${warning}.`,
      );
    } catch (error) {
      setSyncStatus(
        error instanceof Error
          ? `Notion export failed: ${error.message}`
          : "Notion export failed.",
      );
    } finally {
      setIsSyncing(false);
    }
  }

  function addAttachment(attachment: Omit<NoteAttachment, "id" | "createdAt">) {
    setAttachments((current) => [
      {
        ...attachment,
        id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        createdAt: new Date().toISOString(),
      },
      ...current,
    ]);
    setMode("notes");
  }

  function removeAttachment(id: string) {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  }

  async function addImageFiles(files: FileList | null) {
    if (!files?.length) return;

    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await blobToDataUrl(file);
      addAttachment({
        kind: "image",
        name: file.name || "Image attachment",
        dataUrl,
      });
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleSketchChange(
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) {
    sketchRef.current = {
      elements,
      appState: {
        ...appState,
        collaborators: undefined,
      },
      files,
    };

    const nextCount = getNonDeletedElements(elements).length;
    setSketchElementCount((current) => current === nextCount ? current : nextCount);

    window.clearTimeout(sketchSaveTimeoutRef.current);
    sketchSaveTimeoutRef.current = window.setTimeout(() => {
      localStorage.setItem(
        noteKey,
        serializeNote(note, attachments, sketchRef.current),
      );
      setSavedAt(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    }, 600);
  }

  async function addSketchToNote() {
    const api = excalidrawApiRef.current;
    if (!api) return;

    const elements = getNonDeletedElements(api.getSceneElements());
    if (elements.length === 0) {
      setSketchStatus("Draw something before adding the sketch to your note.");
      return;
    }

    setSketchStatus("Exporting sketch...");
    try {
      const scene: ExcalidrawScene = {
        elements,
        appState: exportableAppState(api.getAppState()),
        files: api.getFiles(),
      };
      const blob = await exportToBlob({
        elements,
        appState: scene.appState,
        files: scene.files,
        mimeType: "image/png",
        exportPadding: 16,
      });
      const dataUrl = await blobToDataUrl(blob);

      addAttachment({
        kind: "sketch",
        name: `Sketch ${
          attachments.filter((attachment) => attachment.kind === "sketch").length + 1
        }`,
        dataUrl,
        scene,
      });
      setSketchStatus("Added sketch image to note.");
    } catch (error) {
      setSketchStatus(
        error instanceof Error
          ? `Could not export sketch: ${error.message}`
          : "Could not export sketch.",
      );
    }
  }

  function clearSketch() {
    excalidrawApiRef.current?.resetScene();
    const nextSketch = emptyScene();
    sketchRef.current = nextSketch;
    setSketch(nextSketch);
    setSketchElementCount(0);
    setSketchStatus("Sketch cleared.");
  }

  function editSketchAttachment(attachment: NoteAttachment) {
    if (!attachment.scene) return;
    sketchRef.current = attachment.scene;
    setSketch(attachment.scene);
    setSketchElementCount(getNonDeletedElements(attachment.scene.elements).length);
    setMode("sketch");
    window.setTimeout(() => {
      excalidrawApiRef.current?.updateScene({
        elements: attachment.scene?.elements || [],
        appState: attachment.scene?.appState || {},
        collaborators: new Map(),
      });
    }, 100);
  }

  if (!open) {
    return (
      <div className="hidden md:flex h-full w-10 shrink-0 border-r border-border bg-card">
        <button
          type="button"
          title="Open notes"
          onClick={onToggle}
          className="h-full w-full text-muted-foreground hover:bg-secondary hover:text-foreground flex items-start justify-center pt-4"
        >
          <PanelLeftOpen size={15} />
        </button>
      </div>
    );
  }

  return (
    <aside
      className="relative hidden md:flex h-full shrink-0 flex-col border-r border-border bg-card min-h-0"
      style={{ width }}
    >
      <header className="h-12 shrink-0 border-b border-border px-3 flex items-center gap-2">
        <NotebookPen size={15} className="text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">Notes</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {scopeTitle}
          </p>
        </div>
        <button
          type="button"
          title="Collapse notes"
          onClick={onToggle}
          className="h-8 w-8 rounded flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <PanelLeftClose size={15} />
        </button>
      </header>

      <div className="shrink-0 border-b border-border px-3 py-2 flex items-center gap-1">
        {[
          { mode: "notes" as const, label: "Notes", icon: FileText },
          { mode: "sketch" as const, label: "Sketch", icon: PenTool },
        ].map((item) => {
          const Icon = item.icon;
          const active = mode === item.mode;
          return (
            <button
              key={item.mode}
              type="button"
              onClick={() => setMode(item.mode)}
              className={`h-8 rounded px-2 text-xs flex items-center gap-1.5 ${
                active
                  ? "border border-border bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Icon size={13} />
              {item.label}
            </button>
          );
        })}
      </div>

      {mode === "notes" ? (
        <div className="min-h-0 flex-1 flex flex-col">
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Capture claims, questions, paper ideas, and reading notes..."
            className="min-h-0 flex-1 resize-none bg-background px-4 py-4 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="shrink-0 border-t border-border bg-card px-3 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => void addImageFiles(event.target.files)}
              />
              <button
                type="button"
                title="Use note in chat"
                disabled={!note.trim() && attachments.length === 0}
                onClick={pinCurrentNote}
                className="h-8 rounded border border-border px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-35 inline-flex items-center gap-1.5"
              >
                <MessageSquarePlus size={13} />
                Chat
              </button>
              <button
                type="button"
                title="Add image"
                onClick={() => fileInputRef.current?.click()}
                className="h-8 rounded border border-border px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex items-center gap-1.5"
              >
                <ImagePlus size={13} />
                Image
              </button>
              <button
                type="button"
                title="Download note"
                disabled={!note.trim() && attachments.length === 0}
                onClick={() => downloadMarkdown(scopeTitle, note, attachments)}
                className="h-8 rounded border border-border px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-35 inline-flex items-center gap-1.5"
              >
                <Download size={13} />
                MD
              </button>
              <button
                type="button"
                title="Export this note to Notion (saves first)"
                disabled={
                  isSyncing ||
                  (!note.trim() && attachments.length === 0 && sketchElementCount === 0)
                }
                onClick={() => void exportCurrentNoteToNotion()}
                className="h-8 rounded border border-border px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-35 inline-flex items-center gap-1.5"
              >
                <Send size={13} />
                Notion
              </button>
              <button
                type="button"
                title="Save to the research database (Notes tab)"
                disabled={
                  isSyncing ||
                  (!note.trim() && attachments.length === 0 && sketchElementCount === 0)
                }
                onClick={() => void saveCurrentNoteToLibrary()}
                className="ml-auto h-8 rounded border border-border px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-35 inline-flex items-center gap-1.5"
              >
                <Save size={13} />
                Save
              </button>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground">
              {savedAt ? `Draft ${savedAt}` : "Draft autosaved locally"} -{" "}
              {attachments.length} image{attachments.length === 1 ? "" : "s"}
              {librarySavedAt ? ` - saved to Notes ${librarySavedAt}` : ""}
            </p>
            {syncStatus && (
              <p
                className={`font-mono text-[10px] ${
                  syncStatus.includes("failed") || syncStatus.includes("Could not")
                    ? "text-destructive"
                    : "text-muted-foreground"
                }`}
              >
                {syncStatus}
              </p>
            )}
          </div>
          {attachments.length > 0 && (
            <div className="max-h-52 shrink-0 overflow-y-auto border-t border-border bg-card p-3">
              <div className="grid grid-cols-2 gap-2">
                {attachments.map((attachment) => (
                  <article
                    key={attachment.id}
                    className="overflow-hidden rounded border border-border bg-background"
                  >
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.name}
                      className="h-24 w-full object-contain bg-white"
                    />
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {attachment.name}
                      </span>
                      {attachment.kind === "sketch" && attachment.scene && (
                        <button
                          type="button"
                          title="Edit sketch"
                          onClick={() => editSketchAttachment(attachment)}
                          className="h-5 rounded px-1 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        title="Remove image"
                        onClick={() => removeAttachment(attachment.id)}
                        className="h-5 rounded px-1 text-[10px] text-muted-foreground hover:bg-secondary hover:text-destructive"
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 bg-background p-3 flex flex-col gap-3">
          <div className="min-h-0 flex-1 overflow-hidden rounded border border-border bg-white">
            <Excalidraw
              key={noteKey}
              excalidrawAPI={(api) => {
                excalidrawApiRef.current = api;
              }}
              initialData={initialSketchData}
              onChange={handleSketchChange}
              UIOptions={EXCALIDRAW_UI_OPTIONS}
            />
          </div>
          <div className="shrink-0 rounded border border-border bg-card p-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void addSketchToNote()}
                className="h-8 rounded bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5"
              >
                <ImagePlus size={13} />
                Add to note
              </button>
              <button
                type="button"
                onClick={clearSketch}
                className="h-8 rounded border border-border px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                Clear
              </button>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {sketchElementCount} element
                {sketchElementCount === 1 ? "" : "s"}
              </span>
            </div>
            <p
              className={`mt-2 text-[11px] leading-5 ${
                sketchStatus.startsWith("Could not")
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {sketchStatus ||
                "Use Excalidraw tools, images, arrows, text, and shapes. Add to note exports the scene as a PNG attachment while preserving editable scene data."}
            </p>
          </div>
        </div>
      )}

      <button
        type="button"
        title="Resize notes"
        aria-label="Resize notes"
        onPointerDown={onResizeStart}
        className="absolute top-0 right-0 h-full w-2 cursor-col-resize bg-transparent hover:bg-primary/20 active:bg-primary/30"
      />
    </aside>
  );
}

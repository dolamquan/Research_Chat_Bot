export const DEFAULT_FOLDER_ID = "default";

export type SavedNoteAttachment = {
  id: string;
  kind: "image" | "sketch";
  name: string;
  dataUrl: string;
  createdAt: string;
  scene?: unknown;
};

export type SavedNoteFolder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type SavedWorkspaceNote = {
  id: string;
  title: string;
  body: string;
  attachments: SavedNoteAttachment[];
  folderId: string;
  scopeId: string;
  scopeTitle: string;
  sketch?: unknown;
  createdAt: string;
  updatedAt: string;
};

const NOTES_KEY = "researchmind.saved-workspace-notes";
const FOLDERS_KEY = "researchmind.saved-note-folders";

function now(): string {
  return new Date().toISOString();
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadNoteFolders(): SavedNoteFolder[] {
  const folders = readJson<SavedNoteFolder[]>(FOLDERS_KEY, []);
  return [
    {
      id: DEFAULT_FOLDER_ID,
      name: "All notes",
      createdAt: "",
      updatedAt: "",
    },
    ...folders.filter((folder) => folder.id !== DEFAULT_FOLDER_ID),
  ];
}

export function createNoteFolder(name: string): SavedNoteFolder {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Folder name is required");
  }

  const folder: SavedNoteFolder = {
    id: `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: trimmed,
    createdAt: now(),
    updatedAt: now(),
  };

  const folders = loadNoteFolders().filter((item) => item.id !== DEFAULT_FOLDER_ID);
  writeJson(FOLDERS_KEY, [...folders, folder]);
  return folder;
}

export function loadSavedWorkspaceNotes(): SavedWorkspaceNote[] {
  return readJson<SavedWorkspaceNote[]>(NOTES_KEY, []).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function saveWorkspaceNote(
  note: Omit<SavedWorkspaceNote, "createdAt" | "updatedAt"> & {
    createdAt?: string;
    updatedAt?: string;
  },
): SavedWorkspaceNote {
  const current = loadSavedWorkspaceNotes();
  const existing = current.find((item) => item.id === note.id);
  const saved: SavedWorkspaceNote = {
    ...note,
    createdAt: existing?.createdAt || note.createdAt || now(),
    updatedAt: now(),
  };

  writeJson(
    NOTES_KEY,
    [saved, ...current.filter((item) => item.id !== saved.id)],
  );
  return saved;
}

export function deleteWorkspaceNote(noteId: string) {
  writeJson(
    NOTES_KEY,
    loadSavedWorkspaceNotes().filter((note) => note.id !== noteId),
  );
}

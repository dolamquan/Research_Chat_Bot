/**
 * Legacy localStorage workspace-note store.
 *
 * Notes now live on the backend (see the /notes API in api.ts). This module
 * only keeps the legacy types plus a one-time migration that uploads any
 * notes still sitting in localStorage, then marks them migrated so the data
 * survives even if the upload is interrupted (it retries next launch).
 */

import { migrateWorkspaceNotes } from "./api";

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
const MIGRATED_KEY = "researchmind.workspace-notes-migrated";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Upload any legacy localStorage notes to the backend. Safe to call on every
 * app load: it no-ops once migration has succeeded, and the backend skips
 * notes it has already imported (they keep their original ids).
 */
export async function migrateLocalWorkspaceNotes(): Promise<{
  migrated: boolean;
  imported: number;
}> {
  if (localStorage.getItem(MIGRATED_KEY) === "done") {
    return { migrated: false, imported: 0 };
  }

  const legacyNotes = readJson<SavedWorkspaceNote[]>(NOTES_KEY, []);
  const legacyFolders = readJson<SavedNoteFolder[]>(FOLDERS_KEY, []);

  if (legacyNotes.length === 0 && legacyFolders.length === 0) {
    localStorage.setItem(MIGRATED_KEY, "done");
    return { migrated: false, imported: 0 };
  }

  const result = await migrateWorkspaceNotes({
    folders: legacyFolders
      .filter((folder) => folder.id !== DEFAULT_FOLDER_ID)
      .map((folder) => ({ id: folder.id, name: folder.name })),
    notes: legacyNotes.map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      folder_id: note.folderId || DEFAULT_FOLDER_ID,
      scope_id: note.scopeId,
      scope_title: note.scopeTitle,
      sketch: note.sketch,
      created_at: note.createdAt,
      updated_at: note.updatedAt,
      attachments: (note.attachments || []).map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        data_url: attachment.dataUrl,
        scene: attachment.scene,
      })),
    })),
  });

  // Only mark done after the server confirmed the import; the legacy data is
  // kept in place as a backup until the user clears their browser storage.
  localStorage.setItem(MIGRATED_KEY, "done");
  return { migrated: true, imported: result.imported };
}

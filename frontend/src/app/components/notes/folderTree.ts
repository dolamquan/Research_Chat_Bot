import type { NoteFolder } from "../../types";

/** The synthetic "All notes" folder the backend always lists first. */
export const ROOT_ID = "default";

/** Drag payloads: a JSON array of note ids, or a single folder id. */
export const NOTE_DRAG_TYPE = "application/x-zoetrope-notes";
export const FOLDER_DRAG_TYPE = "application/x-zoetrope-folder";

export type FolderNode = {
  folder: NoteFolder;
  children: FolderNode[];
  depth: number;
};

function byName(a: NoteFolder, b: NoteFolder): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function realFolders(folders: NoteFolder[]): NoteFolder[] {
  return folders.filter((folder) => folder.folder_id !== ROOT_ID);
}

/**
 * Each folder's parent as the tree shows it. Stored data can be inconsistent
 * (a parent that no longer exists, or a cycle from a bad move): unknown
 * parents become top-level, and each cycle is broken by lifting its member
 * with the smallest id to the top level so nothing silently disappears.
 */
function effectiveParents(real: NoteFolder[]): Map<string, string> {
  const known = new Set(real.map((folder) => folder.folder_id));
  const parents = new Map<string, string>(
    real.map((folder) => {
      const parent = folder.parent_id || "";
      return [folder.folder_id, parent && known.has(parent) ? parent : ""];
    }),
  );

  const reachable = new Set<string>();
  let frontier = [""];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const [id, parent] of parents) {
      if (frontier.includes(parent) && !reachable.has(id)) {
        reachable.add(id);
        next.push(id);
      }
    }
    frontier = next;
  }

  for (const folder of real) {
    if (reachable.has(folder.folder_id)) continue;
    // Walk up until an id repeats: that is where the cycle starts.
    const path: string[] = [];
    let current: string | undefined = folder.folder_id;
    while (current && !path.includes(current)) {
      path.push(current);
      current = parents.get(current) || undefined;
    }
    if (!current) continue;
    const members = path.slice(path.indexOf(current)).sort();
    parents.set(members[0], "");
    for (const member of path) reachable.add(member);
  }

  return parents;
}

export function buildFolderTree(folders: NoteFolder[]): FolderNode[] {
  const real = realFolders(folders);
  const parents = effectiveParents(real);
  const childrenOf = new Map<string, NoteFolder[]>();
  for (const folder of real) {
    const parent = parents.get(folder.folder_id) ?? "";
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(folder);
    childrenOf.set(parent, siblings);
  }

  const visit = (parent: string, depth: number, seen: Set<string>): FolderNode[] =>
    (childrenOf.get(parent) ?? [])
      .slice()
      .sort(byName)
      .filter((folder) => !seen.has(folder.folder_id))
      .map((folder) => {
        const nextSeen = new Set(seen).add(folder.folder_id);
        return { folder, depth, children: visit(folder.folder_id, depth + 1, nextSeen) };
      });

  return visit("", 0, new Set());
}

/** Direct children of a folder; ROOT_ID (or "") yields the top-level folders. */
export function childFolders(folders: NoteFolder[], folderId: string): NoteFolder[] {
  const real = realFolders(folders);
  const parents = effectiveParents(real);
  const parent = folderId === ROOT_ID ? "" : folderId;
  return real.filter((folder) => (parents.get(folder.folder_id) ?? "") === parent).sort(byName);
}

/** Every folder nested somewhere below `folderId` (not including it). */
export function descendantIds(folders: NoteFolder[], folderId: string): Set<string> {
  const found = new Set<string>();
  let frontier = [folderId === ROOT_ID ? "" : folderId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const folder of realFolders(folders)) {
      if (frontier.includes(folder.parent_id || "") && !found.has(folder.folder_id)) {
        found.add(folder.folder_id);
        next.push(folder.folder_id);
      }
    }
    frontier = next;
  }
  return found;
}

/** Ancestors of a folder from the top level down to and including the folder itself. */
export function folderPath(folders: NoteFolder[], folderId: string): NoteFolder[] {
  if (folderId === ROOT_ID) return [];
  const byId = new Map(realFolders(folders).map((folder) => [folder.folder_id, folder]));
  const path: NoteFolder[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);
  while (current && !seen.has(current.folder_id)) {
    seen.add(current.folder_id);
    path.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

/** Moving a folder under itself or one of its descendants would orphan the subtree. */
export function canMoveFolder(folders: NoteFolder[], folderId: string, targetParentId: string): boolean {
  if (folderId === ROOT_ID) return false;
  const target = targetParentId === ROOT_ID ? "" : targetParentId;
  if (target === folderId) return false;
  if (target && descendantIds(folders, folderId).has(target)) return false;
  const current = folders.find((folder) => folder.folder_id === folderId)?.parent_id || "";
  return target !== current;
}

export type FolderCounts = {
  /** Notes stored directly in each folder (ROOT_ID = every note). */
  direct: Map<string, number>;
  /** Notes in each folder plus all of its subfolders. */
  total: Map<string, number>;
};

export function countNotesByFolder(
  notes: { folder_id: string }[],
  folders: NoteFolder[],
): FolderCounts {
  const direct = new Map<string, number>();
  direct.set(ROOT_ID, notes.length);
  for (const note of notes) {
    if (note.folder_id === ROOT_ID) continue;
    direct.set(note.folder_id, (direct.get(note.folder_id) ?? 0) + 1);
  }
  const total = new Map<string, number>();
  total.set(ROOT_ID, notes.length);
  for (const folder of realFolders(folders)) {
    let sum = direct.get(folder.folder_id) ?? 0;
    for (const child of descendantIds(folders, folder.folder_id)) {
      sum += direct.get(child) ?? 0;
    }
    total.set(folder.folder_id, sum);
  }
  return { direct, total };
}

export function readDraggedNoteIds(dataTransfer: Pick<DataTransfer, "getData"> | null): string[] {
  if (!dataTransfer) return [];
  try {
    const parsed = JSON.parse(dataTransfer.getData(NOTE_DRAG_TYPE) || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

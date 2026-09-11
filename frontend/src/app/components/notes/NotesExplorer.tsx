import { useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";

import type { NoteFolder } from "../../types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  FOLDER_DRAG_TYPE,
  NOTE_DRAG_TYPE,
  ROOT_ID,
  buildFolderTree,
  canMoveFolder,
  descendantIds,
  readDraggedNoteIds,
  type FolderCounts,
  type FolderNode,
} from "./folderTree";

export type NotesExplorerProps = {
  folders: NoteFolder[];
  counts: FolderCounts;
  highlightCount: number;
  activeNode: "workspace" | "pdf";
  activeFolderId: string;
  onSelectFolder: (folderId: string) => void;
  onSelectHighlights: () => void;
  onCreateFolder: (parentId: string) => void;
  onRenameFolder: (folderId: string, name: string) => Promise<void> | void;
  onMoveFolder: (folderId: string, parentId: string) => Promise<void> | void;
  onDeleteFolder: (folderId: string) => Promise<void> | void;
  onDropNotes: (noteIds: string[], folderId: string) => void;
};

const ROW_BASE =
  "group flex h-8 w-full items-center gap-1.5 rounded pr-2 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-foreground/40";

function rowClass(active: boolean, dropping: boolean): string {
  if (dropping) return `${ROW_BASE} bg-foreground/10 text-foreground ring-1 ring-foreground/40`;
  if (active) return `${ROW_BASE} bg-primary/10 text-primary`;
  return `${ROW_BASE} text-muted-foreground hover:bg-secondary hover:text-foreground`;
}

function acceptsDrop(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return types.includes(NOTE_DRAG_TYPE) || types.includes(FOLDER_DRAG_TYPE);
}

export function NotesExplorer({
  folders,
  counts,
  highlightCount,
  activeNode,
  activeFolderId,
  onSelectFolder,
  onSelectHighlights,
  onCreateFolder,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
  onDropNotes,
}: NotesExplorerProps) {
  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const byId = useMemo(() => new Map(folders.map((folder) => [folder.folder_id, folder])), [folders]);
  // Everything starts expanded; the tree is small and collapsing is a click away.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NoteFolder | null>(null);

  function toggle(folderId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function startRename(folder: NoteFolder) {
    setRenaming({ id: folder.folder_id, draft: folder.name });
  }

  function commitRename() {
    if (!renaming) return;
    const { id, draft } = renaming;
    setRenaming(null);
    const name = draft.trim();
    const current = byId.get(id);
    if (!name || !current || name === current.name) return;
    void onRenameFolder(id, name);
  }

  function handleDrop(event: DragEvent, targetId: string) {
    event.preventDefault();
    setDropTarget(null);
    const draggedFolder = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
    if (draggedFolder) {
      if (canMoveFolder(folders, draggedFolder, targetId)) {
        void onMoveFolder(draggedFolder, targetId === ROOT_ID ? "" : targetId);
      }
      return;
    }
    const noteIds = readDraggedNoteIds(event.dataTransfer);
    if (noteIds.length > 0) onDropNotes(noteIds, targetId);
  }

  function dropHandlers(targetId: string) {
    return {
      onDragOver: (event: DragEvent) => {
        if (!acceptsDrop(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropTarget !== targetId) setDropTarget(targetId);
      },
      onDragLeave: () => setDropTarget((current) => (current === targetId ? null : current)),
      onDrop: (event: DragEvent) => handleDrop(event, targetId),
    };
  }

  function handleRowKey(event: KeyboardEvent<HTMLDivElement>, node: FolderNode) {
    const id = node.folder.folder_id;
    if (event.key === "F2") {
      event.preventDefault();
      startRename(node.folder);
    } else if (event.key === "Delete") {
      event.preventDefault();
      setPendingDelete(node.folder);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectFolder(id);
    } else if (event.key === "ArrowRight" && node.children.length > 0 && collapsed.has(id)) {
      event.preventDefault();
      toggle(id);
    } else if (event.key === "ArrowLeft" && node.children.length > 0 && !collapsed.has(id)) {
      event.preventDefault();
      toggle(id);
    }
  }

  function moveTargets(folderId: string): { id: string; label: string; depth: number }[] {
    const blocked = descendantIds(folders, folderId);
    const parent = byId.get(folderId)?.parent_id || "";
    const flatten = (nodes: FolderNode[]): { id: string; label: string; depth: number }[] =>
      nodes.flatMap((node) =>
        node.folder.folder_id === folderId || blocked.has(node.folder.folder_id)
          ? []
          : [{ id: node.folder.folder_id, label: node.folder.name, depth: node.depth + 1 }, ...flatten(node.children)],
      );
    const options = flatten(tree).filter((option) => option.id !== parent);
    return parent ? [{ id: ROOT_ID, label: "Top level", depth: 0 }, ...options] : options;
  }

  function renderNode(node: FolderNode) {
    const { folder, children, depth } = node;
    const id = folder.folder_id;
    const isActive = activeNode === "workspace" && activeFolderId === id;
    const isCollapsed = collapsed.has(id);
    const isRenaming = renaming?.id === id;

    return (
      <div key={id} role="none">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              role="treeitem"
              aria-label={folder.name}
              aria-level={depth + 1}
              aria-selected={isActive}
              aria-expanded={children.length > 0 ? !isCollapsed : undefined}
              tabIndex={0}
              draggable={!isRenaming}
              onDragStart={(event) => {
                event.dataTransfer.setData(FOLDER_DRAG_TYPE, id);
                event.dataTransfer.effectAllowed = "move";
              }}
              {...dropHandlers(id)}
              onClick={() => onSelectFolder(id)}
              onDoubleClick={() => startRename(folder)}
              onKeyDown={(event) => handleRowKey(event, node)}
              style={{ paddingLeft: 4 + depth * 14 }}
              className={rowClass(isActive, dropTarget === id)}
            >
              <button
                type="button"
                tabIndex={-1}
                aria-label={isCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
                disabled={children.length === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(id);
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-0"
              >
                {children.length > 0 &&
                  (isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />)}
              </button>
              {isActive ? (
                <FolderOpen size={14} className="shrink-0" />
              ) : (
                <Folder size={14} className="shrink-0" />
              )}
              {isRenaming ? (
                <input
                  autoFocus
                  aria-label="Folder name"
                  value={renaming.draft}
                  onChange={(event) => setRenaming({ id, draft: event.target.value })}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenaming(null);
                    }
                  }}
                  className="h-6 min-w-0 flex-1 rounded border border-foreground/40 bg-background px-1 text-sm text-foreground outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              )}
              <span className="font-mono text-[10px]" title="Notes in this folder">
                {counts.direct.get(id) ?? 0}
              </span>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={() => onCreateFolder(id)}>
              <FolderPlus size={14} /> New subfolder
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => startRename(folder)}>
              <Pencil size={14} /> Rename
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <CornerLeftUp size={14} className="mr-2" /> Move to
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-72 w-52 overflow-y-auto">
                {moveTargets(id).length === 0 ? (
                  <ContextMenuItem disabled>No other folders</ContextMenuItem>
                ) : (
                  moveTargets(id).map((option) => (
                    <ContextMenuItem
                      key={option.id}
                      onSelect={() => void onMoveFolder(id, option.id === ROOT_ID ? "" : option.id)}
                      style={{ paddingLeft: 8 + option.depth * 10 }}
                    >
                      <Folder size={13} /> {option.label}
                    </ContextMenuItem>
                  ))
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => setPendingDelete(folder)}>
              <Trash2 size={14} /> Delete folder
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {!isCollapsed && children.map(renderNode)}
      </div>
    );
  }

  const rootActive = activeNode === "workspace" && activeFolderId === ROOT_ID;
  const deleteInfo = pendingDelete
    ? {
        notes: counts.total.get(pendingDelete.folder_id) ?? 0,
        subfolders: descendantIds(folders, pendingDelete.folder_id).size,
        destination: pendingDelete.parent_id
          ? byId.get(pendingDelete.parent_id)?.name ?? "the parent folder"
          : "All workspace notes",
      }
    : null;

  return (
    <aside className="min-h-[520px] rounded border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FolderOpen size={15} className="shrink-0 text-primary" />
          <h3 className="truncate text-sm font-semibold text-foreground">Notes explorer</h3>
        </div>
        <button
          type="button"
          title={
            activeNode === "workspace" && activeFolderId !== ROOT_ID
              ? "New folder inside the selected folder"
              : "New folder"
          }
          onClick={() => onCreateFolder(activeNode === "workspace" ? activeFolderId : ROOT_ID)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <FolderPlus size={14} />
        </button>
      </div>

      <div className="p-2" role="tree" aria-label="Note folders">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              role="treeitem"
              aria-level={1}
              aria-selected={rootActive}
              tabIndex={0}
              {...dropHandlers(ROOT_ID)}
              onClick={() => onSelectFolder(ROOT_ID)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectFolder(ROOT_ID);
                }
              }}
              className={`${rowClass(rootActive, dropTarget === ROOT_ID)} h-9 pl-2`}
            >
              <FolderOpen size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">All workspace notes</span>
              <span className="font-mono text-[10px]">{counts.direct.get(ROOT_ID) ?? 0}</span>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={() => onCreateFolder(ROOT_ID)}>
              <FolderPlus size={14} /> New folder
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        <div className="mt-1 space-y-0.5 border-l border-border/80 pl-2">
          {tree.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No folders yet. Right-click or use + to create one; drag notes onto folders to file them.
            </p>
          ) : (
            tree.map(renderNode)
          )}
        </div>

        <button
          type="button"
          onClick={onSelectHighlights}
          className={`mt-3 flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm ${
            activeNode === "pdf"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <FileText size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">PDF highlights</span>
          <span className="font-mono text-[10px]">{highlightCount}</span>
        </button>

        <p className="mt-4 px-2 text-[11px] leading-5 text-muted-foreground">
          Drag notes or folders to move them. Right-click a folder for more; F2 renames, Delete removes.
        </p>
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{pendingDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteInfo && (
                <>
                  {deleteInfo.notes} note{deleteInfo.notes === 1 ? "" : "s"} and{" "}
                  {deleteInfo.subfolders} subfolder{deleteInfo.subfolders === 1 ? "" : "s"} inside it
                  move to {deleteInfo.destination}. No notes are deleted.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) void onDeleteFolder(target.folder_id);
              }}
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

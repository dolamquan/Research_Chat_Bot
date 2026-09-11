import { describe, expect, it } from "vitest";

import type { NoteFolder } from "../../types";
import {
  ROOT_ID,
  buildFolderTree,
  canMoveFolder,
  childFolders,
  countNotesByFolder,
  descendantIds,
  folderPath,
  readDraggedNoteIds,
  NOTE_DRAG_TYPE,
} from "./folderTree";

function folder(id: string, name: string, parent = ""): NoteFolder {
  return { folder_id: id, name, parent_id: parent, created_at: "", updated_at: "" };
}

const folders: NoteFolder[] = [
  folder(ROOT_ID, "All notes"),
  folder("papers", "Papers"),
  folder("rag", "RAG", "papers"),
  folder("graph", "Graph RAG", "rag"),
  folder("misc", "misc"),
  folder("lost", "Lost", "gone"),
];

describe("folder tree", () => {
  it("nests folders, sorts siblings by name and adopts orphans at the top level", () => {
    const tree = buildFolderTree(folders);
    expect(tree.map((node) => node.folder.name)).toEqual(["Lost", "misc", "Papers"]);
    const papers = tree[2];
    expect(papers.children.map((node) => node.folder.folder_id)).toEqual(["rag"]);
    expect(papers.children[0].children[0].folder.folder_id).toBe("graph");
    expect(papers.children[0].children[0].depth).toBe(2);
  });

  it("breaks a parent cycle instead of hiding the folders", () => {
    const cyclic = [folder("b", "B", "a"), folder("a", "A", "b"), folder("c", "C", "b")];
    const tree = buildFolderTree(cyclic);
    expect(tree.map((node) => node.folder.folder_id)).toEqual(["a"]);
    expect(tree[0].children.map((node) => node.folder.folder_id)).toEqual(["b"]);
    expect(tree[0].children[0].children.map((node) => node.folder.folder_id)).toEqual(["c"]);
    expect(childFolders(cyclic, ROOT_ID).map((f) => f.folder_id)).toEqual(["a"]);
    expect(folderPath(cyclic, "a").map((f) => f.folder_id)).toEqual(["b", "a"]);
  });

  it("lists direct children, descendants and paths", () => {
    expect(childFolders(folders, ROOT_ID).map((f) => f.folder_id)).toEqual(["lost", "misc", "papers"]);
    expect(childFolders(folders, "papers").map((f) => f.folder_id)).toEqual(["rag"]);
    expect([...descendantIds(folders, "papers")].sort()).toEqual(["graph", "rag"]);
    expect(descendantIds(folders, "graph").size).toBe(0);
    expect(folderPath(folders, "graph").map((f) => f.name)).toEqual(["Papers", "RAG", "Graph RAG"]);
    expect(folderPath(folders, ROOT_ID)).toEqual([]);
  });

  it("refuses moves that would create cycles or change nothing", () => {
    expect(canMoveFolder(folders, "papers", "rag")).toBe(false);
    expect(canMoveFolder(folders, "papers", "graph")).toBe(false);
    expect(canMoveFolder(folders, "papers", "papers")).toBe(false);
    expect(canMoveFolder(folders, "papers", ROOT_ID)).toBe(false); // already top level
    expect(canMoveFolder(folders, "graph", "papers")).toBe(true);
    expect(canMoveFolder(folders, "graph", ROOT_ID)).toBe(true);
    expect(canMoveFolder(folders, ROOT_ID, "papers")).toBe(false);
  });

  it("counts notes directly and including subfolders", () => {
    const notes = [
      { folder_id: ROOT_ID },
      { folder_id: "papers" },
      { folder_id: "rag" },
      { folder_id: "graph" },
      { folder_id: "graph" },
    ];
    const counts = countNotesByFolder(notes, folders);
    expect(counts.direct.get(ROOT_ID)).toBe(5);
    expect(counts.direct.get("papers")).toBe(1);
    expect(counts.total.get("papers")).toBe(4);
    expect(counts.total.get("rag")).toBe(3);
    expect(counts.total.get("misc")).toBe(0);
  });

  it("reads dragged note ids defensively", () => {
    expect(readDraggedNoteIds({ getData: () => JSON.stringify(["a", "b", 3]) })).toEqual(["a", "b"]);
    expect(readDraggedNoteIds({ getData: () => "not json" })).toEqual([]);
    expect(readDraggedNoteIds({ getData: (type) => (type === NOTE_DRAG_TYPE ? "" : "x") })).toEqual([]);
    expect(readDraggedNoteIds(null)).toEqual([]);
  });
});

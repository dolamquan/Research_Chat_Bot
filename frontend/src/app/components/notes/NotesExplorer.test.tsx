import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { NoteFolder } from "../../types";
import { FOLDER_DRAG_TYPE, NOTE_DRAG_TYPE, ROOT_ID, countNotesByFolder } from "./folderTree";
import { NotesExplorer, type NotesExplorerProps } from "./NotesExplorer";

beforeAll(() => {
  // Radix positions menus with ResizeObserver, which jsdom lacks.
  if (!("ResizeObserver" in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
  }
});

afterEach(cleanup);

function folder(id: string, name: string, parent = ""): NoteFolder {
  return { folder_id: id, name, parent_id: parent, created_at: "", updated_at: "" };
}

const folders = [
  folder(ROOT_ID, "All notes"),
  folder("papers", "Papers"),
  folder("rag", "RAG", "papers"),
  folder("misc", "Misc"),
];
const notes = [{ folder_id: "papers" }, { folder_id: "rag" }, { folder_id: "rag" }, { folder_id: ROOT_ID }];

function setup(overrides: Partial<NotesExplorerProps> = {}) {
  const props: NotesExplorerProps = {
    folders,
    counts: countNotesByFolder(notes, folders),
    highlightCount: 2,
    activeNode: "workspace",
    activeFolderId: ROOT_ID,
    onSelectFolder: vi.fn(),
    onSelectHighlights: vi.fn(),
    onCreateFolder: vi.fn(),
    onRenameFolder: vi.fn(),
    onMoveFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onDropNotes: vi.fn(),
    ...overrides,
  };
  const utils = render(<NotesExplorer {...props} />);
  return { props, ...utils };
}

function dataTransfer(entries: Record<string, string>) {
  return {
    types: Object.keys(entries),
    getData: (type: string) => entries[type] ?? "",
    setData: vi.fn(),
    dropEffect: "none",
    effectAllowed: "all",
  };
}

describe("NotesExplorer", () => {
  it("renders the nested tree with direct note counts and collapses subtrees", () => {
    setup();
    const papers = screen.getByRole("treeitem", { name: "Papers" });
    expect(papers).toHaveAttribute("aria-expanded", "true");
    expect(within(papers).getByTitle("Notes in this folder")).toHaveTextContent("1");
    expect(screen.getByRole("treeitem", { name: "RAG" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Papers" }));
    expect(screen.queryByRole("treeitem", { name: "RAG" })).toBeNull();
    expect(papers).toHaveAttribute("aria-expanded", "false");
  });

  it("selects folders and creates a subfolder under the selection", () => {
    const { props } = setup({ activeFolderId: "papers" });
    fireEvent.click(screen.getByRole("treeitem", { name: "RAG" }));
    expect(props.onSelectFolder).toHaveBeenCalledWith("rag");
    fireEvent.click(screen.getByTitle("New folder inside the selected folder"));
    expect(props.onCreateFolder).toHaveBeenCalledWith("papers");
  });

  it("renames inline with F2 and Enter, and cancels with Escape", () => {
    const { props } = setup();
    const misc = screen.getByRole("treeitem", { name: "Misc" });
    fireEvent.keyDown(misc, { key: "F2" });
    const input = screen.getByLabelText("Folder name");
    fireEvent.change(input, { target: { value: "  Miscellany " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRenameFolder).toHaveBeenCalledWith("misc", "Miscellany");

    fireEvent.keyDown(misc, { key: "F2" });
    fireEvent.keyDown(screen.getByLabelText("Folder name"), { key: "Escape" });
    expect(screen.queryByLabelText("Folder name")).toBeNull();
    expect(props.onRenameFolder).toHaveBeenCalledTimes(1);
  });

  it("asks before deleting and explains where the contents go", () => {
    const { props } = setup();
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "Papers" }), { key: "Delete" });
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "3 notes and 1 subfolder inside it move to All workspace notes",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    expect(props.onDeleteFolder).toHaveBeenCalledWith("papers");
  });

  it("files dragged notes and re-parents dragged folders, refusing cycles", () => {
    const { props } = setup();
    const rag = screen.getByRole("treeitem", { name: "RAG" });
    fireEvent.drop(rag, { dataTransfer: dataTransfer({ [NOTE_DRAG_TYPE]: JSON.stringify(["n1", "n2"]) }) });
    expect(props.onDropNotes).toHaveBeenCalledWith(["n1", "n2"], "rag");

    fireEvent.drop(screen.getByRole("treeitem", { name: "Misc" }), {
      dataTransfer: dataTransfer({ [FOLDER_DRAG_TYPE]: "rag" }),
    });
    expect(props.onMoveFolder).toHaveBeenCalledWith("rag", "misc");

    fireEvent.drop(rag, { dataTransfer: dataTransfer({ [FOLDER_DRAG_TYPE]: "papers" }) });
    expect(props.onMoveFolder).toHaveBeenCalledTimes(1);

    fireEvent.drop(screen.getByRole("treeitem", { name: /All workspace notes/ }), {
      dataTransfer: dataTransfer({ [FOLDER_DRAG_TYPE]: "rag" }),
    });
    expect(props.onMoveFolder).toHaveBeenLastCalledWith("rag", "");
  });

  it("offers folder actions in a context menu", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Misc" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New subfolder/ }));
    expect(props.onCreateFolder).toHaveBeenCalledWith("misc");
  });
});

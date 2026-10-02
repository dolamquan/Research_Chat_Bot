import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceNotesPane } from "./WorkspaceNotesPane";
import * as api from "../api";
import { renderSketch } from "../sketchExport";

vi.mock("../api", () => ({
  addNoteAttachment: vi.fn(), createNote: vi.fn(), listNotes: vi.fn(), updateNote: vi.fn(),
  deleteNoteAttachment: vi.fn(), exportNoteToNotion: vi.fn(), listNotionTargets: vi.fn(),
}));
vi.mock("../sketchExport", async importOriginal => ({
  ...await importOriginal<typeof import("../sketchExport")>(), renderSketch: vi.fn(),
}));
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => <div>Drawing canvas</div>, exportToBlob: vi.fn(),
  getNonDeletedElements: (elements: any[]) => elements.filter(e => !e.isDeleted), THEME: { LIGHT: "light" },
}));
vi.mock("./notes", () => ({ NoteEditor: ({ value }: { value: string }) => <pre aria-label="Note document">{value}</pre> }));
let uiActions: Record<string, (...args: any[]) => any> = {};
vi.mock("../assistant", () => ({
  useRegisterUiActions: (actions: Record<string, (...args: any[]) => any>) => { uiActions = actions; },
}));

const picture = { id: "local-picture", kind: "image", name: "Photo.png", dataUrl: "data:image/png;base64,cGhvdG8=", createdAt: "today" };
const scene = { elements: [{ id: "box", type: "rectangle", isDeleted: false }], files: {}, appState: {} };
const saved = { note_id: "saved-note", attachments: [] };
function mount(attachments = [picture], sketch: unknown = undefined, body = "My note", onOpen = () => {}) {
  localStorage.setItem("researchmind.workspace-note:paper", JSON.stringify({ body, attachments, sketch }));
  return render(<WorkspaceNotesPane open width={400} scopeId="paper" scopeTitle="Paper" onToggle={() => {}} onOpen={onOpen} onResizeStart={() => {}} onPinNote={() => {}} />);
}
const noteText = () => screen.getAllByLabelText("Note document")[0].textContent;
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(api.listNotes).mockResolvedValue({ notes: [saved] } as any);
  vi.mocked(api.updateNote).mockResolvedValue({ note: saved } as any);
  vi.mocked(api.addNoteAttachment).mockResolvedValue({ attachment: { attachment_id: "server-image" } });
  vi.mocked(api.listNotionTargets).mockResolvedValue({ targets: [] });
  vi.mocked(api.exportNoteToNotion).mockResolvedValue({ warnings: [], updated: false } as any);
  vi.mocked(renderSketch).mockResolvedValue("data:image/png;base64,c2tldGNo");
});
afterEach(cleanup);

it("uploads a local picture when reopening an existing note instead of assuming it was uploaded", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Notion" }));
  await waitFor(() => expect(api.exportNoteToNotion).toHaveBeenCalledWith("saved-note", { target_id: "" }));
  expect(api.createNote).not.toHaveBeenCalled();
  expect(api.addNoteAttachment).toHaveBeenCalledWith("saved-note", expect.objectContaining({ client_id: picture.id, data_url: picture.dataUrl }));
});

it("saves the current sketch as a PNG without requiring Add to note", async () => {
  mount([], scene);
  fireEvent.click(screen.getByRole("button", { name: "Notion" }));
  await waitFor(() => expect(api.exportNoteToNotion).toHaveBeenCalled());
  expect(renderSketch).toHaveBeenCalledWith(scene);
  expect(api.addNoteAttachment).toHaveBeenCalledWith("saved-note", expect.objectContaining({ client_id: "workspace-canvas", kind: "sketch", data_url: "data:image/png;base64,c2tldGNo", scene }));
});

it("does not rerender or upload a confirmed unchanged sketch on another save", async () => {
  mount([], scene);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.addNoteAttachment).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(2));
  expect(renderSketch).toHaveBeenCalledTimes(1);
  expect(api.addNoteAttachment).toHaveBeenCalledTimes(1);
});

it("stops Notion export when an image cannot be saved and retries that image", async () => {
  vi.mocked(api.addNoteAttachment).mockRejectedValueOnce(new Error("Upload interrupted"));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Notion" }));
  await screen.findByText(/Could not save to the database: Upload interrupted/);
  expect(api.exportNoteToNotion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Notion" }));
  await waitFor(() => expect(api.exportNoteToNotion).toHaveBeenCalled());
  expect(api.addNoteAttachment).toHaveBeenCalledTimes(2);
});

it("does not export an incomplete sketch when a picture is missing", async () => {
  vi.mocked(renderSketch).mockRejectedValueOnce(new Error("A picture in this sketch is missing"));
  mount([], scene);
  fireEvent.click(screen.getByRole("button", { name: "Notion" }));
  await screen.findByText(/A picture in this sketch is missing/);
  expect(api.exportNoteToNotion).not.toHaveBeenCalled();
  expect(api.updateNote).not.toHaveBeenCalled();
});

it("shows a note the assistant writes in the side panel right away and saves it", async () => {
  const onOpen = vi.fn();
  mount([], undefined, "My note", onOpen);

  const result = await act(() => uiActions["workspaceNotes.append"]({ title: "Ideas", body: "- one" }));

  expect(noteText()).toBe("My note\n\n## Ideas\n\n- one");
  expect(onOpen).toHaveBeenCalled();
  expect(api.updateNote).toHaveBeenCalledWith("saved-note", expect.objectContaining({ body_md: "My note\n\n## Ideas\n\n- one" }));
  expect(result).toEqual({ note_id: "saved-note", saved: true });
});

it("keeps both notes when the assistant writes twice before a re-render", async () => {
  mount([], undefined, "");
  await act(async () => {
    await Promise.all([
      uiActions["workspaceNotes.append"]({ title: "One", body: "first" }),
      uiActions["workspaceNotes.append"]({ title: "Two", body: "second" }),
    ]);
  });
  expect(noteText()).toBe("## One\n\nfirst\n\n## Two\n\nsecond");
  expect(vi.mocked(api.updateNote).mock.calls.at(-1)?.[1]).toEqual(
    expect.objectContaining({ body_md: "## One\n\nfirst\n\n## Two\n\nsecond" }),
  );
});

it("ignores a refresh reply that started before the assistant appended a note", async () => {
  mount([], undefined, "");
  let answerStaleRefresh: (value: unknown) => void = () => {};
  vi.mocked(api.listNotes).mockImplementationOnce(() => new Promise(resolve => { answerStaleRefresh = resolve; }) as any);
  let refreshing: Promise<unknown> = Promise.resolve();
  act(() => { refreshing = uiActions["workspaceNotes.refresh"](); });

  await act(() => uiActions["workspaceNotes.append"]({ title: "Ideas", body: "- one" }));
  await act(async () => {
    answerStaleRefresh({ notes: [{ ...saved, body_md: "Old server text" }] });
    await refreshing;
  });

  expect(noteText()).toBe("## Ideas\n\n- one");
});

it("pulls in assistant edits to the panel note when there is no unsaved local draft", async () => {
  vi.mocked(api.listNotes).mockResolvedValue({ notes: [{ ...saved, body_md: "Edited by the assistant" }] } as any);
  mount([], undefined, "");
  await act(() => uiActions["workspaceNotes.refresh"]());
  expect(noteText()).toBe("Edited by the assistant");
});

it("never overwrites unsaved local typing with a server refresh", async () => {
  vi.mocked(api.listNotes).mockResolvedValue({ notes: [{ ...saved, body_md: "Edited by the assistant" }] } as any);
  mount([], undefined, "Typed but not saved");
  await act(() => uiActions["workspaceNotes.refresh"]());
  expect(noteText()).toBe("Typed but not saved");
});

it("preserves server images from another browser that are absent from the local draft", async () => {
  vi.mocked(api.updateNote).mockResolvedValue({ note: { ...saved, attachments: [{ attachment_id: "remote", client_id: "remote-photo" }] } } as any);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Notion" }));
  await waitFor(() => expect(api.exportNoteToNotion).toHaveBeenCalled());
  expect(api.deleteNoteAttachment).not.toHaveBeenCalled();
});

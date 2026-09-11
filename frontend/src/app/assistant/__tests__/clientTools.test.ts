import { describe, expect, it, vi } from "vitest";

import { CLIENT_TOOL_SPECS, createClientToolDispatcher } from "../clientTools";
import { createUiActionRegistry, createWorkspaceStore } from "../uiActionRegistry";

const papers = [
  { article_id: "a1", title: "Graph RAG for Science", source: "graph.pdf" },
  { article_id: "a2", title: "Graph Neural Networks", source: "gnn.pdf" },
];

function setup() {
  const registry = createUiActionRegistry();
  const workspace = createWorkspaceStore({ active_view: "chat" });
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, args]);
    return { done: name };
  };
  registry.register({
    navigateToView: record("navigateToView"),
    openArticle: record("openArticle"),
    openSource: record("openSource"),
    setReaderPage: record("setReaderPage"),
    setLibraryFilter: record("setLibraryFilter"),
    pinSource: record("pinSource"),
    describeScreen: () => "Chat view, all papers",
    resolveArticle: (ref: { article_id?: string; source?: string; title?: string }) => {
      if (ref.article_id) return papers.find((p) => p.article_id === ref.article_id);
      if (ref.source) return papers.find((p) => p.source === ref.source);
      const hits = papers.filter((p) => p.title.toLowerCase().includes(String(ref.title ?? "").toLowerCase()));
      return hits.length === 1 ? hits[0] : hits.length ? hits : undefined;
    },
  });
  const createNote = vi.fn(async (payload: { title?: string }) => ({ note: { note_id: "n-new", title: payload.title ?? "" } }));
  const dispatch = createClientToolDispatcher(registry, workspace, { createNote, timeoutMs: 200 });
  return { registry, workspace, calls, dispatch, createNote };
}

describe("client tool dispatcher", () => {
  it("declares every spec with an object schema", () => {
    for (const spec of CLIENT_TOOL_SPECS) {
      expect(spec.input_schema.type).toBe("object");
      expect(["read", "write"]).toContain(spec.effect);
    }
  });

  it("rejects unknown tools and missing arguments", async () => {
    const { dispatch } = setup();
    expect(await dispatch("teleport", {})).toEqual({ ok: false, error: 'Unknown screen control "teleport"' });
    const missing = await dispatch("open_note", {});
    expect(missing.ok).toBe(false);
    expect((missing as { error: string }).error).toMatch(/note_id/);
  });

  it("opens papers by id, source or title and reports ambiguity", async () => {
    const { dispatch, calls } = setup();
    expect(await dispatch("open_paper", { article_id: "a1" })).toMatchObject({ ok: true, result: { article_id: "a1" } });
    expect(await dispatch("open_paper", { source: "gnn.pdf" })).toMatchObject({ ok: true, result: { title: "Graph Neural Networks" } });
    expect(calls.filter(([name]) => name === "openArticle")).toHaveLength(2);
    const ambiguous = await dispatch("open_paper", { title: "graph" });
    expect(ambiguous.ok).toBe(false);
    expect((ambiguous as { candidates?: unknown[] }).candidates).toHaveLength(2);
    expect(await dispatch("open_paper", { title: "diffusion" })).toMatchObject({ ok: false });
  });

  it("navigates then waits for the notes view before opening a note", async () => {
    const { dispatch, registry, calls } = setup();
    const pending = dispatch("open_note", { note_id: "n1" });
    await Promise.resolve();
    registry.register({ "notes.openNote": (id: string) => ({ opened: id }) });
    expect(await pending).toEqual({ ok: true, result: { opened: "n1" } });
    expect(calls[0]).toEqual(["navigateToView", ["notes"]]);
  });

  it("times out when the target view never mounts", async () => {
    const { dispatch } = setup();
    const result = await dispatch("start_visualization", { article_id: "a1" });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/longer than|did not open/);
  });

  it("creates notes through the api and refreshes the notes view", async () => {
    const { dispatch, registry, createNote } = setup();
    const refresh = vi.fn();
    registry.register({ "notes.refresh": refresh });
    const result = await dispatch("create_note", { title: "Ideas", body: "- one" });
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ title: "Ideas", body_md: "- one", source_type: "assistant" }));
    expect(refresh).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, result: { created: true, note_id: "n-new", title: "Ideas" } });
  });

  it("passes filters through and describes the screen", async () => {
    const { dispatch, calls, workspace } = setup();
    await dispatch("set_library_filter", { domain: "research", search: "graph" });
    expect(calls.at(-1)).toEqual(["setLibraryFilter", [{ domain: "research", category: undefined, search: "graph", openLibrary: true }]]);
    const screen = await dispatch("read_screen", {});
    expect(screen).toEqual({ ok: true, result: { summary: "Chat view, all papers", workspace: workspace.snapshot() } });
    const pages = await dispatch("open_pdf_page", { page: 0 });
    expect(pages.ok).toBe(false);
    await dispatch("open_pdf_page", { page: 4, source: "graph.pdf" });
    expect(calls.at(-1)).toEqual(["openSource", [{ source: "graph.pdf", page: 4 }]]);
  });

  it("runs one tool at a time", async () => {
    const { dispatch, registry } = setup();
    const order: string[] = [];
    registry.register({
      navigateToView: async (view: string) => {
        order.push(`start ${view}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`end ${view}`);
      },
    });
    await Promise.all([dispatch("navigate_to_view", { view: "notes" }), dispatch("navigate_to_view", { view: "library" })]);
    expect(order).toEqual(["start notes", "end notes", "start library", "end library"]);
  });
});

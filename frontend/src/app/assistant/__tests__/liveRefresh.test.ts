import { describe, expect, it, vi } from "vitest";

import { LIVE_REFRESH, refreshActionsFor, runLiveRefresh } from "../liveRefresh";
import { createUiActionRegistry } from "../uiActionRegistry";

describe("refreshActionsFor", () => {
  it("refreshes the reader and notes after the agent saves a highlight", () => {
    expect(refreshActionsFor({ tool: "api.annotations.save_annotation", status: "success", effect: "write" })).toEqual([
      LIVE_REFRESH.annotations,
      LIVE_REFRESH.notes,
    ]);
  });

  it("refreshes every notes surface after a note write, including deletes", () => {
    const expected = [LIVE_REFRESH.notes, LIVE_REFRESH.workspaceNote, LIVE_REFRESH.annotations];
    expect(refreshActionsFor({ tool: "api.notes.update_note", status: "success", effect: "write" })).toEqual(expected);
    expect(refreshActionsFor({ tool: "api.notes.delete_note", status: "success", effect: "destructive" })).toEqual(expected);
  });

  it("ignores reads, failures, skipped confirmations and unrelated tools", () => {
    expect(refreshActionsFor({ tool: "api.notes.list_notes", status: "success", effect: "read" })).toEqual([]);
    expect(refreshActionsFor({ tool: "api.notes.create_note", status: "error", effect: "write" })).toEqual([]);
    expect(refreshActionsFor({ tool: "api.notes.create_note", status: "skipped", effect: "write" })).toEqual([]);
    expect(refreshActionsFor({ tool: "api.papers.update_paper", status: "success", effect: "write" })).toEqual([]);
    expect(refreshActionsFor({ tool: "ui.create_note", status: "success", effect: "write" })).toEqual([]);
  });
});

describe("runLiveRefresh", () => {
  it("calls only the views that are mounted and survives a failing one", async () => {
    const registry = createUiActionRegistry();
    const notes = vi.fn();
    const reader = vi.fn(() => Promise.reject(new Error("offline")));
    registry.register({ [LIVE_REFRESH.notes]: notes, [LIVE_REFRESH.annotations]: reader });

    await runLiveRefresh(registry, [LIVE_REFRESH.annotations, LIVE_REFRESH.notes, LIVE_REFRESH.workspaceNote]);

    expect(reader).toHaveBeenCalledTimes(1);
    expect(notes).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUiActionRegistry, createWorkspaceStore } from "../uiActionRegistry";

describe("createUiActionRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges by key and unregisters only its own entries", () => {
    const registry = createUiActionRegistry();
    const a = () => "a";
    const b = () => "b";
    const stopA = registry.register({ open: a, close: a });
    registry.register({ close: b });
    expect(registry.get("close")).toBe(b);
    stopA();
    expect(registry.has("open")).toBe(false);
    expect(registry.get("close")).toBe(b);
    expect(registry.names()).toEqual(["close"]);
  });

  it("waitFor resolves when a later view registers and rejects on timeout", async () => {
    const registry = createUiActionRegistry();
    const pending = registry.waitFor("notes.openNote", 1000);
    const open = () => "opened";
    registry.register({ "notes.openNote": open });
    await expect(pending).resolves.toBe(open);

    const late = registry.waitFor("never", 500);
    const assertion = expect(late).rejects.toThrow(/did not open in time/);
    vi.advanceTimersByTime(600);
    await assertion;
  });
});

describe("createWorkspaceStore", () => {
  it("merges partial snapshots, clears with null and notifies on change only", () => {
    const store = createWorkspaceStore();
    const seen: unknown[] = [];
    store.subscribe((ws) => seen.push(ws));
    store.publish({ active_view: "chat", library_search: "graph" });
    store.publish({ active_view: "chat" });
    expect(seen).toHaveLength(1);
    store.publish({ library_search: null, open_note: { id: "n1", title: "x" } });
    expect(store.snapshot()).toEqual({ active_view: "chat", open_note: { id: "n1", title: "x" } });
    expect(seen).toHaveLength(2);
  });
});

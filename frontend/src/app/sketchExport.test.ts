import { afterEach, expect, it, vi } from "vitest";
import { exportNoteToNotion } from "./api";
import { hasSketch, renderSketch, sketchFingerprint, type SketchScene } from "./sketchExport";

vi.mock("@excalidraw/excalidraw", () => ({ exportToBlob: vi.fn(async () => new Blob(["png-data"], { type: "image/png" })) }));
const scene = { elements: [{ id: "box", type: "rectangle" }], files: {}, appState: {} } as SketchScene;
afterEach(() => vi.unstubAllGlobals());

it("ignores deleted elements and navigation when comparing a saved snapshot", () => {
  expect(hasSketch({ elements: [{ isDeleted: true }] })).toBe(false);
  expect(sketchFingerprint(scene)).toBe(sketchFingerprint({ ...scene, appState: { zoom: { value: 2 } as any, scrollX: 900 } }));
  expect(sketchFingerprint(scene)).toBe(sketchFingerprint({ ...scene, elements: [{ type: "rectangle", id: "box" }] as any }));
});

it("rejects embedded pictures with missing binary files before rendering", async () => {
  await expect(renderSketch({ ...scene, elements: [{ type: "image", fileId: "missing" }] as any })).rejects.toThrow("picture in this sketch is missing");
});

it("repairs an older sketch-only library note before requesting its Notion export", async () => {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => calls.length === 1 ? { note: { sketch: scene, attachments: [] } } : {} };
  }));
  await exportNoteToNotion("old-note");
  expect(calls.map(call => call.url)).toEqual(["/api/notes/old-note", "/api/notes/old-note/attachments", "/api/notes/old-note/export-notion"]);
  expect(calls[1].body).toMatchObject({ kind: "sketch", client_id: "workspace-canvas", scene });
  expect(calls[1].body.data_url).toMatch(/^data:image\/png;base64,/);
});

it("reuses an existing matching sketch snapshot in the library", async () => {
  const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("/scene") ? { scene } : url.endsWith("/note") ? { note: { sketch: scene, attachments: [{ attachment_id: "snapshot", has_scene: true }] } } : {} }));
  vi.stubGlobal("fetch", fetchMock);
  await exportNoteToNotion("note");
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/api/notes/note", "/api/notes/attachments/snapshot/scene", "/api/notes/note/export-notion"]);
});

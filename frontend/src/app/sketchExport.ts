import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type SketchScene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

export const CANVAS_ATTACHMENT_ID = "workspace-canvas";

export function hasSketch(scene: unknown): scene is SketchScene {
  return !!scene && Array.isArray((scene as SketchScene).elements)
    && (scene as SketchScene).elements.some(element => !element.isDeleted);
}

// Ignore selection, pan and zoom: those do not change the exported drawing.
export function sketchFingerprint(scene: SketchScene): string {
  return JSON.stringify([
    scene.elements.filter(element => !element.isDeleted),
    scene.appState?.viewBackgroundColor || "#ffffff",
    Object.entries(scene.files || {}).sort(([a], [b]) => a.localeCompare(b)),
  ], (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value);
}

export async function renderSketch(scene: SketchScene): Promise<string> {
  const elements = scene.elements.filter(element => !element.isDeleted);
  for (const element of elements) {
    if (element.type === "image" && (!element.fileId || !scene.files?.[element.fileId])) {
      throw new Error("A picture in this sketch is missing. Reinsert it in the sketch before exporting.");
    }
  }
  const { exportToBlob } = await import("@excalidraw/excalidraw");
  const blob = await exportToBlob({
    elements,
    appState: { ...scene.appState, exportBackground: true, viewBackgroundColor: scene.appState?.viewBackgroundColor || "#ffffff" },
    files: scene.files || {},
    mimeType: "image/png",
    exportPadding: 24,
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Could not read sketch image"));
    reader.readAsDataURL(blob);
  });
}

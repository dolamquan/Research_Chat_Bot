/**
 * When the agent changes data through the API, ask the mounted views that show
 * that data to reload it, so the change appears without a page refresh.
 */
import type { UiActionRegistry } from "./uiActionRegistry";

export const LIVE_REFRESH = {
  annotations: "reader.refreshAnnotations",
  notes: "notes.refresh",
  workspaceNote: "workspaceNotes.refresh",
} as const;

type ToolOutcome = { tool: string; status: string; effect?: string };

export function refreshActionsFor({ tool, status, effect }: ToolOutcome): string[] {
  if (status !== "success" || !effect || effect === "read") return [];
  if (tool.startsWith("api.annotations.")) return [LIVE_REFRESH.annotations, LIVE_REFRESH.notes];
  // Highlights are stored as notes, so note writes can change the reader too.
  if (tool.startsWith("api.notes.")) return [LIVE_REFRESH.notes, LIVE_REFRESH.workspaceNote, LIVE_REFRESH.annotations];
  return [];
}

export async function runLiveRefresh(registry: UiActionRegistry, names: string[]): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      const action = registry.get(name);
      if (!action) return;
      try {
        await action();
      } catch {
        // A view that cannot reload keeps its current data; the next load catches up.
      }
    }),
  );
}

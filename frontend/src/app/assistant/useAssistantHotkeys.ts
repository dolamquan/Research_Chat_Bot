import { useEffect } from "react";

const EDITABLE = 'input, textarea, select, [contenteditable="true"], .ProseMirror, .excalidraw, .tiptap';

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(EDITABLE));
}

export type HotkeyHandlers = {
  pushToTalk: () => void;
  togglePanel: () => void;
  escape: () => boolean;
};

/**
 * Ctrl+Shift+Space talks, Ctrl+Shift+J opens the panel, Escape cancels or
 * closes (only when the focus is not inside an editor).
 */
export function useAssistantHotkeys(handlers: HotkeyHandlers) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      const chord = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
      if (chord && (event.code === "Space" || event.key === " ")) {
        event.preventDefault();
        handlers.pushToTalk();
        return;
      }
      if (chord && (event.key === "J" || event.key === "j")) {
        event.preventDefault();
        handlers.togglePanel();
        return;
      }
      if (event.key === "Escape" && !isEditableTarget(event.target)) {
        if (handlers.escape()) event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}

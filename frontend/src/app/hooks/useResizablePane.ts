import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { clamp } from "../appHelpers";

export type ResizablePane = {
  /** The pane's current width in pixels. */
  width: number;
  setWidth: (width: number) => void;
  /** Attach to the drag handle's `onPointerDown`. */
  startResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
};

/**
 * A pane the user can drag wider or narrower by its left-hand edge.
 *
 * The drag is tracked on `window` rather than the handle so it survives the
 * pointer leaving the handle, and the body's cursor and text selection are
 * pinned for the duration so the page does not highlight while dragging.
 *
 * Below the `md` breakpoint the panes are not side by side, so a drag there
 * would move a width nothing reads; it is ignored.
 */
export function useResizablePane(initialWidth: number, min: number, max: number): ResizablePane {
  const [width, setWidth] = useState(initialWidth);

  function startResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (window.innerWidth < 768) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    const resize = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      setWidth(clamp(nextWidth, min, max));
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize);
  }

  return { width, setWidth, startResize };
}

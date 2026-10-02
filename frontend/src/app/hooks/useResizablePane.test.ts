import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useResizablePane } from "./useResizablePane";

const WIDE = 1280;
const NARROW = 500;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

/** A pointerdown on the drag handle, with only the fields the hook reads. */
function pointerDown(clientX: number) {
  let defaultPrevented = false;
  return {
    clientX,
    preventDefault: () => {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  } as unknown as Parameters<ReturnType<typeof useResizablePane>["startResize"]>[0];
}

// jsdom has no PointerEvent. The listener is keyed on the event *type*, and
// the hook only reads clientX, so a MouseEvent under that type is equivalent.
function drag(clientX: number) {
  window.dispatchEvent(new MouseEvent("pointermove", { clientX }));
}

function release() {
  window.dispatchEvent(new Event("pointerup"));
}

afterEach(() => {
  setViewportWidth(WIDE);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

describe("useResizablePane", () => {
  it("starts at the width it was given", () => {
    const { result } = renderHook(() => useResizablePane(380, 300, 560));
    expect(result.current.width).toBe(380);
  });

  it("follows the pointer while dragging", () => {
    setViewportWidth(WIDE);
    const { result } = renderHook(() => useResizablePane(380, 300, 560));

    act(() => result.current.startResize(pointerDown(100)));
    act(() => drag(160));
    expect(result.current.width).toBe(440);

    act(() => drag(60));
    expect(result.current.width).toBe(340);
  });

  it("will not drag past either bound", () => {
    setViewportWidth(WIDE);
    const { result } = renderHook(() => useResizablePane(380, 300, 560));

    act(() => result.current.startResize(pointerDown(100)));
    act(() => drag(9999));
    expect(result.current.width).toBe(560);

    act(() => drag(-9999));
    expect(result.current.width).toBe(300);
  });

  it("stops following the pointer once released", () => {
    setViewportWidth(WIDE);
    const { result } = renderHook(() => useResizablePane(380, 300, 560));

    act(() => result.current.startResize(pointerDown(100)));
    act(() => drag(160));
    act(() => release());

    act(() => drag(400));
    expect(result.current.width).toBe(440);
  });

  it("measures each new drag from the width the last one ended at", () => {
    setViewportWidth(WIDE);
    const { result } = renderHook(() => useResizablePane(380, 300, 560));

    act(() => result.current.startResize(pointerDown(100)));
    act(() => drag(160));
    act(() => release());
    expect(result.current.width).toBe(440);

    act(() => result.current.startResize(pointerDown(200)));
    act(() => drag(230));
    expect(result.current.width).toBe(470);
  });

  it("pins the cursor and blocks selection only while dragging", () => {
    setViewportWidth(WIDE);
    const { result } = renderHook(() => useResizablePane(380, 300, 560));

    act(() => result.current.startResize(pointerDown(100)));
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    act(() => release());
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("ignores a drag on a narrow viewport, where the panes are not side by side", () => {
    setViewportWidth(NARROW);
    const { result } = renderHook(() => useResizablePane(380, 300, 560));

    const event = pointerDown(100);
    act(() => result.current.startResize(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.body.style.cursor).toBe("");

    act(() => drag(600));
    expect(result.current.width).toBe(380);
  });

  it("can be set directly, without a drag", () => {
    const { result } = renderHook(() => useResizablePane(380, 300, 560));
    act(() => result.current.setWidth(500));
    expect(result.current.width).toBe(500);
  });
});

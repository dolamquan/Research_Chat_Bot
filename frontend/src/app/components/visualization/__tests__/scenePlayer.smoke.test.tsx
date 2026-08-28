import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import transformerScene from "../../../../../../backend/tests/fixtures/scenes/transformer_self_attention.json";
import ScenePlayer from "../ScenePlayer";

/**
 * End-to-end smoke test for the player, in jsdom.
 *
 * Covers the same ground a browser smoke test would, minus the real WebGL
 * context: the fixture renders, playback advances, navigation works, mode
 * switching works, clicking an entity shows its evidence, and nothing throws.
 * `@react-three/fiber`'s Canvas is stubbed because jsdom has no WebGL -- so
 * this asserts 2D behaviour directly and 3D only as far as "the mode switch
 * does not crash". `docs/PAPER_TO_SCENE.md` records what a browser-level
 * Playwright run would add on top.
 */

vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children?: unknown }) => (
    <div data-testid="scene-canvas-stub">{children as never}</div>
  ),
  useFrame: () => {},
  useThree: () => ({}),
}));

vi.mock("@react-three/drei", () => ({
  OrbitControls: () => null,
  Html: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  RoundedBox: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
}));

describe("ScenePlayer smoke", () => {
  const errors: unknown[] = [];

  beforeEach(() => {
    errors.length = 0;
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });
  });

  it("1. renders a fixture scene", () => {
    render(<ScenePlayer sceneInput={transformerScene} />);
    expect(screen.getByTestId("scene-player")).toBeTruthy();
    expect(screen.getByTestId("scene-controls")).toBeTruthy();
  });

  it("2. shows the first step and its caption", () => {
    render(<ScenePlayer sceneInput={transformerScene} initialMode="2d" />);
    expect(screen.getByTestId("scene-position").textContent).toBe("1/5");
    expect(screen.getByTestId("scene-caption").textContent).toContain(
      "Token embeddings enter",
    );
  });

  it("3. play toggles into a playing state", async () => {
    render(<ScenePlayer sceneInput={transformerScene} initialMode="2d" />);
    const button = screen.getByTestId("scene-playpause");
    await act(async () => button.click());
    expect(button.textContent).toBe("Pause");
  });

  it("4. next and previous move the active step", async () => {
    render(<ScenePlayer sceneInput={transformerScene} initialMode="2d" />);
    await act(async () => screen.getByTestId("scene-next").click());
    expect(screen.getByTestId("scene-position").textContent).toBe("2/5");
    await act(async () => screen.getByTestId("scene-prev").click());
    expect(screen.getByTestId("scene-position").textContent).toBe("1/5");
  });

  it("5. switches between 2D and 3D without regenerating", async () => {
    render(<ScenePlayer sceneInput={transformerScene} initialMode="2d" />);
    expect(screen.getByTestId("scene-2d")).toBeTruthy();

    await act(async () => screen.getByTestId("scene-mode-3d").click());
    expect(screen.queryByTestId("scene-2d")).toBeNull();
    expect(screen.getByTestId("scene-canvas-stub")).toBeTruthy();
    // The step position is preserved, proving the scene was not rebuilt.
    expect(screen.getByTestId("scene-position").textContent).toBe("1/5");

    await act(async () => screen.getByTestId("scene-mode-2d").click());
    expect(screen.getByTestId("scene-2d")).toBeTruthy();
  });

  it("6. clicking an entity shows its supporting evidence", async () => {
    render(<ScenePlayer sceneInput={transformerScene} initialMode="2d" />);
    await act(async () =>
      screen.getByTestId("scene-2d-node-q").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    const panel = screen.getByTestId("scene-evidence-panel");
    expect(panel.textContent).toContain("Queries Q");
    expect(screen.getAllByTestId("scene-evidence-item").length).toBeGreaterThan(0);
    expect(panel.textContent).toContain("attention function");
  });

  it("7. no uncaught errors were logged", () => {
    render(<ScenePlayer sceneInput={transformerScene} initialMode="2d" />);
    expect(errors).toHaveLength(0);
  });

  it("survives a malformed scene without crashing", () => {
    render(<ScenePlayer sceneInput={{ steps: "not an array" }} />);
    expect(screen.getByTestId("scene-player-empty")).toBeTruthy();
  });

  it("survives a scene whose primitive is unknown", () => {
    const broken = structuredClone(transformerScene) as Record<string, unknown>;
    for (const step of broken.steps as Record<string, unknown>[]) {
      step.primitive = "definitely_not_a_primitive";
    }
    render(<ScenePlayer sceneInput={broken} initialMode="2d" />);
    // The scene still plays; the compiler substitutes the note fallback.
    expect(screen.getByTestId("scene-player")).toBeTruthy();
    expect(screen.getByTestId("scene-issues").textContent).toContain("unsupported");
  });
});

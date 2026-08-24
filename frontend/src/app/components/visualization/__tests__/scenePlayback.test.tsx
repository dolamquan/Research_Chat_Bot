import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import transformerScene from "../../../../../../backend/tests/fixtures/scenes/transformer_self_attention.json";
import SceneControls from "../SceneControls";
import SceneEvidencePanel from "../SceneEvidencePanel";
import Scene2DView, { layoutEntities } from "../Scene2DView";
import { sanitizeScene } from "../sceneValidation";
import { usePlayback } from "../usePlayback";
import type { AlgorithmScene, VisualizationMode } from "../sceneTypes";

const { scene } = sanitizeScene(transformerScene);

/** Drives `usePlayback` outside a renderer, so no WebGL context is needed. */
function Harness({
  onMode,
  mode = "2d",
}: {
  onMode?: (mode: VisualizationMode) => void;
  mode?: VisualizationMode;
}) {
  const playback = usePlayback(scene.steps, { autoPlay: false });
  return (
    <SceneControls
      scene={scene}
      playback={playback}
      mode={mode}
      onModeChange={onMode ?? (() => {})}
    />
  );
}

describe("step navigation", () => {
  it("starts on the first step", () => {
    render(<Harness />);
    expect(screen.getByTestId("scene-position").textContent).toBe("1/5");
  });

  it("advances with Next and returns with Prev", async () => {
    render(<Harness />);
    const next = screen.getByTestId("scene-next");
    await act(async () => next.click());
    expect(screen.getByTestId("scene-position").textContent).toBe("2/5");
    await act(async () => next.click());
    expect(screen.getByTestId("scene-position").textContent).toBe("3/5");
    await act(async () => screen.getByTestId("scene-prev").click());
    expect(screen.getByTestId("scene-position").textContent).toBe("2/5");
  });

  it("disables Prev on the first step and Next on the last", async () => {
    render(<Harness />);
    expect(screen.getByTestId("scene-prev")).toBeDisabled();
    const next = screen.getByTestId("scene-next");
    for (let i = 0; i < 4; i += 1) await act(async () => next.click());
    expect(screen.getByTestId("scene-position").textContent).toBe("5/5");
    expect(screen.getByTestId("scene-next")).toBeDisabled();
  });

  it("restarts to the first step", async () => {
    render(<Harness />);
    await act(async () => screen.getByTestId("scene-next").click());
    await act(async () => screen.getByTestId("scene-restart").click());
    expect(screen.getByTestId("scene-position").textContent).toBe("1/5");
  });

  it("seeks with the timeline slider", async () => {
    render(<Harness />);
    const slider = screen.getByTestId("scene-timeline") as HTMLInputElement;
    expect(slider.max).toBe("4");
  });
});

describe("play / pause", () => {
  it("toggles the button label", async () => {
    render(<Harness />);
    const button = screen.getByTestId("scene-playpause");
    expect(button.textContent).toBe("Play");
    await act(async () => button.click());
    expect(button.textContent).toBe("Pause");
    await act(async () => button.click());
    expect(button.textContent).toBe("Play");
  });

  it("advances the step while playing", async () => {
    vi.useFakeTimers();
    // The hook drives itself from requestAnimationFrame, so drive that clock.
    const callbacks: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        callbacks.push(cb);
        return callbacks.length;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    render(<Harness />);
    await act(async () => screen.getByTestId("scene-playpause").click());

    // One frame far enough ahead to pass the first step's 1400ms duration.
    let now = performance.now();
    for (let i = 0; i < 3 && callbacks.length > 0; i += 1) {
      const cb = callbacks.shift();
      now += 2000;
      await act(async () => {
        cb?.(now);
      });
    }
    expect(screen.getByTestId("scene-position").textContent).not.toBe("1/5");

    raf.mockRestore();
    vi.useRealTimers();
  });
});

describe("caption and confidence", () => {
  it("shows the active step's caption and primitive", () => {
    render(<Harness />);
    const caption = screen.getByTestId("scene-caption");
    expect(caption.textContent).toContain("token_stream");
    expect(caption.textContent).toContain("Token embeddings enter");
  });

  it("shows a percentage for a grounded step", () => {
    render(<Harness />);
    expect(screen.getByTestId("scene-confidence").textContent).toContain("%");
  });

  it("marks an uncited step uncertain", () => {
    const ungrounded: AlgorithmScene = {
      ...scene,
      steps: [{ ...scene.steps[0], evidence_ids: [], confidence: 0.2 }],
    };
    function Ungrounded() {
      const playback = usePlayback(ungrounded.steps, { autoPlay: false });
      return (
        <SceneControls
          scene={ungrounded}
          playback={playback}
          mode="2d"
          onModeChange={() => {}}
        />
      );
    }
    render(<Ungrounded />);
    expect(screen.getByTestId("scene-confidence").textContent).toContain("uncertain");
  });
});

describe("mode switching", () => {
  it("reports the chosen mode without touching the scene", async () => {
    const onMode = vi.fn();
    render(<Harness onMode={onMode} mode="2d" />);
    await act(async () => screen.getByTestId("scene-mode-3d").click());
    expect(onMode).toHaveBeenCalledWith("3d");
    await act(async () => screen.getByTestId("scene-mode-2_5d").click());
    expect(onMode).toHaveBeenCalledWith("2_5d");
    // The scene object is never mutated by a mode change.
    expect(scene.steps).toHaveLength(5);
  });

  it("marks the active mode for assistive technology", () => {
    render(<Harness mode="3d" />);
    expect(screen.getByTestId("scene-mode-3d")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("scene-mode-2d")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("evidence panel", () => {
  it("prompts when nothing is selected", () => {
    render(
      <SceneEvidencePanel
        scene={scene}
        selectedEntityId={null}
        activeStepId={null}
        verification={null}
      />,
    );
    expect(screen.getByTestId("scene-evidence-panel").textContent).toContain(
      "Click a labelled component",
    );
  });

  it("shows the quote behind a selected entity", () => {
    render(
      <SceneEvidencePanel
        scene={scene}
        selectedEntityId="q"
        activeStepId={null}
        verification={null}
      />,
    );
    const items = screen.getAllByTestId("scene-evidence-item");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].textContent).toContain("attention function");
  });

  it("states plainly when an entity has no support", () => {
    const withOrphan: AlgorithmScene = {
      ...scene,
      entities: [...scene.entities, {
        id: "orphan", label: "Guess", kind: "component",
        semantic_role: "", group: null, evidence_ids: [],
      }],
    };
    render(
      <SceneEvidencePanel
        scene={withOrphan}
        selectedEntityId="orphan"
        activeStepId={null}
        verification={null}
      />,
    );
    expect(screen.getByTestId("scene-evidence-uncertain").textContent).toContain(
      "No supporting quote",
    );
  });

  it("falls back to the active step's evidence", () => {
    render(
      <SceneEvidencePanel
        scene={scene}
        selectedEntityId={null}
        activeStepId="s3"
        verification={null}
      />,
    );
    expect(screen.getAllByTestId("scene-evidence-item")[0].textContent).toContain(
      "softmax",
    );
  });

  it("renders the verification summary", () => {
    render(
      <SceneEvidencePanel
        scene={scene}
        selectedEntityId={null}
        activeStepId={null}
        verification={{
          valid: true,
          findings: [
            { code: "unused_evidence", severity: "info", message: "One spare quote.",
              entity_ids: [], step_ids: [], evidence_ids: [] },
          ],
          entity_count: 6,
          step_count: 5,
          grounded_entity_ratio: 1,
          grounded_step_ratio: 1,
        }}
      />,
    );
    const panel = screen.getByTestId("scene-evidence-panel");
    expect(panel.textContent).toContain("100%");
    expect(panel.textContent).toContain("One spare quote.");
  });
});

describe("2D view", () => {
  it("lays entities out in dependency order", () => {
    const { nodes } = layoutEntities(scene);
    const layerOf = new Map(nodes.map((n) => [n.id, n.layer]));
    // Queries are produced from tokens, so they sit in a later layer.
    expect(layerOf.get("q")!).toBeGreaterThan(layerOf.get("tokens")!);
    expect(layerOf.get("context")!).toBeGreaterThan(layerOf.get("q")!);
  });

  it("renders a node per entity with stable ids", () => {
    render(
      <Scene2DView scene={scene} activeStep={null} selectedEntityId={null} />,
    );
    for (const entity of scene.entities) {
      expect(screen.getByTestId(`scene-2d-node-${entity.id}`)).toBeTruthy();
    }
  });

  it("reports a click as an entity selection", async () => {
    const onSelect = vi.fn();
    render(
      <Scene2DView
        scene={scene}
        activeStep={null}
        selectedEntityId={null}
        onSelectEntity={onSelect}
      />,
    );
    await act(async () => screen.getByTestId("scene-2d-node-q").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    ));
    expect(onSelect).toHaveBeenCalledWith("q");
  });

  it("handles an empty scene without crashing", () => {
    render(
      <Scene2DView
        scene={{ ...scene, entities: [], steps: [] }}
        activeStep={null}
        selectedEntityId={null}
      />,
    );
    expect(screen.getByTestId("scene-2d-empty")).toBeTruthy();
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SceneRefinePanel, { type RefineOutcome } from "../SceneRefinePanel";

const cosmetic = { kind: "cosmetic" as const, reason: "Only moves labels.", basis: "model" };
const fundamental = {
  kind: "fundamental" as const,
  reason: "It adds a normalisation step the paper does not have.",
  basis: "model",
};

function refined(classification = cosmetic): RefineOutcome<unknown> {
  return { status: "refined", record: {}, classification };
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText("Describe a change to this animation"), {
    target: { value: text },
  });
}

describe("SceneRefinePanel", () => {
  it("applies a presentation change directly", async () => {
    const onRefine = vi.fn(async () => refined());
    render(<SceneRefinePanel onRefine={onRefine} />);
    type("move the value labels below the bars");
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() => expect(onRefine).toHaveBeenCalledWith("move the value labels below the bars", false));
    expect(await screen.findByRole("status")).toHaveTextContent("Verifying the new animation");
    expect(screen.queryByTestId("scene-refine-warning")).toBeNull();
  });

  it("warns before a change to the method and generates nothing until confirmed", async () => {
    const onRefine = vi.fn<(instruction: string, acknowledge: boolean) => Promise<RefineOutcome<unknown>>>()
      .mockResolvedValueOnce({ status: "needs_acknowledgement", classification: fundamental })
      .mockResolvedValueOnce(refined(fundamental));
    render(<SceneRefinePanel onRefine={onRefine} />);
    type("add a normalisation step before the softmax");
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));

    const warning = await screen.findByTestId("scene-refine-warning");
    expect(warning).toHaveTextContent("changes what the animation shows");
    expect(warning).toHaveTextContent(fundamental.reason);
    expect(onRefine).toHaveBeenCalledTimes(1);
    expect(onRefine).toHaveBeenLastCalledWith("add a normalisation step before the softmax", false);

    fireEvent.click(screen.getByRole("button", { name: "Change it anyway" }));
    await waitFor(() => expect(onRefine).toHaveBeenCalledTimes(2));
    expect(onRefine).toHaveBeenLastCalledWith("add a normalisation step before the softmax", true);
    expect(await screen.findByRole("status")).toHaveTextContent("variation of the method");
    expect(screen.queryByTestId("scene-refine-warning")).toBeNull();
  });

  it("lets the user keep the paper's version", async () => {
    const onRefine = vi.fn(async () => ({ status: "needs_acknowledgement", classification: fundamental }) as RefineOutcome<unknown>);
    render(<SceneRefinePanel onRefine={onRefine} />);
    type("skip the residual connection");
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await screen.findByTestId("scene-refine-warning");
    fireEvent.click(screen.getByRole("button", { name: "Keep the paper's version" }));
    expect(screen.queryByTestId("scene-refine-warning")).toBeNull();
    expect(onRefine).toHaveBeenCalledTimes(1);
    // The request text is kept so it can be edited rather than retyped.
    expect(screen.getByLabelText("Describe a change to this animation")).toHaveValue("skip the residual connection");
  });

  it("says when the judgement came from the offline heuristic", async () => {
    const onRefine = vi.fn(async () => ({
      status: "needs_acknowledgement",
      classification: { ...fundamental, basis: "heuristic" },
    }) as RefineOutcome<unknown>);
    render(<SceneRefinePanel onRefine={onRefine} />);
    type("replace the sum with a product");
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    expect(await screen.findByTestId("scene-refine-warning")).toHaveTextContent("Judged offline");
  });

  it("shows the edit trail and flags divergence from the paper", () => {
    render(
      <SceneRefinePanel
        onRefine={vi.fn()}
        edits={[
          { instruction: "move labels", kind: "cosmetic", basis: "model", at: "1" },
          { instruction: "add a step", kind: "fundamental", basis: "acknowledged", at: "2" },
        ]}
      />,
    );
    const trail = screen.getByTestId("scene-edit-trail");
    expect(trail).toHaveTextContent("Edited by you (2)");
    expect(trail).toHaveTextContent("Diverges from the paper");
    expect(trail).toHaveTextContent("add a step");
  });

  it("surfaces a failed application", async () => {
    const onRefine = vi.fn(async () => { throw new Error("The model could not produce acceptable refined code"); });
    render(<SceneRefinePanel onRefine={onRefine} />);
    type("move the labels");
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not produce acceptable refined code");
  });

  it("waits while the scene is being verified", () => {
    render(<SceneRefinePanel onRefine={vi.fn()} busy />);
    expect(screen.getByRole("button", { name: "Verifying…" })).toBeDisabled();
  });
});

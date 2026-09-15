import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => Object.fromEntries([
  "getArticles", "getVisualizations", "getPreparedStages", "getStageScenes",
  "getVariantsForVisualization", "getDiscussion", "getMissingBackendRoutes",
  "expandVisualizationNode", "generateStageScene", "verifyTarget",
  "reportStageSceneRuntime", "refineStageScene",
].map((name) => [name, vi.fn()])));
vi.mock("../../../api", () => api);
// The off-screen probe needs WebGL; here it is a verdict we choose per test.
const probe = vi.hoisted(() => vi.fn());
vi.mock("../sceneProbe", () => ({probeScene: probe}));
vi.mock("../../Visualizer3D", () => ({Visualizer3D: ({diagram, onNodeClick}: any) => (
  <div>{diagram.nodes.map((node: any) => <button key={node.id} onClick={() => onNodeClick(node)}>Open {node.label}</button>)}</div>
)}));
vi.mock("../../VariantPanel", () => ({VariantPanel: ({variants, onSelectVariant}: any) => (
  <div>{variants.map((variant: any) => <button key={variant.variant_id} onClick={() => onSelectVariant(variant.variant_id)}>Select test variant</button>)}</div>
)}));
vi.mock("../../VariantChat", () => ({VariantChat: () => null}));
vi.mock("../../VerificationReport", () => ({VerificationReport: () => null}));
vi.mock("../SceneFrame", () => ({default: ({title}: any) => <div data-testid="cached-animation">{title}</div>}));
import { VisualizerView } from "../../VisualizerView";

const nodes = ["Feedback Loop", "Retrieval"].map((label, i) => ({
  id: String(i), label, kind: "operation", detail: "Test stage", layer: i, x: 0, y: i * 100,
}));
const article = {article_id: "paper-dragin", title: "DRAGIN", status: "indexed", domain: "research"};
const viz = {
  viz_id: "viz-dragin", article_id: article.article_id, diagram_kind: "method_flow",
  algorithm_name: "DRAGIN", summary: "Example", updated_at: "today",
  worked_example: {input_text: "example", tokens: []},
  diagram: {title: "DRAGIN", nodes, edges: [], groups: []},
};
// A saved scene the browser has already run: ready without another probe.
function scene(nodeId: string) {
  return {viz_id: viz.viz_id, node_id: nodeId, valid: true, updated_at: "today",
    scene: {code: "function init(ctx) {} function update(ctx,t) {}"},
    verification: {valid: true, findings: [], runtime: {status: "passed"}}};
}
// A saved scene that passed the static checks but was never executed.
function unverified(nodeId: string) {
  return {...scene(nodeId), verification: {valid: true, findings: [], runtime: {status: "unverified"}}};
}
const passed = {status: "passed", overlaps: [], samples: 9};
function crash(error: string) {
  return {status: "failed", error, overlaps: [], samples: 0};
}
function notes() {
  return {prepared: nodes.map(n => n.id), expansions: nodes.map(n => ({node_id: n.id, content: {process_steps: []}}))};
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {resolve = done;});
  return {promise, resolve};
}
async function openPaper() {
  render(<VisualizerView />);
  fireEvent.click(await screen.findByRole("button", {name: /DRAGIN research/}));
  await screen.findByRole("button", {name: "Open Feedback Loop"});
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getArticles.mockResolvedValue({articles: [article]});
  api.getVisualizations.mockResolvedValue({visualizations: [viz]});
  api.getPreparedStages.mockResolvedValue(notes());
  api.getStageScenes.mockResolvedValue({stage_scenes: []});
  api.getMissingBackendRoutes.mockResolvedValue([]);
  api.getVariantsForVisualization.mockResolvedValue({variants: [], tree: []});
  api.getDiscussion.mockResolvedValue({history: []});
  api.expandVisualizationNode.mockImplementation(async ({nodeId}: any) => ({expansion: {node_id: nodeId, content: {process_steps: []}}}));
  // Freshly generated code has not run yet; the probe decides.
  api.generateStageScene.mockImplementation(async ({nodeId}: any) => ({stage_scene: unverified(nodeId)}));
  probe.mockResolvedValue(passed);
  api.reportStageSceneRuntime.mockImplementation(async ({nodeId, verdict}: any) => ({
    stage_scene: {...scene(nodeId), verification: {valid: true, findings: [], runtime: {status: verdict.status, error: verdict.error}}},
  }));
});
afterEach(cleanup);

describe("Prepare all readiness", () => {
  it("does not announce readiness for saved animations that were never run", async () => {
    api.getStageScenes.mockResolvedValue({stage_scenes: nodes.map(n => unverified(n.id))});
    await openPaper();
    const button = await screen.findByRole("button", {name: /Prepare all/});
    expect(button).toHaveTextContent("0/2");
    expect(screen.queryByText("All stages ready")).not.toBeInTheDocument();
    fireEvent.click(button);
    await screen.findByText("All stages ready");
    // Running saved code costs one probe each and no model call.
    expect(probe).toHaveBeenCalledTimes(2);
    expect(api.generateStageScene).not.toHaveBeenCalled();
    expect(api.reportStageSceneRuntime).toHaveBeenCalledTimes(2);
    expect(api.reportStageSceneRuntime).toHaveBeenCalledWith(
      expect.objectContaining({verdict: expect.objectContaining({status: "passed"})}),
    );
  });

  it("repairs a crashing animation with the error it threw before calling it ready", async () => {
    probe.mockResolvedValueOnce(crash("TypeError: row.forEach is not a function\n    at init (<anonymous>:12:5)"));
    await openPaper();
    fireEvent.click(await screen.findByRole("button", {name: /Prepare all/}));
    await screen.findByText("All stages ready");
    const repair = api.generateStageScene.mock.calls.find(([args]: any) => args.force);
    expect(repair?.[0]).toEqual(expect.objectContaining({
      force: true, runtimeError: expect.stringContaining("row.forEach is not a function"),
    }));
    expect(probe).toHaveBeenCalledTimes(3); // two stages, plus the re-run after the repair
  });

  it("keeps a stage unready when it still crashes after repair, and says why", async () => {
    probe.mockImplementation(async (_code: string, title: string) =>
      title === "Retrieval" ? crash("ReferenceError: rows is not defined") : passed);
    await openPaper();
    fireEvent.click(await screen.findByRole("button", {name: /Prepare all/}));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not prepare 1 stage");
    expect(alert).toHaveTextContent("rows is not defined");
    expect(screen.queryByText("All stages ready")).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name: /Prepare all/})).toHaveTextContent("1/2");
    expect(api.reportStageSceneRuntime).toHaveBeenCalledWith(
      expect.objectContaining({nodeId: "1", verdict: expect.objectContaining({status: "failed"})}),
    );
  });

  it("sends persistent label overlaps back as a layout repair", async () => {
    probe.mockResolvedValueOnce({status: "passed", samples: 9, overlaps: [{a: 'emb("I")', b: "0.20", seconds: [3, 6, 9]}]});
    await openPaper();
    fireEvent.click(await screen.findByRole("button", {name: /Prepare all/}));
    await screen.findByText("All stages ready");
    const repair = api.generateStageScene.mock.calls.find(([args]: any) => args.layoutReport);
    expect(repair?.[0].layoutReport).toEqual({pairs: [{a: 'emb("I")', b: "0.20", seconds: [3, 6, 9]}], samples: 9});
  });

  it("verifies a stage before opening it and offers a repair when it crashes", async () => {
    probe.mockResolvedValue(crash("TypeError: cells is undefined"));
    await openPaper();
    fireEvent.click(screen.getByRole("button", {name: "Open Feedback Loop"}));
    await screen.findByRole("button", {name: "Repair animation"});
    expect(screen.queryByTestId("cached-animation")).not.toBeInTheDocument();
    // Generate, then the budget of repairs, each re-run; never opened.
    expect(probe).toHaveBeenCalledTimes(3);
    expect(api.generateStageScene).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Error details").parentElement).toHaveTextContent("cells is undefined");
  });

  it("shows the backend cause for failed explanations and retries without regenerating saved animations", async () => {
    api.getPreparedStages.mockResolvedValue({prepared: [], expansions: []});
    api.getStageScenes.mockResolvedValue({stage_scenes: nodes.map(n => scene(n.id))});
    api.expandVisualizationNode.mockRejectedValue(new Error("The paper database (Qdrant) is unavailable."));
    await openPaper();
    fireEvent.click(await screen.findByRole("button", {name: /Prepare all/}));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not prepare 2 stages");
    expect(alert).toHaveTextContent("The paper database (Qdrant) is unavailable.");
    expect(screen.queryByText("All stages ready")).not.toBeInTheDocument();
    api.expandVisualizationNode.mockResolvedValue({expansion: {content: {process_steps: []}}});
    fireEvent.click(screen.getByRole("button", {name: /Prepare all/}));
    await screen.findByText("All stages ready");
    expect(api.generateStageScene).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps Prepare all visible when storyboards exist but animations are missing", async () => {
    await openPaper();
    const button = await screen.findByRole("button", {name: /Prepare all/});
    expect(button).toHaveTextContent("0/2");
    expect(screen.queryByText("All stages ready")).not.toBeInTheDocument();
    fireEvent.click(button);
    await screen.findByText("All stages ready");
    expect(api.generateStageScene).toHaveBeenCalledTimes(2);
    expect(api.expandVisualizationNode).not.toHaveBeenCalled();
  });

  it("opens ready animations without another generation request", async () => {
    api.getStageScenes.mockResolvedValue({stage_scenes: nodes.map(n => scene(n.id))});
    await openPaper();
    await screen.findByText("All stages ready");
    fireEvent.click(screen.getByRole("button", {name: "Open Feedback Loop"}));
    await screen.findByTestId("cached-animation");
    fireEvent.click(screen.getByTitle("Next stage"));
    await waitFor(() => expect(screen.getByTestId("cached-animation")).toHaveTextContent("Retrieval"));
    expect(api.generateStageScene).not.toHaveBeenCalled();
    expect(screen.queryByText(/Writing a dynamic scene/)).not.toBeInTheDocument();
  });

  it("waits for delayed saved scenes instead of treating a loading map as missing", async () => {
    const cached = deferred<any>();
    api.getStageScenes.mockReturnValue(cached.promise);
    await openPaper();
    await screen.findByText("Checking saved stages…");
    fireEvent.click(screen.getByRole("button", {name: "Open Feedback Loop"}));
    expect(api.generateStageScene).not.toHaveBeenCalled();
    await act(async () => cached.resolve({stage_scenes: nodes.map(n => scene(n.id))}));
    await screen.findByTestId("cached-animation");
    expect(api.generateStageScene).not.toHaveBeenCalled();
  });

  it("shows lookup failure and retries without generating unknown cached stages", async () => {
    api.getStageScenes.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({stage_scenes: nodes.map(n => scene(n.id))});
    await openPaper();
    const retry = await screen.findByRole("button", {name: /Could not check saved stages/});
    fireEvent.click(screen.getByRole("button", {name: "Open Feedback Loop"}));
    expect(api.generateStageScene).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await screen.findByTestId("cached-animation");
    expect(api.generateStageScene).not.toHaveBeenCalled();
  });

  it("leaves failed stages unprepared and retries only missing animations", async () => {
    api.generateStageScene.mockImplementation(async ({nodeId}: any) => {
      if (nodeId === "1") throw new Error("provider unavailable");
      return {stage_scene: scene(nodeId)};
    });
    await openPaper();
    fireEvent.click(await screen.findByRole("button", {name: /Prepare all/}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not prepare 1 stage");
    const retry = screen.getByRole("button", {name: /Prepare all/});
    expect(retry).toHaveTextContent("1/2");
    api.generateStageScene.mockClear().mockImplementation(async ({nodeId}: any) => ({stage_scene: scene(nodeId)}));
    fireEvent.click(retry);
    await screen.findByText("All stages ready");
    expect(api.generateStageScene).toHaveBeenCalledTimes(1);
    expect(api.generateStageScene).toHaveBeenCalledWith(expect.objectContaining({nodeId: "1"}));
  });

  it("keeps Prepare all visible during playback while another stage is missing", async () => {
    api.getStageScenes.mockResolvedValue({stage_scenes: [scene("0")]});
    await openPaper();
    await screen.findByRole("button", {name: /Prepare all/});
    fireEvent.click(screen.getByRole("button", {name: "Open Feedback Loop"}));
    await screen.findByTestId("cached-animation");
    expect(screen.getByRole("button", {name: /Prepare all/})).toHaveTextContent("1/2");
    expect(api.generateStageScene).not.toHaveBeenCalled();
  });

  it("does not count invalid saved animation code as prepared", async () => {
    api.getStageScenes.mockResolvedValue({stage_scenes: [{...scene("0"), scene: {code: "invalid"}}, scene("1")]});
    await openPaper();
    expect(await screen.findByRole("button", {name: /Prepare all/})).toHaveTextContent("1/2");
  });

  it("ignores a previous paper's delayed cache even when node IDs overlap", async () => {
    const other = {...article, article_id: "paper-other", title: "Other paper"};
    const otherViz = {...viz, viz_id: "viz-other", article_id: other.article_id};
    const late = deferred<any>();
    api.getArticles.mockResolvedValue({articles: [article, other]});
    api.getVisualizations.mockImplementation(async (id: string) => ({visualizations: [id === other.article_id ? otherViz : viz]}));
    api.getStageScenes.mockImplementation((id: string) => id === viz.viz_id ? late.promise : Promise.resolve({stage_scenes: []}));
    await openPaper();
    await screen.findByText("Checking saved stages…");
    fireEvent.click(screen.getByRole("button", {name: /Other paper research/}));
    expect(await screen.findByRole("button", {name: /Prepare all/})).toHaveTextContent("0/2");
    await act(async () => late.resolve({stage_scenes: nodes.map(n => scene(n.id))}));
    expect(screen.getByRole("button", {name: /Prepare all/})).toHaveTextContent("0/2");
    expect(screen.queryByText("All stages ready")).not.toBeInTheDocument();
  });

  it("reloads readiness and uses the variant's own stage count", async () => {
    const variantNodes = [...nodes, {...nodes[0], id: "2", label: "New stage"}];
    const variant = {variant_id: "variant", article_id: article.article_id, parent_variant_id: null,
      variant_title: "Three stages", patch: {ops: []}, diagram: {...viz.diagram, nodes: variantNodes}};
    api.getVariantsForVisualization.mockResolvedValue({variants: [variant], tree: []});
    api.verifyTarget.mockResolvedValue({run: {}, report: {findings: []}});
    api.getPreparedStages.mockImplementation(async (id: string) => id === "variant" ? {...notes(), prepared: ["0", "1", "2"]} : notes());
    api.getStageScenes.mockImplementation(async (id: string) => ({stage_scenes: id === "variant" ? [scene("0")] : nodes.map(n => scene(n.id))}));
    await openPaper();
    await screen.findByText("All stages ready");
    fireEvent.click(screen.getByRole("button", {name: "Modify"}));
    fireEvent.click(await screen.findByRole("button", {name: "Select test variant"}));
    expect(await screen.findByRole("button", {name: /Prepare all/})).toHaveTextContent("1/3");
    expect(api.getPreparedStages).toHaveBeenCalledWith("variant");
    expect(api.getStageScenes).toHaveBeenCalledWith("variant");
  });

  it("does not automatically retry failed scene generation indefinitely", async () => {
    api.generateStageScene.mockRejectedValue(new Error("unavailable"));
    await openPaper();
    await screen.findByRole("button", {name: /Prepare all/});
    fireEvent.click(screen.getByRole("button", {name: "Open Feedback Loop"}));
    await screen.findByRole("button", {name: "Regenerate animation"});
    expect(api.generateStageScene).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", {name: /Prepare all/})).toHaveTextContent("0/2");
  });
});

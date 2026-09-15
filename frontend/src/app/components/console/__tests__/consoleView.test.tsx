import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() =>
  Object.fromEntries(
    [
      "getAgentContext", "getAgentTools", "getAgentTool", "callAgentTool", "callMcpTool",
      "getAgentSessions", "getAgentSession", "deleteAgentSession",
      "getIngestionJobs", "getEvaluationRuns",
      "getIntegrations", "listSceneProviders", "getMissingBackendRoutes", "getHealth",
    ].map((name) => [name, vi.fn()]),
  ),
);
vi.mock("../../../api", () => api);
vi.mock("../../MarkdownBody", () => ({ FormattedText: ({ content }: { content: string }) => <p>{content}</p> }));

import { ConsoleView } from "../ConsoleView";

const CATEGORIES = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`area${i}`, 5]));
const TOOL = { name: "app.papers", category: "app", description: "Search the library", effect: "read", execution: "builtin", available: true };
const RUNNING_JOB = {
  job_id: "j1", url: "https://arxiv.org/abs/1", title: "Paper One", domain: "research", category: "nlp", tags: [],
  status: "running", stage: "embedding", message: "chunking", created_at: "2026-09-14T10:00:00Z", updated_at: "2026-09-14T10:01:00Z",
};
const SESSION = { id: "s1", title: "Export my attention notes", kind: "assistant", context_mode: "retrieval", created_at: "2026-09-14T10:00:00Z", updated_at: "2026-09-14T10:05:00Z" };

function openCommandLine() {
  fireEvent.click(screen.getByRole("button", { name: "Command line" }));
}

function submitCommand(text: string) {
  const input = screen.getByLabelText("Console command");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest("form")!);
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getAgentContext.mockResolvedValue({
    application: "Zoetrope", guide: { Chat: "Grounded Q&A" }, paper_count: 201,
    domains: [{ domain: "research", category: "nlp", article_count: 150 }, { domain: "research", category: "cv", article_count: 51 }],
    tool_count: 110, tool_categories: CATEGORIES, notion_targets: [],
    unavailable_tools: [{ name: "reddit.search_posts", reason: "REDDIT_CLIENT_ID missing" }, { name: "reddit.list_tools", reason: "REDDIT_CLIENT_ID missing" }],
    workspace: {},
  });
  api.getAgentTools.mockResolvedValue({ total: 1, categories: { app: 1 }, tools: [TOOL], next_offset: null });
  api.getAgentTool.mockResolvedValue({ ...TOOL, input_schema: { type: "object", properties: { query: { type: "string" } } } });
  api.callAgentTool.mockResolvedValue({ status: "ok", name: "app.papers", result: { count: 201 } });
  api.callMcpTool.mockResolvedValue({ status: "ok", server: "zoetrope", tool_name: "research.search_library", result: { hits: [] } });
  api.getAgentSessions.mockResolvedValue({ sessions: [SESSION] });
  api.getAgentSession.mockResolvedValue({
    session: SESSION,
    messages: [{ role: "assistant", content: "Done.", created_at: "t", tool_trace: [
      { tool: "api.notes.export", status: "success", effect: "external_write", message: "", timestamp: "" },
    ] }],
  });
  api.getIngestionJobs.mockResolvedValue({ jobs: [RUNNING_JOB] });
  api.getEvaluationRuns.mockResolvedValue({ runs: [{ run_id: "run-abcdef123456", filename: "r.json", kind: "ragas", created_at: "2026-09-13T10:00:00Z", case_count: 12, average_latency_seconds: 4.2, metrics: {}, overall: 0.81 }] });
  api.getIntegrations.mockResolvedValue({ integrations: [{ provider: "notion", label: "Notion", configured: true, source: "user", method: "oauth" }, { provider: "github", label: "GitHub", configured: false, source: null }] });
  api.listSceneProviders.mockResolvedValue({ providers: ["openai"] });
  api.getMissingBackendRoutes.mockResolvedValue(["/visualizer/item/{viz_id}/refine"]);
  api.getHealth.mockResolvedValue({ status: "ok" });
});
afterEach(cleanup);

describe("ConsoleView", () => {
  it("lands on an overview that answers the four questions in sentences", async () => {
    render(<ConsoleView onOpenView={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

    const status = await screen.findByTestId("overview-status");
    expect(status).toHaveTextContent("Backend online · 201 papers indexed · 110 tools · model: openai · Notion connected");

    expect(screen.getByTestId("overview-running")).toHaveTextContent("Paper One");
    expect(screen.getByTestId("overview-running")).toHaveTextContent("embedding");

    const activity = await screen.findByTestId("overview-activity");
    await within(activity).findByText("Export my attention notes");
    expect(activity).toHaveTextContent("1 external write");

    const attention = screen.getByTestId("overview-attention");
    expect(attention).toHaveTextContent("2 tools unavailable — REDDIT_CLIENT_ID missing");
    expect(attention).toHaveTextContent("GitHub is not connected");
    expect(attention).toHaveTextContent("1 route this frontend expects");
    // No raw route names, no monospace catalog: the plumbing is one click away.
    expect(screen.queryByTestId("tool-list")).toBeNull();
  });

  it("says so when nothing needs attention or is running", async () => {
    api.getAgentContext.mockResolvedValue({ application: "Zoetrope", guide: {}, paper_count: 0, domains: [], tool_count: 3, tool_categories: {}, notion_targets: [], unavailable_tools: [], workspace: {} });
    api.getIntegrations.mockResolvedValue({ integrations: [] });
    api.getMissingBackendRoutes.mockResolvedValue([]);
    api.getIngestionJobs.mockResolvedValue({ jobs: [] });
    api.getAgentSessions.mockResolvedValue({ sessions: [] });
    render(<ConsoleView onOpenView={vi.fn()} />);
    expect(await screen.findByTestId("overview-attention")).toHaveTextContent("Everything Zoe can reach is available.");
    expect(screen.getByTestId("overview-running")).toHaveTextContent("Nothing is running.");
    expect(await screen.findByText("Zoe has not done anything yet.")).toBeInTheDocument();
  });

  it("jumps from the overview into the detailed tabs", async () => {
    const onOpenView = vi.fn();
    render(<ConsoleView onOpenView={onOpenView} />);
    await screen.findByTestId("overview-status");

    fireEvent.click(screen.getByRole("button", { name: "All jobs →" }));
    expect(screen.getByRole("tab", { name: "Jobs" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("run-abcdef12")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open dashboard/ }));
    expect(onOpenView).toHaveBeenCalledWith("evaluation");

    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
    expect(await screen.findByTestId("health")).toHaveTextContent("Backend online");
    expect(screen.getByTestId("tools")).toHaveTextContent("2 unavailable — REDDIT_CLIENT_ID missing");
    expect(screen.getByTestId("routes")).toHaveTextContent("1 missing");

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await screen.findByTestId("session-list");
  });

  it("keeps the command line folded until asked, then opens a tool from it", async () => {
    render(<ConsoleView onOpenView={vi.fn()} />);
    await screen.findByTestId("overview-status");
    expect(screen.queryByLabelText("Console command")).toBeNull();

    openCommandLine();
    submitCommand("/tool app.papers");
    expect(await screen.findByTestId("tool-detail")).toHaveTextContent("app.papers");
    expect(screen.getByRole("tab", { name: "Tools" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("command-output")).toHaveTextContent("Opened app.papers in Tools.");

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByLabelText("Console command")).toBeNull();
  });

  it("runs a tool exactly as typed, with no model involved", async () => {
    render(<ConsoleView onOpenView={vi.fn()} />);
    await screen.findByTestId("overview-status");
    openCommandLine();
    submitCommand('/call app.papers {"query":"graph rag","limit":5}');
    await waitFor(() => expect(api.callAgentTool).toHaveBeenCalledWith({ name: "app.papers", arguments: { query: "graph rag", limit: 5 } }));
    expect(await screen.findByTestId("command-output")).toHaveTextContent('"count": 201');

    submitCommand('/mcp-call research.search_library {"query":"x"}');
    await waitFor(() => expect(api.callMcpTool).toHaveBeenCalledWith({ toolName: "research.search_library", arguments: { query: "x" } }));
  });

  it("redirects plain language to Zoe instead of guessing", async () => {
    render(<ConsoleView onOpenView={vi.fn()} />);
    await screen.findByTestId("overview-status");
    openCommandLine();
    submitCommand("which papers do I have about diffusion?");
    expect(await screen.findByTestId("command-output")).toHaveTextContent("ask Zoe");
    expect(api.callAgentTool).not.toHaveBeenCalled();
  });
});

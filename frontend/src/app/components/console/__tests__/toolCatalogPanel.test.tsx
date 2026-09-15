import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getAgentTools: vi.fn(), getAgentTool: vi.fn(), callAgentTool: vi.fn() }));
vi.mock("../../../api", () => api);

import { ToolCatalogPanel, effectLabel, humanTitle } from "../ToolCatalogPanel";

const TOOLS = [
  { name: "app.papers", category: "application", description: "Search or page through ALL library papers", effect: "read", execution: "builtin", available: true },
  {
    name: "api.notes.delete_note", category: "notes", description: "Delete note [DELETE /notes/{note_id}]", effect: "destructive",
    execution: "api", available: true, method: "DELETE", path: "/notes/{note_id}",
  },
  {
    name: "notion.create_research_page", category: "integrations", description: "Publish a research page to Notion", effect: "external_write",
    execution: "mcp", available: false, unavailable_reason: "NOTION_TOKEN is not set",
  },
  {
    name: "api.agent.get_agent_sessions", category: "agent",
    description: "List agent sessions; `kind=assistant` lists the always-present assistant's sessions, `kind=all` every kind. [GET /agent/sessions]",
    effect: "read", execution: "api", available: true, method: "GET", path: "/agent/sessions",
  },
];

const SCHEMAS: Record<string, object> = {
  "app.papers": { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", default: 10 } }, required: ["query"] },
  "api.notes.delete_note": {
    type: "object",
    properties: { path: { type: "object", properties: { note_id: { type: "string" } }, required: ["note_id"] } },
  },
  "notion.create_research_page": { type: "object", properties: { title: { type: "string" } } },
  "api.agent.get_agent_sessions": {
    type: "object",
    properties: { query: { type: "object", properties: { limit: { type: "integer", default: 50 }, kind: { type: "string", default: "agent" } } } },
  },
};

function Harness() {
  const [selected, setSelected] = useState<string | null>(null);
  return <ToolCatalogPanel selectedName={selected} onSelect={setSelected} />;
}

/** Groups are folded by default; open one by its header. */
async function openGroup(name: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getAgentTools.mockResolvedValue({ total: TOOLS.length, categories: {}, tools: TOOLS, next_offset: null });
  api.getAgentTool.mockImplementation(async (name: string) => ({ ...TOOLS.find((t) => t.name === name)!, input_schema: SCHEMAS[name] }));
  api.callAgentTool.mockResolvedValue({ status: "ok", name: "app.papers", result: { papers: [{ title: "Graph RAG" }] } });
});
afterEach(cleanup);

describe("ToolCatalogPanel", () => {
  it("shows areas folded and rows as plain titles, without machine names", async () => {
    render(<Harness />);
    const list = await screen.findByTestId("tool-list");
    expect(within(list).getByRole("button", { name: /notes 1/i })).toHaveAttribute("aria-expanded", "false");

    await openGroup(/notes 1/i);
    expect(within(list).getByText("Delete note")).toBeInTheDocument();
    expect(within(list).getByText("deletes data")).toBeInTheDocument();
    expect(within(list).queryByText("api.notes.delete_note")).toBeNull();
    expect(within(list).queryByText(/DELETE \/notes/)).toBeNull();

    await openGroup(/agent 1/i);
    // A docstring becomes a title, not a truncated paragraph with backticks.
    expect(within(list).getByText("List agent sessions")).toBeInTheDocument();
    expect(within(list).queryByText(/kind=assistant/)).toBeNull();
  });

  it("opens every matching area while searching", async () => {
    render(<Harness />);
    await screen.findByTestId("tool-list");
    fireEvent.change(screen.getByLabelText("Search tools"), { target: { value: "notion" } });
    const list = screen.getByTestId("tool-list");
    expect(within(list).getByText("Publish a research page to Notion")).toBeInTheDocument();
    expect(within(list).getByText("writes outside the app")).toBeInTheDocument();
    expect(within(list).queryByText("Delete note")).toBeNull();
  });

  it("explains the tool in words and keeps the plumbing under technical details", async () => {
    render(<Harness />);
    await openGroup(/agent 1/i);
    fireEvent.click(screen.getByText("List agent sessions"));
    const detail = await screen.findByTestId("tool-detail");
    expect(within(detail).getByRole("heading")).toHaveTextContent("List agent sessions");
    expect(detail).toHaveTextContent("lists the always-present assistant's sessions");
    expect(detail).toHaveTextContent("Read-only. Running it changes nothing.");
    // Fields are words with their defaults, grouped by meaning, not by HTTP part.
    expect(await within(detail).findByLabelText(/^Limit/)).toHaveValue(50);
    expect(within(detail).getByLabelText(/^Kind/)).toHaveValue("agent");
    expect(within(detail).queryByText(/^query$/)).toBeNull();
    expect(within(detail).queryByText(/^integer$/)).toBeNull();
    const technical = within(detail).getByTestId("tool-technical");
    expect(technical).toHaveTextContent("api.agent.get_agent_sessions");
    expect(technical).toHaveTextContent("GET /agent/sessions");
  });

  it("refuses to run with a missing required field and says so in words", async () => {
    render(<Harness />);
    await openGroup(/application 1/i);
    fireEvent.click(screen.getByText("Search or page through ALL library papers"));
    const detail = await screen.findByTestId("tool-detail");
    await within(detail).findByLabelText(/^Query/);
    expect(within(detail).getByLabelText(/^Limit/)).toHaveValue(10);

    fireEvent.click(within(detail).getByRole("button", { name: /Run/ }));
    expect(await within(detail).findByRole("alert")).toHaveTextContent("This is required.");
    expect(api.callAgentTool).not.toHaveBeenCalled();
  });

  it("runs a read tool with coerced arguments and summarises the result", async () => {
    render(<Harness />);
    await openGroup(/application 1/i);
    fireEvent.click(screen.getByText("Search or page through ALL library papers"));
    const detail = await screen.findByTestId("tool-detail");
    fireEvent.change(await within(detail).findByLabelText(/^Query/), { target: { value: "graph rag" } });
    fireEvent.change(within(detail).getByLabelText(/^Limit/), { target: { value: "5" } });
    fireEvent.click(within(detail).getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(api.callAgentTool).toHaveBeenCalledWith({ name: "app.papers", arguments: { query: "graph rag", limit: 5 } }));
    expect(await screen.findByTestId("tool-result-summary")).toHaveTextContent("Done — 1 papers");
    expect(screen.getByTestId("tool-result")).toHaveTextContent('"title": "Graph RAG"');
  });

  it("gates a destructive tool behind an explicit acknowledgement", async () => {
    render(<Harness />);
    await openGroup(/notes 1/i);
    fireEvent.click(screen.getByText("Delete note"));
    const detail = await screen.findByTestId("tool-detail");
    expect(detail).toHaveTextContent("Deletes data. This cannot be undone.");
    const run = await within(detail).findByRole("button", { name: /Run/ });
    fireEvent.change(await within(detail).findByLabelText(/^Note ID/), { target: { value: "n1" } });
    expect(run).toBeDisabled();
    expect(detail).toHaveTextContent("Tick the box above to enable Run.");

    fireEvent.click(within(detail).getByRole("checkbox", { name: /This deletes data/ }));
    expect(run).not.toBeDisabled();
    fireEvent.click(run);
    await waitFor(() => expect(api.callAgentTool).toHaveBeenCalledWith({ name: "api.notes.delete_note", arguments: { path: { note_id: "n1" } } }));
  });

  it("shows why an unavailable tool cannot run and keeps Run disabled", async () => {
    render(<Harness />);
    await openGroup(/integrations 1/i);
    fireEvent.click(screen.getByText("Publish a research page to Notion"));
    const detail = await screen.findByTestId("tool-detail");
    expect(await within(detail).findByTestId("tool-unavailable")).toHaveTextContent("NOTION_TOKEN is not set");
    fireEvent.click(within(detail).getByRole("checkbox"));
    expect(within(detail).getByRole("button", { name: /Run/ })).toBeDisabled();
  });

  it("reports a failed call as a failure, not a result", async () => {
    api.callAgentTool.mockRejectedValue(new Error("422 arguments did not match the schema"));
    render(<Harness />);
    await openGroup(/application 1/i);
    fireEvent.click(screen.getByText("Search or page through ALL library papers"));
    const detail = await screen.findByTestId("tool-detail");
    fireEvent.change(await within(detail).findByLabelText(/^Query/), { target: { value: "x" } });
    fireEvent.click(within(detail).getByRole("button", { name: /Run/ }));
    expect(await screen.findByTestId("tool-result-summary")).toHaveTextContent("Failed");
    expect(screen.getByTestId("tool-result")).toHaveTextContent("did not match the schema");
  });
});

describe("re-exports", () => {
  it("keeps the title and effect helpers available", () => {
    expect(humanTitle(TOOLS[1])).toBe("Delete note");
    expect(effectLabel("destructive").text).toBe("deletes data");
  });
});

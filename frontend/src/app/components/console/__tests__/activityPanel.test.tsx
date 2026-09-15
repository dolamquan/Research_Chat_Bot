import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getAgentSessions: vi.fn(), getAgentSession: vi.fn(), deleteAgentSession: vi.fn() }));
vi.mock("../../../api", () => api);
vi.mock("../../MarkdownBody", () => ({ FormattedText: ({ content }: { content: string }) => <p>{content}</p> }));

import { ActivityPanel, summarizeChanges } from "../ActivityPanel";

const SESSIONS = [
  { id: "s1", title: "Export my attention notes", kind: "assistant", context_mode: "retrieval", created_at: "2026-09-14T10:00:00Z", updated_at: "2026-09-14T10:05:00Z" },
  { id: "s2", title: "Old console run", kind: "agent", context_mode: "retrieval", created_at: "2026-09-10T10:00:00Z", updated_at: "2026-09-10T10:01:00Z" },
];

const DETAIL = {
  session: SESSIONS[0],
  messages: [
    { role: "user", content: "export my attention notes to Notion", created_at: "2026-09-14T10:00:00Z" },
    {
      role: "assistant",
      content: "Exported **2 notes**.",
      created_at: "2026-09-14T10:05:00Z",
      tool_trace: [
        { tool: "app.papers", status: "success", effect: "read", message: "3 papers", timestamp: "t1" },
        { tool: "api.notes.export_note_to_notion", status: "success", effect: "external_write", message: "page created", timestamp: "t2" },
        { tool: "api.notes.export_note_to_notion", status: "success", effect: "external_write", message: "page created", timestamp: "t3" },
        { tool: "api.notes.delete_note", status: "error", effect: "destructive", message: "refused", timestamp: "t4" },
      ],
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  api.getAgentSessions.mockImplementation(async (kind: string) => ({
    sessions: kind === "all" ? SESSIONS : SESSIONS.filter((s) => s.kind === kind),
  }));
  api.getAgentSession.mockResolvedValue(DETAIL);
  api.deleteAgentSession.mockResolvedValue({ status: "deleted" });
});
afterEach(cleanup);

describe("ActivityPanel", () => {
  it("lists both kinds of session, labelled, and filters by kind", async () => {
    render(<ActivityPanel />);
    const list = await screen.findByTestId("session-list");
    expect(within(list).getByText("Export my attention notes")).toBeInTheDocument();
    expect(within(list).getByText("Zoe")).toBeInTheDocument();
    expect(within(list).getByText("Agent tab (retired)")).toBeInTheDocument();
    expect(api.getAgentSessions).toHaveBeenLastCalledWith("all");

    fireEvent.click(screen.getByRole("tab", { name: "Zoe" }));
    await waitFor(() => expect(api.getAgentSessions).toHaveBeenLastCalledWith("assistant"));
    await waitFor(() => expect(within(list).queryByText("Old console run")).toBeNull());
  });

  it("shows a session's turns, its tool timeline, and what it changed", async () => {
    render(<ActivityPanel />);
    fireEvent.click(await screen.findByText("Export my attention notes"));
    const detail = await screen.findByTestId("session-detail");
    expect(within(detail).getByText("export my attention notes to Notion")).toBeInTheDocument();
    expect(within(detail).getByText("Exported **2 notes**.")).toBeInTheDocument();
    // Reads are not changes, and a refused delete did not happen.
    expect(screen.getByTestId("session-changes")).toHaveTextContent("Changed: 2 external writes");
    expect(within(detail).getAllByText("api.notes.export_note_to_notion")).toHaveLength(2);
  });

  it("says plainly when a session only read", async () => {
    api.getAgentSession.mockResolvedValue({
      ...DETAIL,
      messages: [{ role: "assistant", content: "You have 3 papers.", created_at: "t", tool_trace: [{ tool: "app.papers", status: "success", effect: "read", message: "", timestamp: "t" }] }],
    });
    render(<ActivityPanel />);
    fireEvent.click(await screen.findByText("Export my attention notes"));
    expect(await screen.findByTestId("session-changes")).toHaveTextContent("No changes");
  });

  it("deletes a session only after confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ActivityPanel />);
    const remove = await screen.findByLabelText("Delete session Old console run");
    fireEvent.click(remove);
    expect(api.deleteAgentSession).not.toHaveBeenCalled();
    fireEvent.click(remove);
    await waitFor(() => expect(api.deleteAgentSession).toHaveBeenCalledWith("s2"));
    await waitFor(() => expect(screen.queryByText("Old console run")).toBeNull());
    confirm.mockRestore();
  });
});

describe("summarizeChanges", () => {
  it("counts successful writes, deletes and external writes", () => {
    const { total, parts } = summarizeChanges([
      { tool: "a", status: "success", effect: "write", message: "", timestamp: "" },
      { tool: "b", status: "success", effect: "destructive", message: "", timestamp: "" },
      { tool: "c", status: "skipped", effect: "destructive", message: "", timestamp: "" },
      { tool: "d", status: "success", effect: "read", message: "", timestamp: "" },
    ]);
    expect(total).toBe(2);
    expect(parts).toEqual(["1 write", "1 delete"]);
  });
});

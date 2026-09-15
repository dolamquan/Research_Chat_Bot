import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../../types";
import { describeResult, groupLabel, humanLabel, inlineSegments, toolExplanation, toolTitle } from "../toolText";

function tool(description: string, name = "api.agent.get_agent_sessions"): AgentTool {
  return { name, category: "agent", description, effect: "read", execution: "api", available: true };
}

describe("toolTitle", () => {
  it("uses the first clause of the docstring and drops the route", () => {
    expect(toolTitle(tool("List agent sessions; `kind=assistant` lists the always-present assistant's sessions, `kind=all` every kind. [GET /agent/sessions]"))).toBe("List agent sessions");
    expect(toolTitle(tool("Delete note [DELETE /notes/{note_id}]"))).toBe("Delete note");
    expect(toolTitle(tool("Re-run deterministic verification. No model call, no regeneration."))).toBe("Re-run deterministic verification");
  });

  it("falls back to the name when there is no description, and caps long titles", () => {
    expect(toolTitle(tool("", "api.notes.create_note"))).toBe("Create note");
    expect(toolTitle(tool("", "api.visualizer.generate_stage_scene"))).toBe("Generate stage scene");
    const long = toolTitle(tool("Search or page through every paper in the library and get real article_id and source values for them all"));
    expect(long.length).toBeLessThanOrEqual(65);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("toolExplanation", () => {
  it("returns what follows the title, keeping code spans", () => {
    const text = toolExplanation(tool("List agent sessions; `kind=assistant` lists the assistant's sessions, `kind=all` every kind. [GET /agent/sessions]"));
    expect(text).toBe("`kind=assistant` lists the assistant's sessions, `kind=all` every kind.");
    expect(inlineSegments(text)[0]).toEqual({ code: true, text: "kind=assistant" });
  });

  it("is empty when the title was the whole description", () => {
    expect(toolExplanation(tool("Delete note [DELETE /notes/{note_id}]"))).toBe("");
    expect(toolExplanation(tool("", "api.notes.create_note"))).toBe("");
  });
});

describe("humanLabel and groups", () => {
  it("turns snake_case into words and keeps acronyms", () => {
    expect(humanLabel("note_id")).toBe("Note ID");
    expect(humanLabel("document_source")).toBe("Document source");
    expect(humanLabel("pdf_url")).toBe("PDF URL");
    expect(humanLabel("retrievalLimit")).toBe("Retrieval limit");
  });

  it("names HTTP groups for what they mean", () => {
    expect(groupLabel("path")?.label).toBe("Which item");
    expect(groupLabel("query")?.label).toBe("Options");
    expect(groupLabel("body")?.label).toBe("Details");
    expect(groupLabel(null)).toBeNull();
  });
});

describe("describeResult", () => {
  it("counts what came back", () => {
    expect(describeResult({ sessions: [1, 2, 3] })).toBe("3 sessions");
    expect(describeResult([1])).toBe("1 item");
    expect(describeResult({ status: "deleted" })).toBe("Status");
    expect(describeResult({})).toBe("Done");
    expect(describeResult(null)).toBe("Done");
  });
});

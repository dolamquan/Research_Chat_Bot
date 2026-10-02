import { describe, expect, it } from "vitest";

import type { AgentRunEvent, AgentRunSummary } from "../../../types";
import { buildTimeline, describeRun, formatMs } from "../runTimeline";

const events: AgentRunEvent[] = [
  { t_ms: 0, kind: "run_config", model: "gpt-5", effort: "low" },
  { t_ms: 300, kind: "context_loaded", ms: 280 },
  { t_ms: 1200, kind: "prompt_built", ms: 850, chars: 22000 },
  { t_ms: 1210, kind: "model_start", step: 1 },
  { t_ms: 3400, kind: "model_step", ms: 2190, ttft_ms: 2100, usage: { input: 6100, cached: 5000, reasoning: 64, output: 30 }, tool_calls: ["app_papers"] },
  { t_ms: 3410, kind: "tool_start", call_id: "c1", tool: "app_papers", arguments: { query: "graph" } },
  { t_ms: 3600, kind: "tool_output", call_id: "c1", tool: "app_papers", output: "{\"papers\": []}" },
  { t_ms: 3610, kind: "tool_result", call_id: "c1", tool: "app_papers", status: "success", duration_ms: 200 },
  { t_ms: 3620, kind: "tool_start", call_id: "c2", tool: "api.notes.update_note" },
  { t_ms: 3700, kind: "tool_result", call_id: "c2", tool: "api.notes.update_note", status: "error", message: "404 not found", duration_ms: 80 },
  { t_ms: 5100, kind: "model_step", ms: 1400, usage: { input: 6400, cached: 6000, reasoning: 0, output: 40 } },
  { t_ms: 5200, kind: "answer", text: "No graph papers yet." },
];

describe("buildTimeline", () => {
  it("merges each tool call into one row and orders everything by start time", () => {
    const rows = buildTimeline(events);
    expect(rows.map((row) => row.label)).toEqual([
      "Loaded conversation history and recent activity",
      "Built the instructions",
      "Model step 1: chose app_papers",
      "app_papers",
      "api.notes.update_note (error)",
      "Model step 2: wrote the reply",
      "Answered",
    ]);
    const tool = rows.find((row) => row.label === "app_papers")!;
    expect(tool.duration).toBe(200);
    expect(tool.detail).toBe('Arguments: {"query":"graph"}\nReturned: {"papers": []}');
    const failed = rows.find((row) => row.isError)!;
    expect(failed.detail).toBe("Error: 404 not found");
    const first = rows.find((row) => row.label.startsWith("Model step 1"))!;
    expect(first.at).toBe(1210);
    expect(first.detail).toBe("first output after 2.1s · 6100 input tokens (5000 cached) · 64 reasoning · 30 output");
  });

  it("numbers worker steps separately and labels them with the worker", () => {
    const rows = buildTimeline([
      { t_ms: 900, kind: "model_step", ms: 800, worker: "paper A", tool_calls: ["research.summarize_paper"] },
      { t_ms: 950, kind: "tool_start", call_id: "w1", tool: "research.summarize_paper", worker: "paper A" },
    ]);
    expect(rows.map((row) => row.label)).toEqual(["paper A: model step 1: chose research.summarize_paper", "paper A: research.summarize_paper"]);
  });
});

describe("describeRun", () => {
  it("says where the time went", () => {
    const run = {
      total_ms: 5200, prompt_ms: 850, model_ms: 3590, tool_ms: 280, steps: 2,
      tokens: { input: 12500, cached: 11000, output: 70, reasoning: 64 },
    } as AgentRunSummary;
    expect(describeRun(run)).toBe(
      `Took 5.2s: 850ms preparing, 3.6s in 2 model steps, 280ms in tools. ${(12500).toLocaleString()} input tokens (${(11000).toLocaleString()} cached), 64 reasoning.`,
    );
    expect(formatMs(null)).toBe("");
  });
});

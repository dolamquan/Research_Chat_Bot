/**
 * Turns a recorded assistant run into readable rows: one per model step, one
 * per tool call (its start, result and output merged), plus setup, errors and
 * the answer. Pure, so the Runs tab only renders.
 */
import type { AgentRunEvent, AgentRunSummary } from "../../types";

export type TimelineRow = {
  id: string;
  at: number;
  duration: number | null;
  label: string;
  detail: string;
  isError: boolean;
  worker: string;
};

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const str = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : JSON.stringify(value));
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function usageText(event: AgentRunEvent): string {
  const usage = event.usage as Record<string, number> | undefined;
  const parts: string[] = [];
  const ttft = num(event.ttft_ms);
  if (ttft !== null) parts.push(`first output after ${formatMs(ttft)}`);
  if (usage) {
    parts.push(`${usage.input ?? 0} input tokens (${usage.cached ?? 0} cached)`);
    parts.push(`${usage.reasoning ?? 0} reasoning`);
    parts.push(`${usage.output ?? 0} output`);
  }
  return parts.join(" · ");
}

export function buildTimeline(events: AgentRunEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const tools = new Map<string, TimelineRow>();
  let step = 0;
  let workerStep = 0;

  for (const [index, event] of events.entries()) {
    const worker = str(event.worker);
    const id = `${event.kind}-${index}`;
    // Durations are recorded when something finishes, so it started `ms` earlier.
    const started = event.t_ms - (num(event.ms) ?? 0);
    switch (event.kind) {
      case "context_loaded":
        rows.push({ id, at: started, duration: num(event.ms), label: "Loaded conversation history and recent activity", detail: "", isError: false, worker });
        break;
      case "prompt_built":
        rows.push({ id, at: started, duration: num(event.ms), label: "Built the instructions", detail: `${num(event.chars) ?? 0} characters`, isError: false, worker });
        break;
      case "model_step": {
        const calls = (event.tool_calls as string[] | undefined) ?? [];
        const number = worker ? ++workerStep : ++step;
        const chose = calls.length ? `chose ${calls.join(", ")}` : "wrote the reply";
        rows.push({
          id, at: started, duration: num(event.ms), label: `${worker ? `${worker}: model` : "Model"} step ${number}: ${chose}`,
          detail: usageText(event), isError: false, worker,
        });
        break;
      }
      case "tool_start": {
        const row: TimelineRow = {
          id, at: event.t_ms, duration: null, label: `${worker ? `${worker}: ` : ""}${str(event.tool)}`,
          detail: event.arguments ? `Arguments: ${str(event.arguments)}` : "", isError: false, worker,
        };
        tools.set(str(event.call_id), row);
        rows.push(row);
        break;
      }
      case "tool_output": {
        const row = tools.get(str(event.call_id));
        if (row) row.detail = [row.detail, `Returned: ${str(event.output)}`].filter(Boolean).join("\n");
        break;
      }
      case "tool_result": {
        const row = tools.get(str(event.call_id));
        if (!row) break;
        row.duration = num(event.duration_ms);
        row.isError = event.status === "error";
        if (event.status !== "success") row.label = `${row.label} (${str(event.status)})`;
        if (event.message && row.isError) row.detail = [`Error: ${str(event.message)}`, row.detail].filter(Boolean).join("\n");
        break;
      }
      case "confirmation_required":
        rows.push({ id, at: event.t_ms, duration: null, label: `Asked you to confirm ${str(event.tool)}`, detail: str(event.summary), isError: false, worker });
        break;
      case "error":
        rows.push({ id, at: event.t_ms, duration: null, label: "Error", detail: str(event.message), isError: true, worker });
        break;
      case "answer":
        rows.push({ id, at: event.t_ms, duration: null, label: "Answered", detail: str(event.text), isError: false, worker });
        break;
      default:
        break;
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

/** One sentence saying where the time went, for the top of a run. */
export function describeRun(run: AgentRunSummary): string {
  const spent: string[] = [];
  if (run.prompt_ms) spent.push(`${formatMs(run.prompt_ms)} preparing`);
  spent.push(`${formatMs(run.model_ms)} in ${run.steps} model step${run.steps === 1 ? "" : "s"}`);
  if (run.tool_ms) spent.push(`${formatMs(run.tool_ms)} in tools`);
  let text = `Took ${formatMs(run.total_ms)}: ${spent.join(", ")}.`;
  if (run.tokens && run.tokens.input) {
    text += ` ${run.tokens.input.toLocaleString()} input tokens (${run.tokens.cached.toLocaleString()} cached), ${run.tokens.reasoning.toLocaleString()} reasoning.`;
  }
  return text;
}

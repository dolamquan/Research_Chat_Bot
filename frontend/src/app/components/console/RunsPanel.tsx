import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { getAgentRun, listAgentRuns } from "../../api";
import type { AgentRunDetail, AgentRunSummary } from "../../types";
import { glass, glassActive, glassHover } from "./glass";
import { buildTimeline, describeRun, formatMs } from "./runTimeline";

type Filter = "all" | "error";

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
}

function outcome(run: AgentRunSummary): string {
  if (run.status === "error") return "failed";
  if (run.status === "cancelled") return "cancelled";
  return run.errors ? `${run.errors} tool error${run.errors === 1 ? "" : "s"}` : "ok";
}

/**
 * Zoe's flight recorder: the newest runs, each with every model step and tool
 * call in order, how long it took and what it returned. This is where you
 * trace why a request was slow or what went wrong behind the scenes.
 */
export function RunsPanel() {
  const [filter, setFilter] = useState<Filter>("all");
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    listAgentRuns({ status: filter === "error" ? "error" : undefined })
      .then((response) => {
        if (!live) return;
        setRuns(response.runs);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof Error ? caught.message : "Could not load runs.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [filter, reloadKey]);

  useEffect(() => {
    setDetail(null);
    if (!selectedId) return;
    let live = true;
    getAgentRun(selectedId)
      .then((response) => {
        if (live) setDetail(response);
      })
      .catch(() => {
        if (live) setDetail(null);
      });
    return () => {
      live = false;
    };
  }, [selectedId]);

  const rows = useMemo(() => buildTimeline(detail?.events ?? []), [detail]);
  const total = Math.max(1, detail?.total_ms ?? 1);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1 border-b border-border p-2">
          <div className="flex gap-1" role="tablist" aria-label="Run filter">
            {(["all", "error"] as Filter[]).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={filter === option}
                onClick={() => setFilter(option)}
                className={`rounded px-2 py-1 text-xs ${filter === option ? "rm-active-surface text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
              >
                {option === "all" ? "All runs" : "Failed"}
              </button>
            ))}
          </div>
          <button
            type="button"
            title="Refresh"
            aria-label="Refresh runs"
            onClick={() => setReloadKey((key) => key + 1)}
            className="ml-auto rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3" data-testid="run-list">
          {loading ? (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Loading runs…
            </p>
          ) : error ? (
            <p role="alert" className="px-2 py-3 text-xs text-destructive">
              {error}
            </p>
          ) : runs.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No runs recorded yet. Ask Zoe something and it appears here.</p>
          ) : (
            runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedId(run.id)}
                className={`block w-full px-3 py-2.5 text-left ${glass} ${selectedId === run.id ? glassActive : glassHover}`}
              >
                <span className="block truncate text-xs text-foreground">{run.question || "(no text)"}</span>
                <span className="flex gap-2 text-[10px] text-muted-foreground">
                  <span>{formatMs(run.total_ms)}</span>
                  <span>{run.steps} steps</span>
                  <span>{run.tool_calls} tools</span>
                  <span className={run.status === "ok" && !run.errors ? "" : "text-destructive"}>{outcome(run)}</span>
                </span>
                <span className="block text-[10px] text-muted-foreground">{when(run.created_at)}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!selectedId ? (
          <div className="p-8 text-sm text-muted-foreground">
            <p>Select a run to see every model step and tool call in order, with timings.</p>
            <p className="mt-2 text-xs">The newest 300 runs are kept.</p>
          </div>
        ) : !detail ? (
          <p className="flex items-center gap-2 p-8 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" /> Loading run…
          </p>
        ) : (
          <div className={`m-6 max-w-3xl space-y-5 p-6 ${glass}`} data-testid="run-detail">
            <div>
              <h3 className="text-base text-foreground">{detail.question || "(no text)"}</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {when(detail.created_at)} · {detail.model || "default model"}
                {detail.effort ? ` · ${detail.effort} reasoning` : ""} · {outcome(detail)}
              </p>
              <p className="mt-2 text-xs text-foreground" data-testid="run-summary">{describeRun(detail)}</p>
            </div>
            <ol className="space-y-1">
              {rows.map((row) => (
                <li key={row.id} className="text-xs">
                  <div className="flex items-baseline gap-3">
                    <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">+{formatMs(row.at)}</span>
                    <span className={`min-w-0 flex-1 ${row.isError ? "text-destructive" : "text-foreground"}`}>{row.label}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatMs(row.duration)}</span>
                  </div>
                  {row.duration !== null && (
                    <div className="ml-[4.25rem] mt-0.5 h-px bg-border">
                      <div
                        className="h-px bg-foreground/60"
                        style={{ marginLeft: `${(row.at / total) * 100}%`, width: `${Math.max(0.5, (row.duration / total) * 100)}%` }}
                      />
                    </div>
                  )}
                  {row.detail && (
                    <details className="ml-[4.25rem] mt-0.5">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">Details</summary>
                      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-[11px] text-muted-foreground">
                        {row.detail}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

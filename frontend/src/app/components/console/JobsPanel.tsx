import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { getEvaluationRuns, getIngestionJobs } from "../../api";
import type { EvaluationRun, IngestionJob } from "../../types";
import { glass } from "./glass";

const ACTIVE = new Set(["queued", "running"]);
const POLL_MS = 5000;

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function statusClass(status: string): string {
  if (status === "failed") return "text-destructive";
  if (ACTIVE.has(status)) return "text-primary";
  return "text-muted-foreground";
}

/**
 * Background work in one place. Ingestion jobs used to live in a collapsible
 * corner of the Chat sidebar and evaluation runs in a view with no way in;
 * both are "the machine is working", and both are polled here while active.
 */
export function JobsPanel({ onOpenView }: { onOpenView: (view: "evaluation" | "crawler" | "library") => void }) {
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([getIngestionJobs(50), getEvaluationRuns()])
      .then(([ingestion, evaluation]) => {
        if (!live) return;
        setJobs(ingestion.jobs);
        setRuns(evaluation.runs);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof Error ? caught.message : "Could not load jobs.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [tick]);

  // Poll only while something is actually running.
  const active = jobs.some((job) => ACTIVE.has(job.status));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  return (
    <div className="h-full min-h-0 overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {active ? "Refreshing every 5 s while jobs run." : "Nothing is running."}
        </p>
        <button
          type="button"
          onClick={() => setTick((value) => value + 1)}
          className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error ? (
        <p role="alert" className="mb-4 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <section className={`mb-5 p-5 ${glass}`} data-testid="ingestion-jobs">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-xs text-muted-foreground">Ingestion · {jobs.length}</h3>
          <button type="button" onClick={() => onOpenView("crawler")} className="text-xs text-muted-foreground hover:text-foreground">
            Add papers →
          </button>
        </div>
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </p>
        ) : jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No ingestion jobs yet.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-normal">Paper</th>
                <th className="py-1 pr-3 font-normal">Status</th>
                <th className="py-1 pr-3 font-normal">Stage</th>
                <th className="py-1 font-normal">Updated</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.job_id} className="border-t border-border/60 align-top">
                  <td className="max-w-md py-1.5 pr-3">
                    <span className="block truncate text-foreground">{job.article_title || job.title || job.url}</span>
                    {job.error ? <span className="block truncate text-destructive">{job.error}</span> : job.message ? <span className="block truncate text-muted-foreground">{job.message}</span> : null}
                  </td>
                  <td className={`py-1.5 pr-3 font-mono ${statusClass(job.status)}`}>{job.status}</td>
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{job.stage}</td>
                  <td className="whitespace-nowrap py-1.5 text-muted-foreground">{when(job.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={`p-5 ${glass}`} data-testid="evaluation-runs">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-xs text-muted-foreground">Evaluation runs · {runs.length}</h3>
          <button type="button" onClick={() => onOpenView("evaluation")} className="text-xs text-muted-foreground hover:text-foreground">
            Open dashboard →
          </button>
        </div>
        {loading ? null : runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No evaluation runs yet. Start one from the dashboard.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-normal">Run</th>
                <th className="py-1 pr-3 font-normal">Kind</th>
                <th className="py-1 pr-3 font-normal">Cases</th>
                <th className="py-1 pr-3 font-normal">Overall</th>
                <th className="py-1 pr-3 font-normal">Avg latency</th>
                <th className="py-1 font-normal">Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id} className="border-t border-border/60">
                  <td className="py-1.5 pr-3 font-mono text-foreground">{run.run_id.slice(0, 12)}</td>
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{run.kind}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{run.case_count}</td>
                  <td className="py-1.5 pr-3 text-foreground">{run.overall == null ? "—" : run.overall.toFixed(2)}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{run.average_latency_seconds.toFixed(1)} s</td>
                  <td className="whitespace-nowrap py-1.5 text-muted-foreground">{when(run.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="mt-8 text-[11px] leading-relaxed text-muted-foreground">
        Scene preparation runs in your browser: each animation is generated, executed off-screen, repaired if it
        crashes, and only then marked ready. Watch that from the Visualizer&apos;s Prepare all.
      </p>
    </div>
  );
}

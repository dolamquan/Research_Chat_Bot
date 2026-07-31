import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Activity, BarChart3, Gauge, Loader2, RefreshCw, ShieldCheck, Target } from "lucide-react";

import {
  getEvaluationRun,
  getEvaluationRuns,
  runRagasEvaluation,
} from "../api";
import type { EvaluationCase, EvaluationRun } from "../types";

const METRIC_LABELS: Record<string, string> = {
  answer_correctness: "Answer correctness",
  answer_relevancy: "Answer relevance",
  context_precision: "Context precision",
  context_recall: "Context recall",
  context_relevance: "Context relevance",
  faithfulness: "Faithfulness",
  overall: "Overall",
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return "--";
  return `${Math.round(value * 100)}%`;
}

function scoreTone(value: number | null | undefined): string {
  if (value === null || value === undefined) return "text-muted-foreground";
  if (value >= 0.8) return "text-green-400";
  if (value >= 0.55) return "text-primary";
  return "text-destructive";
}

function metricEntries(run?: EvaluationRun | null) {
  if (!run) return [];
  return Object.entries(run.metrics || {}).filter(([, value]) => value !== undefined);
}

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | null | undefined;
  icon: ReactNode;
}) {
  const percent = Math.max(0, Math.min(100, Math.round((value || 0) * 100)));

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {label}
          </p>
          <p className={`mt-2 text-2xl font-semibold ${scoreTone(value)}`}>
            {formatScore(value)}
          </p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded border border-primary/25 bg-primary/10 text-primary">
          {icon}
        </div>
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded bg-secondary">
        <div
          className="h-full rounded bg-primary transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function RunTrend({ runs }: { runs: EvaluationRun[] }) {
  const trend = runs.slice().reverse().slice(-10);
  const maxLatency = Math.max(...trend.map((run) => run.average_latency_seconds || 0), 1);

  if (!trend.length) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
        Run an evaluation to start tracking quality over time.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Quality trend
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Last {trend.length} saved evaluation runs
          </p>
        </div>
        <BarChart3 size={18} className="text-primary" />
      </div>
      <div className="flex h-52 items-end gap-3">
        {trend.map((run) => {
          const qualityHeight = Math.max(4, Math.round((run.overall || 0) * 100));
          const latencyHeight = Math.max(
            4,
            Math.round(((run.average_latency_seconds || 0) / maxLatency) * 100),
          );
          return (
            <div key={run.run_id} className="flex min-w-0 flex-1 flex-col items-center gap-2">
              <div className="flex h-36 w-full items-end justify-center gap-1">
                <div
                  title={`Quality ${formatScore(run.overall)}`}
                  className="w-4 rounded-t bg-primary"
                  style={{ height: `${qualityHeight}%` }}
                />
                <div
                  title={`Latency ${run.average_latency_seconds}s`}
                  className="w-4 rounded-t bg-muted-foreground/50"
                  style={{ height: `${latencyHeight}%` }}
                />
              </div>
              <p className="w-full truncate text-center font-mono text-[9px] text-muted-foreground">
                RAGAS
              </p>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-4 font-mono text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded bg-primary" />
          quality
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded bg-muted-foreground/50" />
          latency
        </span>
      </div>
    </div>
  );
}

function CaseRow({ item }: { item: EvaluationCase }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-6">{item.question}</p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
            {item.source_count} sources - {item.latency_seconds}s
          </p>
        </div>
        <span className={`font-mono text-xs font-semibold ${scoreTone(item.overall)}`}>
          {formatScore(item.overall)}
        </span>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {Object.entries(item.metrics || {}).map(([key, value]) => (
          <div key={key} className="rounded border border-border bg-background px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {METRIC_LABELS[key] || key}
              </span>
              <span className={`font-mono text-xs ${scoreTone(value)}`}>
                {formatScore(value)}
              </span>
            </div>
          </div>
        ))}
      </div>
      {item.feedback && (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{item.feedback}</p>
      )}
    </div>
  );
}

export function EvaluationDashboard() {
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<EvaluationRun | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  async function loadRuns(nextRunId?: string) {
    setIsLoading(true);
    setError("");
    try {
      const result = await getEvaluationRuns();
      const ragasRuns = result.runs.filter((run) => run.kind === "ragas");
      setRuns(ragasRuns);
      const targetRun =
        ragasRuns.find((run) => run.run_id === nextRunId) ||
        (result.latest?.kind === "ragas" ? result.latest : null) ||
        ragasRuns[0] ||
        null;
      if (targetRun) {
        const detail = await getEvaluationRun(targetRun.run_id);
        setSelectedRun(detail);
      } else {
        setSelectedRun(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load evaluation runs.");
    } finally {
      setIsLoading(false);
    }
  }

  async function selectRun(runId: string) {
    setError("");
    try {
      const detail = await getEvaluationRun(runId);
      setSelectedRun(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load evaluation run.");
    }
  }

  async function runEvaluation() {
    setIsRunning(true);
    setError("");
    setStatus("Running RAGAS evaluation...");
    try {
      await runRagasEvaluation();
      setStatus("Evaluation complete. Dashboard refreshed.");
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Evaluation failed.");
    } finally {
      setIsRunning(false);
    }
  }

  useEffect(() => {
    void loadRuns();
  }, []);

  const cases = selectedRun?.cases || [];
  const weakCases = useMemo(
    () =>
      cases
        .slice()
        .sort((a, b) => (a.overall ?? -1) - (b.overall ?? -1))
        .slice(0, 6),
    [cases],
  );
  const metrics = metricEntries(selectedRun);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background">
      <div className="mx-auto max-w-7xl space-y-5 px-6 py-6">
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded border border-primary/30 bg-primary/10 text-primary">
                <Activity size={19} />
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  RAG evaluation
                </p>
                <h2 className="text-2xl font-semibold">Evaluation dashboard</h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Track answer quality, faithfulness, retrieval relevance, source coverage, and latency from saved evaluation runs.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void loadRuns(selectedRun?.run_id)}
                disabled={isLoading || isRunning}
                className="inline-flex h-9 items-center gap-2 rounded border border-border bg-background px-3 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-60"
              >
                {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Refresh
              </button>
              <button
                type="button"
                onClick={() => void runEvaluation()}
                disabled={isRunning}
                className="inline-flex h-9 items-center gap-2 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {isRunning ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                Run RAGAS
              </button>
            </div>
          </div>
          {(status || error) && (
            <div className="mt-4">
              {error ? (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : (
                <div className="rounded border border-primary/25 bg-primary/10 px-3 py-2 text-sm text-primary">
                  {status}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Overall quality" value={selectedRun?.overall} icon={<Target size={18} />} />
          <MetricCard label="Faithfulness" value={selectedRun?.metrics?.faithfulness} icon={<ShieldCheck size={18} />} />
          <MetricCard
            label="Answer relevance"
            value={selectedRun?.metrics?.answer_relevancy}
            icon={<Gauge size={18} />}
          />
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Average latency
            </p>
            <p className="mt-2 text-2xl font-semibold">
              {selectedRun ? `${selectedRun.average_latency_seconds}s` : "--"}
            </p>
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              {selectedRun
                ? `${selectedRun.case_count} cases - RAGAS`
                : "No run selected"}
            </p>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <RunTrend runs={runs} />

          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border p-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Saved runs
              </p>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {runs.length ? (
                runs.map((run) => (
                  <button
                    key={run.run_id}
                    type="button"
                    onClick={() => void selectRun(run.run_id)}
                    className={`w-full border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-secondary ${
                      selectedRun?.run_id === run.run_id ? "bg-primary/10" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">
                        RAGAS
                      </span>
                      <span className={`font-mono text-xs ${scoreTone(run.overall)}`}>
                        {formatScore(run.overall)}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {formatDate(run.created_at)} - {run.case_count} cases
                    </p>
                  </button>
                ))
              ) : (
                <div className="p-4 text-sm text-muted-foreground">
                  No saved evaluation runs yet.
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Metric breakdown
            </p>
            <div className="mt-4 space-y-3">
              {metrics.length ? (
                metrics.map(([key, value]) => (
                  <div key={key}>
                    <div className="mb-1 flex items-center justify-between gap-3">
                      <span className="text-xs text-muted-foreground">
                        {METRIC_LABELS[key] || key}
                      </span>
                      <span className={`font-mono text-xs ${scoreTone(value)}`}>
                        {formatScore(value)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded bg-secondary">
                      <div
                        className="h-full rounded bg-primary"
                        style={{ width: `${Math.max(0, Math.min(100, Math.round((value || 0) * 100)))}%` }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No metrics available.</p>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border p-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Weakest cases
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Start debugging here: these questions had the lowest overall quality.
              </p>
            </div>
            <div className="space-y-3 p-4">
              {weakCases.length ? (
                weakCases.map((item) => <CaseRow key={item.id} item={item} />)
              ) : (
                <div className="rounded border border-border bg-background p-6 text-center text-sm text-muted-foreground">
                  No case-level results available yet.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

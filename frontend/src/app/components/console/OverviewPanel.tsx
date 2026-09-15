import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { getAgentSession, getAgentSessions, getIngestionJobs } from "../../api";
import type { AgentSession, IngestionJob } from "../../types";
import { summarizeChanges } from "./ActivityPanel";
import { glass } from "./glass";
import { loadSnapshot, unavailableByReason, type Snapshot } from "./snapshot";

export type ConsoleTab = "overview" | "tools" | "activity" | "jobs" | "diagnostics";

const RECENT = 5;
const ACTIVE = new Set(["queued", "running"]);

type Recent = AgentSession & { changes: string };

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? `Today ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function Block({ title, action, children, testId }: { title: string; action?: React.ReactNode; children: React.ReactNode; testId: string }) {
  return (
    <section data-testid={testId} className={`p-5 ${glass}`}>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-xs text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Jump({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-xs text-muted-foreground hover:text-foreground">
      {children}
    </button>
  );
}

/**
 * The landing page: four questions answered in sentences. What is running,
 * what Zoe did recently and whether it changed anything, what she cannot
 * currently reach and why, and whether the backend is healthy. Everything
 * detailed is one click away; nothing detailed is shown here.
 */
export function OverviewPanel({ onOpenTab }: { onOpenTab: (tab: ConsoleTab) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [recent, setRecent] = useState<Recent[] | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void loadSnapshot().then((next) => {
      if (live) setSnapshot(next);
    });
    getIngestionJobs(20)
      .then((response) => {
        if (live) setJobs(response.jobs);
      })
      .catch((error: unknown) => {
        if (live) setFailures((current) => [...current, `jobs: ${error instanceof Error ? error.message : String(error)}`]);
      });
    getAgentSessions("all")
      .then(async (response) => {
        const head = response.sessions.slice(0, RECENT);
        const details = await Promise.allSettled(head.map((session) => getAgentSession(session.id)));
        if (!live) return;
        setRecent(
          head.map((session, index) => {
            const detail = details[index];
            if (detail.status !== "fulfilled") return { ...session, changes: "" };
            const summary = summarizeChanges(detail.value.messages.flatMap((message) => message.tool_trace ?? []));
            return { ...session, changes: summary.total ? summary.parts.join(", ") : "read only" };
          }),
        );
      })
      .catch((error: unknown) => {
        if (!live) return;
        setRecent([]);
        setFailures((current) => [...current, `sessions: ${error instanceof Error ? error.message : String(error)}`]);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!snapshot) {
    return (
      <p className="flex items-center gap-2 p-8 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" /> Reading the machine…
      </p>
    );
  }

  const { context } = snapshot;
  const active = jobs.filter((job) => ACTIVE.has(job.status));
  const failed = jobs.filter((job) => job.status === "failed");
  const notConnected = snapshot.integrations.filter((integration) => !integration.configured);
  const connected = snapshot.integrations.filter((integration) => integration.configured);
  const unavailable = unavailableByReason(context);
  const attention: React.ReactNode[] = [];
  if (snapshot.health !== "ok") attention.push(<>The backend is unreachable. Nothing below can be trusted until it is back.</>);
  if (snapshot.providers.length === 0) {
    attention.push(<>No model provider is reachable — chat, diagrams and scenes all need one. Set <code className="font-mono">OPENAI_API_KEY</code> or <code className="font-mono">ANTHROPIC_API_KEY</code>.</>);
  }
  for (const group of unavailable) {
    attention.push(
      <>
        {group.names.length} tool{group.names.length === 1 ? "" : "s"} unavailable — {group.reason}.{" "}
        <span className="font-mono text-muted-foreground">{group.names.slice(0, 3).join(", ")}{group.names.length > 3 ? ", …" : ""}</span>
      </>,
    );
  }
  for (const integration of notConnected) attention.push(<>{integration.label} is not connected. Connect it from Notes to let Zoe publish there.</>);
  if (snapshot.missingRoutes.length) {
    attention.push(<>{snapshot.missingRoutes.length} route{snapshot.missingRoutes.length === 1 ? "" : "s"} this frontend expects are missing from the backend — it is older than the frontend. Restart it.</>);
  }
  if (failed.length) attention.push(<>{failed.length} ingestion job{failed.length === 1 ? "" : "s"} failed. See Jobs for the error.</>);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 px-6 py-6 md:px-8">
        <p className={`px-1 text-sm ${snapshot.health === "ok" ? "text-foreground" : "text-destructive"}`} data-testid="overview-status">
          {snapshot.health === "ok" ? "Backend online" : "Backend unreachable"}
          {context ? ` · ${context.paper_count} papers indexed · ${context.tool_count} tools` : ""}
          {snapshot.providers.length ? ` · model: ${snapshot.providers.join(", ")}` : ""}
          {connected.length ? ` · ${connected.map((integration) => integration.label).join(" and ")} connected` : ""}
        </p>

        {[...snapshot.failures, ...failures].length > 0 ? (
          <ul role="alert" className="space-y-0.5 text-xs text-destructive">
            {[...snapshot.failures, ...failures].map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        ) : null}

        <Block title="Running now" testId="overview-running" action={<Jump onClick={() => onOpenTab("jobs")}>All jobs →</Jump>}>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is running.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {active.map((job) => (
                <li key={job.job_id} className="flex items-baseline gap-2">
                  <span className="truncate text-foreground">{job.article_title || job.title || job.url}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{job.stage}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title="Recent activity" testId="overview-activity" action={<Jump onClick={() => onOpenTab("activity")}>All activity →</Jump>}>
          {recent === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">Zoe has not done anything yet.</p>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {recent.map((session) => (
                <li key={session.id} className="flex items-baseline gap-3 py-1.5">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">{when(session.updated_at)}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{session.title}</span>
                  <span className={`shrink-0 text-xs ${session.changes && session.changes !== "read only" ? "text-foreground" : "text-muted-foreground"}`}>
                    {session.changes}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title="Needs attention" testId="overview-attention" action={<Jump onClick={() => onOpenTab("diagnostics")}>Full diagnostics →</Jump>}>
          {attention.length === 0 ? (
            <p className="text-sm text-muted-foreground">Everything Zoe can reach is available.</p>
          ) : (
            <ul className="space-y-1.5 text-sm text-foreground">
              {attention.map((item, index) => (
                <li key={index} className="leading-relaxed">
                  {item}
                </li>
              ))}
            </ul>
          )}
        </Block>

        <p className="px-1 text-xs text-muted-foreground">
          Zoe runs {context?.tool_count ?? "the"} tools across the app.{" "}
          <Jump onClick={() => onOpenTab("tools")}>Browse them, or run one by hand →</Jump>
        </p>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { deleteAgentSession, getAgentSession, getAgentSessions } from "../../api";
import type { AgentSession, AgentSessionDetail, AgentToolTrace } from "../../types";
import { ToolTimeline } from "../agent/ToolTimeline";
import { FormattedText } from "../MarkdownBody";
import { glass, glassActive, glassHover } from "./glass";

type Kind = "all" | "assistant" | "agent";

const KIND_LABEL: Record<string, string> = { assistant: "Zoe", agent: "Agent tab (retired)" };

/** What a session changed, counted from its tool traces. Reads are not changes. */
export function summarizeChanges(traces: AgentToolTrace[]): { total: number; parts: string[] } {
  const counts = { write: 0, destructive: 0, external_write: 0 };
  for (const step of traces) {
    if (step.status === "error" || step.status === "skipped") continue;
    if (step.effect === "write") counts.write += 1;
    else if (step.effect === "destructive") counts.destructive += 1;
    else if (step.effect === "external_write") counts.external_write += 1;
  }
  const parts: string[] = [];
  if (counts.write) parts.push(`${counts.write} write${counts.write === 1 ? "" : "s"}`);
  if (counts.destructive) parts.push(`${counts.destructive} delete${counts.destructive === 1 ? "" : "s"}`);
  if (counts.external_write) parts.push(`${counts.external_write} external write${counts.external_write === 1 ? "" : "s"}`);
  return { total: counts.write + counts.destructive + counts.external_write, parts };
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Every conversation the agent has had, both Zoe's and the retired Agent
 * tab's, in one place — with what each one changed called out. Zoe's own
 * history is a scrollback in a dock; this is where you check what she did
 * to your notes or pushed to Notion last Tuesday.
 */
export function ActivityPanel() {
  const [kind, setKind] = useState<Kind>("all");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getAgentSessions(kind)
      .then((response) => {
        if (!live) return;
        setSessions(response.sessions);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof Error ? caught.message : "Could not load sessions.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [kind]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetailLoading(true);
    getAgentSession(selectedId)
      .then((response) => {
        if (live) setDetail(response);
      })
      .catch(() => {
        if (live) setDetail(null);
      })
      .finally(() => {
        if (live) setDetailLoading(false);
      });
    return () => {
      live = false;
    };
  }, [selectedId]);

  const changes = useMemo(
    () => summarizeChanges((detail?.messages ?? []).flatMap((message) => message.tool_trace ?? [])),
    [detail],
  );

  async function remove(sessionId: string) {
    if (!window.confirm("Delete this session and its history?")) return;
    try {
      await deleteAgentSession(sessionId);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      if (selectedId === sessionId) setSelectedId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the session.");
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="flex gap-1 border-b border-border p-2" role="tablist" aria-label="Session kind">
          {(["all", "assistant", "agent"] as Kind[]).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={kind === option}
              onClick={() => setKind(option)}
              className={`rounded px-2 py-1 text-xs ${kind === option ? "rm-active-surface text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
            >
              {option === "all" ? "All" : option === "assistant" ? "Zoe" : "Agent tab"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3" data-testid="session-list">
          {loading ? (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Loading sessions…
            </p>
          ) : error ? (
            <p role="alert" className="px-2 py-3 text-xs text-destructive">
              {error}
            </p>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No sessions yet.</p>
          ) : (
            sessions.map((session) => (
              <div
                key={session.id}
                className={`group flex items-start gap-1 ${glass} ${selectedId === session.id ? glassActive : glassHover}`}
              >
                <button type="button" onClick={() => setSelectedId(session.id)} className="min-w-0 flex-1 px-3 py-2.5 text-left">
                  <span className="block truncate text-xs text-foreground">{session.title}</span>
                  <span className="flex gap-2 text-[10px] text-muted-foreground">
                    <span>{KIND_LABEL[session.kind ?? "agent"] ?? session.kind}</span>
                    <span>{when(session.updated_at)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  title="Delete session"
                  aria-label={`Delete session ${session.title}`}
                  onClick={() => void remove(session.id)}
                  className="mr-1 mt-1.5 rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!selectedId ? (
          <div className="p-8 text-sm text-muted-foreground">
            <p>Select a session to see its turns and every tool that ran.</p>
            <p className="mt-2 text-xs">Writes, deletes and external writes are called out at the top of each session.</p>
          </div>
        ) : detailLoading || !detail ? (
          <p className="flex items-center gap-2 p-8 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" /> Loading session…
          </p>
        ) : (
          <div className={`m-6 max-w-3xl space-y-5 p-6 ${glass}`} data-testid="session-detail">
            <div>
              <h3 className="text-base text-foreground">{detail.session.title}</h3>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {KIND_LABEL[detail.session.kind ?? "agent"] ?? detail.session.kind} · {detail.messages.length} messages ·
                started {when(detail.session.created_at)}
              </p>
              <p className={`mt-2 text-xs ${changes.total ? "text-foreground" : "text-muted-foreground"}`} data-testid="session-changes">
                {changes.total ? `Changed: ${changes.parts.join(" · ")}` : "No changes — this session only read."}
              </p>
            </div>
            <ol className="space-y-4">
              {detail.messages.map((message, index) => (
                <li key={`${message.created_at}-${index}`} className="min-w-0">
                  <p className="mb-1 text-xs text-muted-foreground">
                    {message.role === "user" ? "You" : detail.session.kind === "assistant" ? "Zoe" : "Agent"} · {when(message.created_at)}
                  </p>
                  {message.role === "user" ? (
                    <p className="whitespace-pre-wrap text-sm text-foreground">{message.content}</p>
                  ) : (
                    <div className="border-l-2 border-border pl-3 text-sm">
                      <FormattedText content={message.content} />
                      <ToolTimeline compact trace={message.tool_trace} />
                    </div>
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

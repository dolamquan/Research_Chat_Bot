import { CheckCircle2, CircleDot, Loader2, MinusCircle, XCircle } from "lucide-react";

import type { AgentToolTrace } from "../../types";

export function ToolStatusIcon({ status }: { status?: string }) {
  if (status === "running") {
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />;
  }

  if (status === "error") {
    return <XCircle size={12} className="text-destructive" />;
  }

  if (status === "skipped") {
    return <MinusCircle size={12} className="text-muted-foreground" />;
  }

  if (status === "planned") {
    return <CircleDot size={12} className="text-primary" />;
  }

  return <CheckCircle2 size={12} className="text-primary" />;
}

/**
 * The list of tool calls behind an answer, shared by the Agent tab and the
 * assistant panel. `compact` drops the heading and left margin.
 */
export function ToolTimeline({ trace, compact = false }: { trace?: AgentToolTrace[]; compact?: boolean }) {
  if (!trace || trace.length === 0) {
    return null;
  }

  return (
    <div className={compact ? "mt-2 border-l border-primary/20 pl-3" : "ml-6 mt-3 border-l border-primary/20 pl-3"}>
      {!compact && (
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Tool timeline
        </div>
      )}
      <div className="space-y-1.5">
        {trace.map((step, index) => (
          <div
            key={`${step.tool}-${step.timestamp}-${index}`}
            className="grid grid-cols-[0.9rem_minmax(8rem,12rem)_1fr] items-start gap-2 text-[11px]"
          >
            <ToolStatusIcon status={step.status} />
            <span className="break-words text-primary" title={step.arguments || undefined}>
              {step.tool}
              {step.effect && step.effect !== "read" && (
                <span className="ml-1 text-muted-foreground">[{step.effect}]</span>
              )}
            </span>
            <span
              title={step.message}
              className={
                step.status === "error"
                  ? "break-words text-destructive"
                  : "break-words text-muted-foreground"
              }
            >
              {step.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

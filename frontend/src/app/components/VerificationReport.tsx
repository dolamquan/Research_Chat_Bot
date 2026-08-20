import { useMemo, useState } from "react";
import { ChevronDown, Loader2, RefreshCw, ShieldCheck } from "lucide-react";

import type {
  FindingSeverity,
  VerificationFinding,
  VerificationReportData,
} from "../types";
import { severityTone, verdictLabel, verdictTone } from "./diagramPalette";

/**
 * Severity carries the colour, so the distinction that actually matters —
 * whether a finding was *proved* or *judged* — is carried by form instead:
 * a solid spine and a CHECK tag for deterministic checks, a dashed spine and
 * JUDGED for model opinion. Confidence is only shown for judgments, because
 * a structural check is certain by construction and printing "100%" is noise.
 */

const SEVERITY_ORDER: FindingSeverity[] = [
  "blocking",
  "major",
  "minor",
  "speculative",
];

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
      {children}
    </div>
  );
}

function SeverityTile({
  severity,
  count,
  total,
  active,
  onClick,
}: {
  severity: FindingSeverity;
  count: number;
  total: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-2.5 text-left transition-colors ${
        active
          ? "border-teal-700 bg-teal-500/10"
          : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
      }`}
    >
      <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">
        {severity}
      </div>
      <div className={`text-xl font-semibold ${severityTone(severity)}`}>
        {count}
      </div>
      <span className="mt-1 block h-1 rounded bg-zinc-800">
        <span
          className="block h-full rounded bg-current opacity-70"
          style={{
            width: `${total ? (count / total) * 100 : 0}%`,
            color: "currentColor",
          }}
        />
      </span>
    </button>
  );
}

function FindingRow({
  finding,
  onFocus,
}: {
  finding: VerificationFinding;
  onFocus: (nodeIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const proved = finding.basis === "deterministic";
  const tone = severityTone(finding.severity);

  return (
    <div
      className={`border-l-2 pl-3 ${proved ? "border-solid" : "border-dashed"}`}
      style={{ borderLeftColor: "currentColor" }}
    >
      <div className={tone}>
        <button
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-start justify-between gap-2 py-1.5 text-left"
        >
          <span className="text-xs font-medium text-zinc-100">
            {finding.title}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {finding.inherited && (
              <span
                className="rounded bg-zinc-800 px-1 font-mono text-[9px] text-zinc-400"
                title="The original diagram already had this. Your change did not cause it."
              >
                pre-existing
              </span>
            )}
            <span className={`font-mono text-[9px] uppercase ${tone}`}>
              {finding.severity}
            </span>
            <ChevronDown
              className={`h-3 w-3 text-zinc-500 transition-transform ${
                open ? "rotate-180" : ""
              }`}
            />
          </span>
        </button>
      </div>

      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[9px] text-zinc-500">
        <span>{finding.finding_id}</span>
        <span>·</span>
        <span>{finding.category}</span>
        <span>·</span>
        <span
          title={
            proved
              ? "Structural check run over the graph."
              : "Model judgment — not a proof."
          }
          className={proved ? "text-zinc-400" : "text-amber-200/70"}
        >
          {proved ? "CHECK" : "JUDGED"}
        </span>
        {!proved && (
          <span className="text-zinc-600">
            {"▮".repeat(
              finding.confidence === "high"
                ? 3
                : finding.confidence === "medium"
                  ? 2
                  : 1,
            )}
            {"▯".repeat(
              finding.confidence === "high"
                ? 0
                : finding.confidence === "medium"
                  ? 1
                  : 2,
            )}
          </span>
        )}
      </div>

      {open && (
        <div className="pb-2">
          <p className="mb-2 text-xs leading-relaxed text-zinc-400">
            {finding.failure_scenario}
          </p>
          {finding.node_ids.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {finding.node_ids.map((id) => (
                <button
                  key={id}
                  onClick={() => onFocus([id])}
                  className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 transition-colors hover:border-teal-600 hover:text-teal-200"
                >
                  {id}
                </button>
              ))}
            </div>
          )}
          {finding.evidence && (
            <p className="mt-2 border-l-2 border-teal-800 pl-2 text-[11px] italic text-zinc-400">
              {finding.evidence}
            </p>
          )}
          {finding.suggested_probe && (
            <p className="mt-2 rounded border border-amber-900/50 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200/80">
              Test it: {finding.suggested_probe}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function VerificationReport({
  report,
  loading,
  error,
  onReverify,
  onFocusNodes,
}: {
  report: VerificationReportData | null;
  loading: boolean;
  error: string | null;
  onReverify: () => void;
  onFocusNodes: (nodeIds: string[]) => void;
}) {
  const [filter, setFilter] = useState<FindingSeverity | null>(null);

  const caused = useMemo(
    () => (report?.findings ?? []).filter((finding) => !finding.inherited),
    [report],
  );
  const inherited = useMemo(
    () => (report?.findings ?? []).filter((finding) => finding.inherited),
    [report],
  );
  const counts = useMemo(() => {
    const result: Record<FindingSeverity, number> = {
      blocking: 0,
      major: 0,
      minor: 0,
      speculative: 0,
    };
    for (const finding of caused) result[finding.severity] += 1;
    return result;
  }, [caused]);

  const visible = filter
    ? caused.filter((finding) => finding.severity === filter)
    : caused;
  const provedCount = caused.filter((f) => f.basis === "deterministic").length;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-teal-900/60 bg-teal-500/10 text-teal-300">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div>
            <SectionLabel>Verification</SectionLabel>
            {report && (
              <span
                className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${verdictTone(
                  report.verdict,
                )}`}
              >
                {verdictLabel(report.verdict)}
              </span>
            )}
          </div>
        </div>
        {report && (
          <button
            onClick={onReverify}
            disabled={loading}
            title="Re-run verification"
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-teal-300 disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-red-900/60 bg-red-950/80 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && !report && (
        <div className="flex items-center gap-2 py-4 text-xs text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-300" />
          Checking the modification…
        </div>
      )}

      {!report && !loading && !error && (
        <p className="text-xs text-zinc-500">
          Apply a modification and it will be checked here: what the change
          breaks structurally, and what was already wrong before it.
        </p>
      )}

      {report && (
        <>
          <p className="mb-3 text-xs leading-relaxed text-zinc-300">
            {report.headline}
          </p>

          <div className="mb-3 grid grid-cols-2 gap-2">
            {SEVERITY_ORDER.map((severity) => (
              <SeverityTile
                key={severity}
                severity={severity}
                count={counts[severity]}
                total={caused.length}
                active={filter === severity}
                onClick={() =>
                  setFilter((current) => (current === severity ? null : severity))
                }
              />
            ))}
          </div>

          <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-2.5">
            <SectionLabel>What changed</SectionLabel>
            <div className="grid grid-cols-3 gap-2 font-mono text-[10px] text-zinc-400">
              {(
                [
                  ["nodes", report.structural_delta.nodes],
                  ["edges", report.structural_delta.edges],
                  ["depth", report.structural_delta.depth],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <div className="text-zinc-500">{label}</div>
                  <div className="text-zinc-200">
                    {value.before} → {value.after}
                  </div>
                </div>
              ))}
            </div>
            {report.structural_delta.edge_kinds_removed.length > 0 && (
              <div className="mt-1.5 font-mono text-[10px] text-rose-300/80">
                lost edge kinds:{" "}
                {report.structural_delta.edge_kinds_removed.join(", ")}
              </div>
            )}
          </div>

          <div className="mb-1.5 flex items-center justify-between">
            <SectionLabel>
              {caused.length === 0
                ? "Caused by this change"
                : `Caused by this change · ${caused.length}`}
            </SectionLabel>
            <span
              className="font-mono text-[9px] text-zinc-600"
              title="Deterministic checks are proofs about the graph. Judgments are model opinion."
            >
              {provedCount} checked · {caused.length - provedCount} judged
            </span>
          </div>

          {visible.length === 0 ? (
            <p className="mb-3 text-xs text-zinc-500">
              {filter
                ? `No ${filter} findings.`
                : "Nothing. This modification introduced no structural problems."}
            </p>
          ) : (
            <div className="mb-3 space-y-1">
              {visible.map((finding) => (
                <FindingRow
                  key={finding.finding_id + finding.node_ids.join(",")}
                  finding={finding}
                  onFocus={onFocusNodes}
                />
              ))}
            </div>
          )}

          {inherited.length > 0 && (
            <details className="rounded-md border border-zinc-800 bg-zinc-900/30 p-2.5">
              <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                Already in the original · {inherited.length}
              </summary>
              <p className="mb-2 mt-2 text-[11px] text-zinc-500">
                These come from how the paper was extracted, not from your
                change.
              </p>
              <div className="space-y-1">
                {inherited.map((finding) => (
                  <FindingRow
                    key={finding.finding_id + finding.node_ids.join(",")}
                    finding={finding}
                    onFocus={onFocusNodes}
                  />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

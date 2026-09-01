import { useMemo, useState } from "react";

import type {
  FindingSeverity,
  VerificationFinding,
  VerificationReportData,
} from "../types";
import { verdictLabel } from "./diagramPalette";

/**
 * Set like a reviewer's note, not a dashboard. The verdict opens a sentence,
 * severity counts read as a tally line, and each finding is marked with a
 * pen dot: filled when a structural check proved it, hollow when it is a
 * model judgment. Confidence is only shown for judgments, because a check
 * is certain by construction and printing "100%" is noise.
 */

const SEVERITY_ORDER: FindingSeverity[] = [
  "blocking",
  "major",
  "minor",
  "speculative",
];

const SEVERITY_INK: Record<FindingSeverity, string> = {
  blocking: "text-pen-red",
  major: "text-pen-amber",
  minor: "text-pen-blue",
  speculative: "text-ivory-500",
};

function verdictInk(verdict: string): string {
  if (verdict === "likely_broken") return "text-pen-red";
  if (verdict === "concerns") return "text-pen-amber";
  return "text-pen-moss";
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-medium text-ivory-500">{children}</h4>
  );
}

function SeverityTally({
  counts,
  filter,
  onFilter,
}: {
  counts: Record<FindingSeverity, number>;
  filter: FindingSeverity | null;
  onFilter: (severity: FindingSeverity | null) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs">
      {SEVERITY_ORDER.map((severity) => {
        const count = counts[severity];
        const active = filter === severity;
        if (count === 0) {
          return (
            <span
              key={severity}
              className="px-1 py-0.5 text-ivory-700"
            >
              0 {severity}
            </span>
          );
        }
        return (
          <button
            key={severity}
            onClick={() => onFilter(active ? null : severity)}
            title={active ? "Show all findings" : `Show only ${severity}`}
            className={`rounded px-1 py-0.5 font-medium ${SEVERITY_INK[severity]} ${
              active ? "bg-desk-800" : "hover:bg-desk-850"
            }`}
          >
            {count} {severity}
          </button>
        );
      })}
    </div>
  );
}

function Delta({
  label,
  value,
}: {
  label: string;
  value: { before: number; after: number };
}) {
  const moved = value.before !== value.after;
  return (
    <span className={moved ? "text-ivory-100" : "text-ivory-500"}>
      {label} {moved ? `${value.before} → ${value.after}` : value.before}
    </span>
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
  const ink = SEVERITY_INK[finding.severity];

  return (
    <div className="rounded">
      <button
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left hover:bg-desk-850"
      >
        <span
          aria-hidden
          title={
            proved
              ? "Proved by a structural check over the graph"
              : "Model judgment — not a proof"
          }
          className={`shrink-0 text-[11px] leading-none ${ink}`}
        >
          {proved ? "●" : "○"}
        </span>
        <span className="min-w-0 flex-1 text-[13px] leading-snug text-ivory-100">
          {finding.title}
        </span>
        <span className="flex shrink-0 items-baseline gap-2">
          {finding.inherited && (
            <span
              className="text-[10px] italic text-ivory-500"
              title="The original diagram already had this. Your change did not cause it."
            >
              pre-existing
            </span>
          )}
          <span className={`text-[11px] ${ink}`}>{finding.severity}</span>
        </span>
      </button>

      {open && (
        <div className="px-2 pb-2 pl-[1.55rem]">
          <div className="mb-1.5 text-[11px] text-ivory-500">
            {proved ? "Proved by a structural check" : "Model judgment"}
            {" · "}
            {finding.category.replace(/_/g, " ")}
            {!proved && ` · ${finding.confidence} confidence`}
          </div>
          <p className="mb-2 text-xs leading-relaxed text-ivory-300">
            {finding.failure_scenario}
          </p>
          {finding.node_ids.length > 0 && (
            <p className="text-[11px] text-ivory-500">
              In{" "}
              {finding.node_ids.map((id, index) => (
                <span key={id}>
                  {index > 0 && ", "}
                  <button
                    onClick={() => onFocus([id])}
                    title="Show this node on the diagram"
                    className="font-mono text-[10px] text-accent-400 hover:text-accent-300"
                  >
                    {id}
                  </button>
                </span>
              ))}
            </p>
          )}
          {finding.evidence && (
            <p className="mt-2 text-[11px] italic leading-relaxed text-ivory-300">
              “{finding.evidence}”
            </p>
          )}
          {finding.suggested_probe && (
            <p className="mt-2 text-[11px] leading-relaxed text-pen-amber">
              Try it: {finding.suggested_probe}
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

  const verdict = report ? verdictLabel(report.verdict) : "";

  return (
    <div className="p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <Heading>Verification</Heading>
        {report && (
          <button
            onClick={onReverify}
            disabled={loading}
            className="text-xs text-accent-400 hover:text-accent-300 disabled:opacity-40"
          >
            {loading ? "Checking…" : "Run again"}
          </button>
        )}
      </div>

      {error && (
        <p className="mb-3 text-xs leading-relaxed text-pen-red">{error}</p>
      )}

      {loading && !report && (
        <p className="animate-pulse py-2 text-xs text-ivory-300">
          Checking the modification…
        </p>
      )}

      {!report && !loading && !error && (
        <p className="text-xs leading-relaxed text-ivory-500">
          Apply a modification and it will be checked here: what the change
          breaks structurally, and what was already wrong before it.
        </p>
      )}

      {report && (
        <>
          <p className="mb-3 text-[13px] leading-relaxed text-ivory-100">
            <span className={`font-medium ${verdictInk(report.verdict)}`}>
              {verdict.charAt(0).toUpperCase() + verdict.slice(1)}.
            </span>{" "}
            {report.headline}
          </p>

          {caused.length > 0 && (
            <SeverityTally
              counts={counts}
              filter={filter}
              onFilter={setFilter}
            />
          )}

          <div className="mb-4 rounded bg-desk-850 px-3 py-2 text-xs">
            <span className="mr-2 text-ivory-500">What changed</span>
            <span className="space-x-2.5">
              <Delta label="nodes" value={report.structural_delta.nodes} />
              <Delta label="edges" value={report.structural_delta.edges} />
              <Delta label="depth" value={report.structural_delta.depth} />
            </span>
            {report.structural_delta.edge_kinds_removed.length > 0 && (
              <div className="mt-1 text-pen-red">
                Lost edge kinds:{" "}
                {report.structural_delta.edge_kinds_removed
                  .map((kind) => kind.replace(/_/g, " "))
                  .join(", ")}
              </div>
            )}
          </div>

          <div className="mb-1 flex items-baseline justify-between px-2">
            <Heading>
              Caused by this change
              {caused.length > 0 ? ` (${caused.length})` : ""}
            </Heading>
            {caused.length > 0 && (
              <span
                className="text-[11px] text-ivory-700"
                title="Checks are proofs about the graph. Judgments are model opinion."
              >
                {provedCount} proved · {caused.length - provedCount} judged
              </span>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="mb-3 px-2 text-xs leading-relaxed text-ivory-500">
              {filter
                ? `No ${filter} findings.`
                : "Nothing. This modification introduced no structural problems."}
            </p>
          ) : (
            <div className="mb-3 space-y-0.5">
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
            <details className="mt-5">
              <summary className="cursor-pointer px-2 text-xs font-medium text-ivory-500 hover:text-ivory-300">
                Already in the original ({inherited.length})
              </summary>
              <p className="mb-1 mt-1.5 px-2 text-[11px] leading-relaxed text-ivory-700">
                These come from how the paper was extracted, not from your
                change.
              </p>
              <div className="space-y-0.5">
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

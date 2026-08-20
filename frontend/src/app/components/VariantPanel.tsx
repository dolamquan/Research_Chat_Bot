import { useState } from "react";
import {
  Check,
  GitBranch,
  Loader2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import type {
  AlgorithmVariant,
  RawOp,
  VariantProposal,
  VariantTreeRow,
} from "../types";
import { diffTint, severityTone, verdictLabel, verdictTone } from "./diagramPalette";

/**
 * The Modify tab: describe a change, review the operations it would apply,
 * then approve. Nothing is stored until Apply, and the server re-applies the
 * patch itself so what you approved is what you get.
 */

const PRESETS = [
  "remove positional encoding",
  "replace softmax attention with a linear kernel",
  "add a residual connection that skips the decoder",
  "make the pipeline iterative with a feedback loop",
];

const OP_GLYPH: Record<string, { mark: string; tone: string }> = {
  add_node: { mark: "+", tone: "text-emerald-300 border-emerald-800" },
  add_edge: { mark: "+", tone: "text-emerald-300 border-emerald-800" },
  remove_node: { mark: "−", tone: "text-rose-300 border-rose-800" },
  remove_edge: { mark: "−", tone: "text-rose-300 border-rose-800" },
  update_node: { mark: "~", tone: "text-amber-300 border-amber-800" },
  update_group: { mark: "~", tone: "text-amber-300 border-amber-800" },
  update_meta: { mark: "~", tone: "text-amber-300 border-amber-800" },
  rewire_edge: { mark: "⇄", tone: "text-sky-300 border-sky-800" },
};

function opTarget(op: RawOp): string {
  if (op.node_id) return op.node_id;
  if (op.source || op.target) {
    const rewired =
      op.op === "rewire_edge"
        ? ` → ${op.new_source || op.source}→${op.new_target || op.target}`
        : "";
    return `${op.source}→${op.target}${rewired}`;
  }
  if (op.group) return op.group;
  return op.algorithm_name || "metadata";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
      {children}
    </div>
  );
}

function OpRow({
  op,
  index,
  onHover,
}: {
  op: RawOp;
  index: number;
  onHover: (nodeId: string | null) => void;
}) {
  const glyph = OP_GLYPH[op.op] ?? { mark: "?", tone: "text-zinc-300 border-zinc-700" };
  return (
    <div
      onMouseEnter={() => onHover(op.node_id || op.source || null)}
      onMouseLeave={() => onHover(null)}
      className="flex gap-2 rounded px-1 py-1.5 transition-colors hover:bg-zinc-800/40"
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border font-mono text-[10px] ${glyph.tone}`}
      >
        {glyph.mark}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-[11px] text-zinc-200">
            {opTarget(op)}
          </span>
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-zinc-500">
            {op.op.replace(/_/g, " ")}
          </span>
        </div>
        {op.op === "update_node" && op.label && (
          <div className="font-mono text-[10px] text-zinc-400">
            label → <span className="text-emerald-300">{op.label}</span>
          </div>
        )}
        {op.intent && (
          <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">
            {op.intent}
          </p>
        )}
      </div>
      <span className="shrink-0 font-mono text-[9px] text-zinc-600">
        {index + 1}
      </span>
    </div>
  );
}

export function VariantPanel({
  baseLabel,
  intent,
  onIntentChange,
  proposing,
  proposeElapsed,
  proposeError,
  proposal,
  applying,
  variants,
  tree,
  activeVariantId,
  onPropose,
  onCancelPropose,
  onApply,
  onDiscard,
  onSelectVariant,
  onBranchFrom,
  onDeleteVariant,
  onHoverOpTarget,
}: {
  baseLabel: string;
  intent: string;
  onIntentChange: (value: string) => void;
  proposing: boolean;
  proposeElapsed: number;
  proposeError: string | null;
  proposal: VariantProposal | null;
  applying: boolean;
  variants: AlgorithmVariant[];
  tree: VariantTreeRow[];
  activeVariantId: string | null;
  onPropose: () => void;
  onCancelPropose: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onSelectVariant: (variantId: string | null) => void;
  onBranchFrom: (variantId: string) => void;
  onDeleteVariant: (variantId: string) => void;
  onHoverOpTarget: (nodeId: string | null) => void;
}) {
  const [showRationale, setShowRationale] = useState(false);

  const causedCount =
    proposal?.report.findings.filter((finding) => !finding.inherited).length ?? 0;
  const worst = proposal?.report.findings.find((finding) => !finding.inherited);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-zinc-800 p-4">
        <div className="mb-2 flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-teal-900/60 bg-teal-500/10 text-teal-300">
            <GitBranch className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <SectionLabel>Modify algorithm</SectionLabel>
            <div className="truncate text-[11px] text-zinc-400">
              from <span className="text-zinc-200">{baseLabel}</span>
            </div>
          </div>
        </div>

        <textarea
          value={intent}
          onChange={(event) => onIntentChange(event.target.value)}
          onKeyDown={(event) => {
            // The view closes popups on Escape; don't let that fire while typing.
            if (event.key === "Escape") event.stopPropagation();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onPropose();
            }
          }}
          rows={3}
          placeholder="What would you change? e.g. replace softmax attention with a linear kernel"
          className="w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-teal-600/60 focus:outline-none"
        />

        <div className="mt-1.5 flex flex-wrap gap-1">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => onIntentChange(preset)}
              className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-teal-700 hover:text-teal-200"
            >
              {preset}
            </button>
          ))}
        </div>

        <div className="mt-2 flex gap-2">
          <button
            onClick={onPropose}
            disabled={!intent.trim() || proposing}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {proposing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {proposing ? `Reading the paper… ${proposeElapsed}s` : "Propose change"}
          </button>
          {proposing && (
            <button
              onClick={onCancelPropose}
              className="rounded-md border border-zinc-700 px-2.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800"
            >
              Cancel
            </button>
          )}
        </div>

        {proposeError && (
          <div className="mt-2 rounded-md border border-red-900/60 bg-red-950/80 px-2.5 py-1.5 text-[11px] text-red-300">
            {proposeError}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {proposal && (
          <div className="border-b border-zinc-800 p-4">
            <SectionLabel>Proposed patch</SectionLabel>
            <div className="mb-2 text-xs font-semibold text-zinc-100">
              {proposal.patch.variant_title}
            </div>

            <button
              onClick={() => setShowRationale((current) => !current)}
              className="mb-2 text-[10px] text-teal-300 hover:underline"
            >
              {showRationale ? "hide" : "show"} rationale &amp; risks
            </button>
            {showRationale && (
              <div className="mb-2 space-y-1.5">
                <p className="text-[11px] leading-relaxed text-zinc-400">
                  {proposal.patch.rationale}
                </p>
                {proposal.patch.risks && (
                  <p className="rounded border border-amber-900/50 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200/80">
                    Its own stated risk: {proposal.patch.risks}
                  </p>
                )}
              </div>
            )}

            <div className="mb-2 divide-y divide-zinc-800/60">
              {proposal.patch.ops.map((op, index) => (
                <OpRow
                  key={index}
                  op={op}
                  index={index}
                  onHover={onHoverOpTarget}
                />
              ))}
            </div>

            <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px]">
              <span className="text-emerald-300">
                {proposal.applied.length} applied
              </span>
              {proposal.rejected.filter((op) => !op.redundant).length > 0 && (
                <span className="text-rose-300">
                  {proposal.rejected.filter((op) => !op.redundant).length} rejected
                </span>
              )}
              {proposal.rejected.filter((op) => op.redundant).length > 0 && (
                <span
                  className="text-zinc-500"
                  title="Already achieved by another operation in this patch."
                >
                  {proposal.rejected.filter((op) => op.redundant).length} redundant
                </span>
              )}
            </div>

            {proposal.rejected
              .filter((op) => !op.redundant)
              .map((op) => (
                <div
                  key={op.index}
                  className="mb-1 rounded border border-rose-900/50 bg-rose-950/30 px-2 py-1 text-[10px] text-rose-200/80"
                >
                  <span className="font-mono">{op.op.op}</span>: {op.reason}
                </div>
              ))}

            <div
              className={`mb-2 rounded-md border px-2 py-1.5 text-[11px] ${verdictTone(
                proposal.report.verdict,
              )}`}
            >
              {verdictLabel(proposal.report.verdict)}
              {causedCount > 0 && worst ? (
                <span className={`ml-1 ${severityTone(worst.severity)}`}>
                  · {worst.title}
                </span>
              ) : (
                <span className="ml-1 text-zinc-400">
                  · no new structural problems
                </span>
              )}
            </div>

            <div className="flex gap-2">
              <button
                onClick={onApply}
                disabled={applying || proposal.applied.length === 0}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-500 disabled:opacity-40"
              >
                {applying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Apply
              </button>
              <button
                onClick={onDiscard}
                disabled={applying}
                className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        <div className="p-4">
          <SectionLabel>Variants · {tree.length}</SectionLabel>
          <button
            onClick={() => onSelectVariant(null)}
            className={`mb-1 flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
              activeVariantId === null
                ? "border-teal-700 bg-teal-500/10 text-teal-100"
                : "border-zinc-800 text-zinc-300 hover:bg-zinc-800/60"
            }`}
          >
            <span>Original</span>
            <span className="font-mono text-[9px] text-zinc-500">baseline</span>
          </button>

          {tree.length === 0 && (
            <p className="text-[11px] text-zinc-500">
              No variants yet. Describe a change above to create one.
            </p>
          )}

          {tree.map((row) => {
            const active = row.variant_id === activeVariantId;
            const variant = variants.find(
              (item) => item.variant_id === row.variant_id,
            );
            const delta = variant?.patch_result;
            return (
              <div
                key={row.variant_id}
                className={`mb-1 rounded-md border px-2 py-1.5 ${
                  active
                    ? "border-teal-700 bg-teal-500/10"
                    : "border-zinc-800 hover:bg-zinc-800/60"
                }`}
                style={{ marginLeft: `${(row.depth - 1) * 12}px` }}
              >
                <div className="flex items-start justify-between gap-1.5">
                  <button
                    onClick={() => onSelectVariant(row.variant_id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-xs text-zinc-200">
                      {row.variant_title}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[9px]">
                      <span className={verdictTone(row.verdict).split(" ")[0]}>
                        {verdictLabel(row.verdict)}
                      </span>
                      {delta && (
                        <>
                          {delta.changed_node_ids.length > 0 && (
                            <span style={{ color: diffTint("changed") ?? undefined }}>
                              ~{delta.changed_node_ids.length}
                            </span>
                          )}
                          {delta.removed_node_ids.length > 0 && (
                            <span style={{ color: diffTint("removed") ?? undefined }}>
                              −{delta.removed_node_ids.length}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </button>
                  <div className="flex shrink-0 gap-0.5">
                    <button
                      onClick={() => onBranchFrom(row.variant_id)}
                      title="Modify from here"
                      className="rounded p-0.5 text-zinc-500 transition-colors hover:text-teal-300"
                    >
                      <GitBranch className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => onDeleteVariant(row.variant_id)}
                      title="Delete this variant and anything branched from it"
                      className="rounded p-0.5 text-zinc-500 transition-colors hover:text-red-400"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

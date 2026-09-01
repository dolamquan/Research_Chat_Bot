import { useState } from "react";

import type {
  AlgorithmVariant,
  RawOp,
  VariantProposal,
  VariantTreeRow,
} from "../types";
import { verdictLabel } from "./diagramPalette";

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

const OP_GLYPH: Record<string, { mark: string; ink: string }> = {
  add_node: { mark: "+", ink: "text-pen-moss" },
  add_edge: { mark: "+", ink: "text-pen-moss" },
  remove_node: { mark: "−", ink: "text-pen-red" },
  remove_edge: { mark: "−", ink: "text-pen-red" },
  update_node: { mark: "~", ink: "text-pen-amber" },
  update_group: { mark: "~", ink: "text-pen-amber" },
  update_meta: { mark: "~", ink: "text-pen-amber" },
  rewire_edge: { mark: "⇄", ink: "text-pen-blue" },
};

function verdictInk(verdict: string): string {
  if (verdict === "likely_broken") return "text-pen-red";
  if (verdict === "concerns") return "text-pen-amber";
  return "text-pen-moss";
}

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

function Heading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-medium text-ivory-500">{children}</h4>;
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
  const glyph = OP_GLYPH[op.op] ?? { mark: "?", ink: "text-ivory-300" };
  return (
    <div
      onMouseEnter={() => onHover(op.node_id || op.source || null)}
      onMouseLeave={() => onHover(null)}
      className="flex gap-2 rounded px-2 py-1.5 hover:bg-desk-850"
    >
      <span
        className={`w-3 shrink-0 text-center font-mono text-xs ${glyph.ink}`}
      >
        {glyph.mark}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-[11px] text-ivory-100">
            {opTarget(op)}
          </span>
          <span className="shrink-0 text-[10px] text-ivory-700">
            {op.op.replace(/_/g, " ")}
          </span>
        </div>
        {op.op === "update_node" && op.label && (
          <div className="text-[11px] text-ivory-500">
            label → <span className="text-pen-moss">{op.label}</span>
          </div>
        )}
        {op.intent && (
          <p className="mt-0.5 text-[11px] leading-snug text-ivory-500">
            {op.intent}
          </p>
        )}
      </div>
      <span className="shrink-0 text-[10px] text-ivory-700">{index + 1}</span>
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
      <div className="p-4 pb-5">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <Heading>Modify algorithm</Heading>
        </div>
        <div className="mb-3 truncate text-xs text-ivory-500">
          from <span className="text-ivory-300">{baseLabel}</span>
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
          className="w-full resize-none rounded bg-desk-850 px-3 py-2 text-xs leading-relaxed text-ivory-100 placeholder:text-ivory-700 focus:outline-none"
        />

        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => onIntentChange(preset)}
              className="rounded px-1 py-0.5 text-[11px] text-ivory-500 hover:bg-desk-850 hover:text-accent-300"
            >
              {preset}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={onPropose}
            disabled={!intent.trim() || proposing}
            className="flex-1 rounded bg-accent-400 px-3 py-1.5 text-xs font-medium text-desk-950 hover:bg-accent-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {proposing ? `Reading the paper… ${proposeElapsed}s` : "Propose change"}
          </button>
          {proposing && (
            <button
              onClick={onCancelPropose}
              className="rounded px-2 py-1.5 text-xs text-ivory-500 hover:bg-desk-850 hover:text-ivory-100"
            >
              Cancel
            </button>
          )}
        </div>

        {proposeError && (
          <p className="mt-2 text-[11px] leading-relaxed text-pen-red">
            {proposeError}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {proposal && (
          <div className="bg-desk-900 p-4 pt-5">
            <Heading>Proposed patch</Heading>
            <div className="mb-2 mt-1 text-[13px] font-semibold leading-snug text-ivory-100">
              {proposal.patch.variant_title}
            </div>

            <button
              onClick={() => setShowRationale((current) => !current)}
              className="mb-2 text-[11px] text-accent-400 hover:text-accent-300"
            >
              {showRationale ? "Hide" : "Show"} rationale &amp; risks
            </button>
            {showRationale && (
              <div className="mb-2 space-y-1.5">
                <p className="text-[11px] leading-relaxed text-ivory-300">
                  {proposal.patch.rationale}
                </p>
                {proposal.patch.risks && (
                  <p className="text-[11px] leading-relaxed text-pen-amber">
                    Its own stated risk: {proposal.patch.risks}
                  </p>
                )}
              </div>
            )}

            <div className="mb-2">
              {proposal.patch.ops.map((op, index) => (
                <OpRow
                  key={index}
                  op={op}
                  index={index}
                  onHover={onHoverOpTarget}
                />
              ))}
            </div>

            <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 px-2 text-[11px]">
              <span className="text-pen-moss">
                {proposal.applied.length} applied
              </span>
              {proposal.rejected.filter((op) => !op.redundant).length > 0 && (
                <span className="text-pen-red">
                  {proposal.rejected.filter((op) => !op.redundant).length} rejected
                </span>
              )}
              {proposal.rejected.filter((op) => op.redundant).length > 0 && (
                <span
                  className="text-ivory-700"
                  title="Already achieved by another operation in this patch."
                >
                  {proposal.rejected.filter((op) => op.redundant).length} redundant
                </span>
              )}
            </div>

            {proposal.rejected
              .filter((op) => !op.redundant)
              .map((op) => (
                <p
                  key={op.index}
                  className="mb-1 px-2 text-[11px] leading-relaxed text-pen-red"
                >
                  <span className="font-mono text-[10px]">{op.op.op}</span>:{" "}
                  {op.reason}
                </p>
              ))}

            <p className="mb-3 mt-3 px-2 text-xs leading-relaxed text-ivory-100">
              <span className={`font-medium ${verdictInk(proposal.report.verdict)}`}>
                {(() => {
                  const label = verdictLabel(proposal.report.verdict);
                  return label.charAt(0).toUpperCase() + label.slice(1);
                })()}
                .
              </span>{" "}
              {causedCount > 0 && worst
                ? worst.title
                : "No new structural problems."}
            </p>

            <div className="flex items-center gap-3">
              <button
                onClick={onApply}
                disabled={applying || proposal.applied.length === 0}
                className="flex-1 rounded bg-accent-400 px-3 py-1.5 text-xs font-medium text-desk-950 hover:bg-accent-300 disabled:opacity-40"
              >
                {applying ? "Applying…" : "Apply"}
              </button>
              <button
                onClick={onDiscard}
                disabled={applying}
                className="rounded px-2 py-1.5 text-xs text-ivory-500 hover:bg-desk-850 hover:text-ivory-100"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        <div className="p-4 pt-5">
          <div className="mb-1.5">
            <Heading>Variants ({tree.length})</Heading>
          </div>
          <button
            onClick={() => onSelectVariant(null)}
            className={`mb-0.5 flex w-full items-baseline justify-between rounded px-2 py-1.5 text-left text-xs ${
              activeVariantId === null
                ? "bg-desk-800 text-ivory-100"
                : "text-ivory-300 hover:bg-desk-850"
            }`}
          >
            <span>Original</span>
            <span className="text-[10px] text-ivory-700">baseline</span>
          </button>

          {tree.length === 0 && (
            <p className="px-2 text-[11px] leading-relaxed text-ivory-500">
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
                className={`group mb-0.5 rounded px-2 py-1.5 ${
                  active ? "bg-desk-800" : "hover:bg-desk-850"
                }`}
                style={{ marginLeft: `${(row.depth - 1) * 12}px` }}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    onClick={() => onSelectVariant(row.variant_id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div
                      className={`truncate text-xs ${
                        active ? "text-ivory-100" : "text-ivory-300"
                      }`}
                    >
                      {row.variant_title}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-baseline gap-1.5 text-[10px]">
                      <span className={verdictInk(row.verdict)}>
                        {verdictLabel(row.verdict)}
                      </span>
                      {delta && (
                        <>
                          {delta.changed_node_ids.length > 0 && (
                            <span className="text-pen-amber">
                              ~{delta.changed_node_ids.length}
                            </span>
                          )}
                          {delta.removed_node_ids.length > 0 && (
                            <span className="text-pen-red">
                              −{delta.removed_node_ids.length}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </button>
                  <div className="flex shrink-0 gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={() => onBranchFrom(row.variant_id)}
                      title="Modify from here"
                      className="text-[10px] text-ivory-500 hover:text-accent-300"
                    >
                      branch
                    </button>
                    <button
                      onClick={() => onDeleteVariant(row.variant_id)}
                      title="Delete this variant and anything branched from it"
                      className="text-[10px] text-ivory-500 hover:text-pen-red"
                    >
                      delete
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

import { useMemo } from "react";

import type { AlgorithmScene, SceneVerificationReport } from "./sceneTypes";
import { entityIsUncertain } from "./sceneValidation";

/**
 * The paper evidence behind whatever is currently selected.
 *
 * This panel is the reason the whole pipeline carries `evidence_ids`: anything
 * on screen can be traced back to a quote, and anything that cannot is stated
 * as unsupported rather than left to look equally authoritative.
 */
export function SceneEvidencePanel({
  scene,
  verification,
  selectedEntityId,
  activeStepId,
  onClearSelection,
}: {
  scene: AlgorithmScene;
  verification?: SceneVerificationReport | null;
  selectedEntityId: string | null;
  activeStepId: string | null;
  onClearSelection?: () => void;
}) {
  const entity = useMemo(
    () => scene.entities.find((item) => item.id === selectedEntityId) ?? null,
    [scene.entities, selectedEntityId],
  );
  const step = useMemo(
    () => scene.steps.find((item) => item.id === activeStepId) ?? null,
    [scene.steps, activeStepId],
  );

  // What to cite: the clicked entity if there is one, otherwise the step
  // currently playing, so the panel is never empty while something is on screen.
  const evidenceIds = entity
    ? entity.evidence_ids
    : step
      ? step.evidence_ids
      : [];

  const refs = useMemo(
    () =>
      evidenceIds
        .map((id) => scene.evidence.find((ref) => ref.evidence_id === id))
        .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref)),
    [evidenceIds, scene.evidence],
  );

  const subject = entity?.label ?? step?.caption ?? "";

  return (
    <aside
      className="flex h-full flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-700/80 bg-zinc-900/70 p-3"
      data-testid="scene-evidence-panel"
      aria-label="Paper evidence"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            evidence
          </div>
          <div className="truncate text-sm font-medium text-zinc-200">
            {subject || "Nothing selected"}
          </div>
        </div>
        {entity && onClearSelection ? (
          <button
            type="button"
            onClick={onClearSelection}
            className="ml-auto rounded border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:text-zinc-200"
          >
            Clear
          </button>
        ) : null}
      </div>

      {entity && entityIsUncertain(entity) ? (
        <p
          className="rounded border border-dashed border-amber-600/60 bg-amber-950/20 px-2 py-1.5 text-[11px] leading-snug text-amber-200"
          data-testid="scene-evidence-uncertain"
        >
          No supporting quote was found for this component. It is shown because the
          diagram implies it, not because the paper states it.
        </p>
      ) : null}

      {refs.length === 0 && !(entity && entityIsUncertain(entity)) ? (
        <p className="text-[11px] leading-snug text-zinc-500">
          Click a labelled component in the visualization to see the passage it
          came from.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {refs.map((ref) => (
          <li
            key={ref.evidence_id}
            className="rounded border border-zinc-700/70 bg-zinc-950/50 p-2"
            data-testid="scene-evidence-item"
          >
            <div className="mb-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-zinc-500">
              <span className="truncate">{ref.section || "source"}</span>
              {ref.page ? <span>p.{ref.page}</span> : null}
              <span className="ml-auto">{Math.round(ref.confidence * 100)}%</span>
            </div>
            <blockquote className="text-[11px] leading-snug text-zinc-300">
              {ref.quote || "(no quote captured)"}
            </blockquote>
          </li>
        ))}
      </ul>

      {verification ? (
        <div className="mt-auto border-t border-zinc-800 pt-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            verification
          </div>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px] text-zinc-400">
            <dt>grounded steps</dt>
            <dd className="text-right tabular-nums text-zinc-300">
              {Math.round(verification.grounded_step_ratio * 100)}%
            </dd>
            <dt>grounded entities</dt>
            <dd className="text-right tabular-nums text-zinc-300">
              {Math.round(verification.grounded_entity_ratio * 100)}%
            </dd>
            <dt>steps</dt>
            <dd className="text-right tabular-nums text-zinc-300">
              {verification.step_count}
            </dd>
          </dl>
          {verification.findings.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-1">
              {verification.findings.slice(0, 6).map((finding, index) => (
                <li
                  key={`${finding.code}-${index}`}
                  className="flex gap-1.5 text-[10px] leading-snug text-zinc-400"
                >
                  <span
                    aria-hidden
                    className={[
                      "mt-[3px] h-2 w-0.5 shrink-0 rounded",
                      finding.severity === "error"
                        ? "bg-red-500"
                        : finding.severity === "warning"
                          ? "bg-amber-500"
                          : "bg-zinc-600",
                    ].join(" ")}
                  />
                  <span>{finding.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

export default SceneEvidencePanel;

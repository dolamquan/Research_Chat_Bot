import { useState, type FormEvent } from "react";
import { AlertTriangle, Wand2 } from "lucide-react";

import type { RefinementClassification, RefineOutcome, SceneEdit } from "./sceneTypes";

export type { RefineOutcome };

export type RefineHandler = (
  instruction: string,
  acknowledgeFundamental: boolean,
) => Promise<RefineOutcome<unknown>>;

const EXAMPLES = [
  "the value labels overlap the bars — move them below the baseline",
  "the matrix title sits on top of the first row; give it more room",
  "slow the second phase down and make the token labels larger",
];

export function SceneRefinePanel({
  onRefine,
  edits = [],
  busy = false,
  disabled = false,
  className = "",
}: {
  onRefine: RefineHandler;
  edits?: SceneEdit[];
  /** The scene is being verified or regenerated; submissions wait. */
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState<RefinementClassification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const diverges = edits.some((edit) => edit.kind === "fundamental");
  const locked = disabled || busy || submitting;

  async function send(acknowledge: boolean) {
    const text = instruction.trim();
    if (!text) return;
    setSubmitting(true);
    setError(null);
    setApplied(null);
    try {
      const outcome = await onRefine(text, acknowledge);
      if (outcome.status === "needs_acknowledgement") {
        setWarning(outcome.classification);
        return;
      }
      setWarning(null);
      setInstruction("");
      setApplied(
        outcome.classification.kind === "fundamental"
          ? "Changed. This animation now shows a variation of the method, not the paper's version."
          : "Changed. Verifying the new animation…",
      );
    } catch (failure) {
      setWarning(null);
      setError(failure instanceof Error ? failure.message : "The change could not be applied.");
    } finally {
      setSubmitting(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(false);
  }

  return (
    <div className={`space-y-2 ${className}`} data-testid="scene-refine">
      <form onSubmit={submit} className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-[11px] text-ivory-300">
          <Wand2 className="h-3 w-3 text-accent-300" />
          Describe a change to this animation
        </label>
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          disabled={locked}
          rows={2}
          placeholder={EXAMPLES[edits.length % EXAMPLES.length]}
          aria-label="Describe a change to this animation"
          className="w-full resize-none rounded border border-desk-700 bg-desk-950 px-2 py-1.5 text-xs text-ivory-100 placeholder:text-ivory-700 focus:border-accent-400 focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={locked || !instruction.trim()}
            className="rounded bg-accent-400 px-2.5 py-1 text-xs font-medium text-desk-950 hover:bg-accent-300 disabled:opacity-50"
          >
            {submitting ? "Applying…" : busy ? "Verifying…" : "Apply change"}
          </button>
          <span className="text-[10px] leading-snug text-ivory-700">
            Layout, colours, timing and wording apply directly. Changes to the
            method itself ask you to confirm first.
          </span>
        </div>
      </form>

      {warning ? (
        <div
          role="alertdialog"
          aria-label="This change alters the method"
          data-testid="scene-refine-warning"
          className="space-y-2 rounded border border-pen-red/50 bg-pen-red/10 p-2.5"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pen-red" />
            <div className="text-xs leading-relaxed text-ivory-100">
              <p className="font-medium text-pen-red">
                This changes what the animation shows, not just how it looks.
              </p>
              {warning.reason ? <p className="mt-1 text-ivory-300">{warning.reason}</p> : null}
              <p className="mt-1 text-ivory-300">
                The result will illustrate a modified method, not the one the
                paper describes, and will be labelled that way.
                {warning.basis === "heuristic"
                  ? " (Judged offline from the wording; no model was available.)"
                  : ""}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void send(true)}
              disabled={locked}
              className="rounded border border-pen-red/60 px-2.5 py-1 text-xs font-medium text-pen-red hover:bg-pen-red/20 disabled:opacity-50"
            >
              Change it anyway
            </button>
            <button
              type="button"
              onClick={() => setWarning(null)}
              className="rounded border border-desk-700 px-2.5 py-1 text-xs text-ivory-300 hover:bg-desk-800"
            >
              Keep the paper&apos;s version
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-[11px] leading-relaxed text-pen-red">
          {error}
        </p>
      ) : null}
      {applied ? (
        <p role="status" className="text-[11px] leading-relaxed text-ivory-300">
          {applied}
        </p>
      ) : null}

      {edits.length > 0 ? (
        <div className="space-y-1" data-testid="scene-edit-trail">
          <div className="flex items-center gap-2 text-[10px] text-ivory-500">
            <span>Edited by you ({edits.length})</span>
            {diverges ? (
              <span className="rounded border border-pen-red/50 px-1.5 py-0.5 text-pen-red">
                Diverges from the paper
              </span>
            ) : null}
          </div>
          <ul className="space-y-0.5 text-[10px] leading-snug text-ivory-500">
            {edits.slice(-3).map((edit) => (
              <li key={`${edit.at}-${edit.instruction}`} className="truncate">
                <span className={edit.kind === "fundamental" ? "text-pen-red" : "text-ivory-700"}>
                  {edit.kind === "fundamental" ? "method" : "look"}
                </span>
                {" · "}
                {edit.instruction}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default SceneRefinePanel;

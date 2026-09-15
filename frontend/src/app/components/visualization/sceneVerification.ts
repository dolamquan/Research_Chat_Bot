/**
 * The generate → probe → repair → report loop, as a pure function.
 *
 * "Ready" used to mean "the server stored code that passes the static
 * checks". That is how a stage could be announced as prepared and then
 * throw `row.forEach is not a function` on its first frame. Now a scene is
 * ready only after the browser has run it (`probe`), any crash has been
 * handed back to the model with the real error (`repair`), and the verdict
 * has been written to the record (`report`).
 *
 * Every side effect is a dependency so the loop can be tested without a
 * browser, a server or a model.
 */
import { layoutReportFor, type LayoutReport, type RuntimeVerdict } from "./sceneRuntime";
import type { PlayableSceneRecord } from "./sceneTypes";

export type RepairEvidence = {
  runtimeError?: string;
  layoutReport?: LayoutReport;
};

export type VerificationPhase = "probing" | "repairing" | "reporting";

export type VerificationDeps<R extends PlayableSceneRecord> = {
  /** Run the record's code off-screen. Must resolve, never reject. */
  probe: (record: R) => Promise<RuntimeVerdict>;
  /** Ask the server to rewrite the stored code given what went wrong. */
  repair: (evidence: RepairEvidence) => Promise<R>;
  /** Persist the verdict; returns the updated record. */
  report: (verdict: RuntimeVerdict) => Promise<R>;
  onPhase?: (phase: VerificationPhase) => void;
};

export type VerificationOutcome<R> = {
  record: R;
  verdict: RuntimeVerdict;
  /** Model calls spent fixing this scene. */
  repairs: number;
};

/** Two model calls at most: a repair that breaks the scene must not cascade. */
export const MAX_REPAIRS = 2;

export async function ensureVerified<R extends PlayableSceneRecord>(
  record: R,
  deps: VerificationDeps<R>,
): Promise<VerificationOutcome<R>> {
  let current = record;
  let repairs = 0;
  let layoutRepaired = false;

  deps.onPhase?.("probing");
  let verdict = await deps.probe(current);

  for (;;) {
    if (verdict.status === "failed") {
      if (repairs >= MAX_REPAIRS) break;
      deps.onPhase?.("repairing");
      current = await deps.repair({ runtimeError: verdict.error });
      repairs += 1;
      deps.onPhase?.("probing");
      verdict = await deps.probe(current);
      continue;
    }
    // The scene runs. Labels that still collide after the player's own
    // nudging pass get one targeted repair; a second would just churn.
    const layout = layoutReportFor(verdict);
    if (layout && !layoutRepaired && repairs < MAX_REPAIRS) {
      layoutRepaired = true;
      deps.onPhase?.("repairing");
      current = await deps.repair({ layoutReport: layout });
      repairs += 1;
      deps.onPhase?.("probing");
      verdict = await deps.probe(current);
      continue;
    }
    break;
  }

  deps.onPhase?.("reporting");
  const reported = await deps.report(verdict);
  return { record: reported ?? current, verdict, repairs };
}

/** The first line of a stack trace, for banners. */
export function firstLine(text: string | null | undefined): string {
  return String(text ?? "").split("\n")[0].trim();
}

/** A short human sentence for a verdict, used in progress and error banners. */
export function describeVerdict(verdict: RuntimeVerdict): string {
  if (verdict.status === "failed") {
    return `The animation crashed while running: ${firstLine(verdict.error) || "unknown error"}`;
  }
  const persistent = layoutReportFor(verdict);
  if (persistent) {
    const [first] = persistent.pairs;
    return `Runs, but ${persistent.pairs.length} label${persistent.pairs.length === 1 ? "" : "s"} still overlap (e.g. “${first.a}” over “${first.b}”).`;
  }
  return "Verified: runs through a full cycle with no overlapping labels.";
}

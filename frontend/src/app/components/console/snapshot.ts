import { getAgentContext, getHealth, getIntegrations, getMissingBackendRoutes, listSceneProviders } from "../../api";
import type { AgentContext, IntegrationStatus } from "../../types";

/** One read of the machine's state, shared by the Overview and Diagnostics. */
export type Snapshot = {
  health: "ok" | "unreachable";
  context: AgentContext | null;
  integrations: IntegrationStatus[];
  providers: string[];
  missingRoutes: string[];
  /** Calls that failed, as "what: why" — shown, never swallowed. */
  failures: string[];
};

export async function loadSnapshot(): Promise<Snapshot> {
  const [health, context, integrations, providers, missingRoutes] = await Promise.allSettled([
    getHealth(),
    getAgentContext(),
    getIntegrations(),
    listSceneProviders(),
    getMissingBackendRoutes(),
  ]);
  const failures: string[] = [];
  const value = <T,>(result: PromiseSettledResult<T>, label: string): T | null => {
    if (result.status === "fulfilled") return result.value;
    failures.push(`${label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    return null;
  };
  return {
    health: value(health, "health")?.status === "ok" ? "ok" : "unreachable",
    context: value(context, "app context"),
    integrations: value(integrations, "integrations")?.integrations ?? [],
    providers: value(providers, "providers")?.providers ?? [],
    missingRoutes: value(missingRoutes, "routes") ?? [],
    failures,
  };
}

/** Unavailable tools, grouped by the reason they are unavailable. */
export function unavailableByReason(context: AgentContext | null): Array<{ reason: string; names: string[] }> {
  const groups = new Map<string, string[]>();
  for (const tool of context?.unavailable_tools ?? []) {
    // Reasons arrive as sentences; callers add their own punctuation.
    const reason = (tool.reason?.trim() || "no reason given").replace(/[.\s]+$/, "");
    groups.set(reason, [...(groups.get(reason) ?? []), tool.name]);
  }
  return [...groups.entries()]
    .map(([reason, names]) => ({ reason, names }))
    .sort((a, b) => b.names.length - a.names.length);
}

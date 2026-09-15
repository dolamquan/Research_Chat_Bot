import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { glass } from "./glass";
import { loadSnapshot, unavailableByReason, type Snapshot } from "./snapshot";

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className={`p-5 ${glass}`}>
      <h3 className="mb-2 text-xs text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The full reading behind the Overview's "needs attention" list: what the
 * backend can reach, what the library holds, what the agent can call and what
 * it cannot and why. Nothing here calls a model.
 */
export function DiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    loadSnapshot()
      .then((next) => {
        if (live) setSnapshot(next);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const domains = useMemo(() => {
    const byDomain = new Map<string, { papers: number; categories: number }>();
    for (const row of snapshot?.context?.domains ?? []) {
      const entry = byDomain.get(row.domain) ?? { papers: 0, categories: 0 };
      entry.papers += row.article_count;
      entry.categories += 1;
      byDomain.set(row.domain, entry);
    }
    return [...byDomain.entries()].sort(([, a], [, b]) => b.papers - a.papers);
  }, [snapshot]);

  if (loading && !snapshot) {
    return (
      <p className="flex items-center gap-2 p-8 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" /> Checking the backend…
      </p>
    );
  }
  if (!snapshot) return null;
  const { context } = snapshot;
  const unavailable = unavailableByReason(context);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-6 md:px-8">
        <div className="mb-6 flex items-center justify-between">
          <p className={`text-sm ${snapshot.health === "ok" ? "text-foreground" : "text-destructive"}`} data-testid="health">
            Backend {snapshot.health === "ok" ? "online" : "unreachable"}
            {context ? ` · ${context.application}` : ""}
          </p>
          <button
            type="button"
            onClick={() => setTick((value) => value + 1)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        {snapshot.failures.length > 0 ? (
          <ul role="alert" className="mb-6 space-y-0.5 text-xs text-destructive">
            {snapshot.failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-2">
          <Section title="Model providers" testId="providers">
            {snapshot.providers.length ? (
              <p className="text-sm text-foreground">{snapshot.providers.join(", ")}</p>
            ) : (
              <p className="text-sm text-destructive">
                None reachable. Chat, diagrams, scene generation and refinement all need one — set OPENAI_API_KEY or ANTHROPIC_API_KEY.
              </p>
            )}
          </Section>

          <Section title="Integrations" testId="integrations">
            {snapshot.integrations.length === 0 ? (
              <p className="text-sm text-muted-foreground">None reported.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {snapshot.integrations.map((integration) => (
                  <li key={integration.provider} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-foreground">{integration.label}</span>
                    <span className={`text-xs ${integration.configured ? "text-muted-foreground" : "text-destructive"}`}>
                      {integration.configured
                        ? `connected${integration.method ? ` via ${integration.method}` : ""}${integration.source ? ` (${integration.source})` : ""}`
                        : "not connected"}
                    </span>
                    {integration.meta?.workspace_name ? <span className="text-xs text-muted-foreground">· {integration.meta.workspace_name}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Library · ${context?.paper_count ?? 0} papers`} testId="library">
            {domains.length === 0 ? (
              <p className="text-sm text-muted-foreground">No papers indexed.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <tbody>
                  {domains.map(([domain, entry]) => (
                    <tr key={domain} className="border-t border-border/60">
                      <td className="py-1 pr-3 text-foreground">{domain}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{entry.papers} papers</td>
                      <td className="py-1 text-muted-foreground">
                        {entry.categories} categor{entry.categories === 1 ? "y" : "ies"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title={`Tools · ${context?.tool_count ?? 0}`} testId="tools">
            {context ? (
              <>
                <table className="w-full text-left text-sm">
                  <tbody>
                    {Object.entries(context.tool_categories)
                      .sort(([, a], [, b]) => b - a)
                      .map(([category, count]) => (
                        <tr key={category} className="border-t border-border/60">
                          <td className="py-1 pr-3 capitalize text-foreground">{category}</td>
                          <td className="py-1 text-muted-foreground">{count}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {unavailable.length > 0 ? (
                  <ul className="mt-3 space-y-1.5 text-sm">
                    {unavailable.map((group) => (
                      <li key={group.reason}>
                        <span className="text-destructive">
                          {group.names.length} unavailable — {group.reason}
                        </span>
                        <span className="block font-mono text-[11px] text-muted-foreground">{group.names.join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">Every tool is available.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Context unavailable.</p>
            )}
          </Section>

          <Section title="Routes this frontend expects" testId="routes">
            {snapshot.missingRoutes.length === 0 ? (
              <p className="text-sm text-muted-foreground">All present in the backend.</p>
            ) : (
              <>
                <p className="mb-1 text-sm text-destructive">{snapshot.missingRoutes.length} missing — the running backend is older than this frontend.</p>
                <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                  {snapshot.missingRoutes.map((route) => (
                    <li key={route}>{route}</li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          <Section title={`Notion targets · ${context?.notion_targets.length ?? 0}`} testId="notion-targets">
            {context && context.notion_targets.length > 0 ? (
              <ul className="space-y-0.5 text-sm text-foreground">
                {context.notion_targets.map((target, index) => (
                  <li key={target.target_id ?? index}>{target.name ?? target.database_id ?? "unnamed target"}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None connected. Add a database from Notes.</p>
            )}
          </Section>
        </div>

        {context ? (
          <div className="mt-5">
            <Section title="What the agent is told the app does" testId="guide">
              <dl className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-[10rem_1fr]">
                {Object.entries(context.guide).map(([feature, description]) => (
                  <div key={feature} className="contents">
                    <dt className="text-foreground">{feature}</dt>
                    <dd className="text-muted-foreground">{description}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

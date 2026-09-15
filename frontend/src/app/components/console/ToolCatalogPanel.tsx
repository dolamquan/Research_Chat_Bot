import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Loader2, Play } from "lucide-react";

import { callAgentTool, getAgentTool, getAgentTools } from "../../api";
import type { AgentTool } from "../../types";
import { SchemaForm } from "./SchemaForm";
import { glass, glassActive, glassDanger, glassHover } from "./glass";
import { buildFieldGroups, collectArguments, initialValues, type FormValues } from "./schemaFields";
import { describeResult, effectLabel, effectSentence, inlineSegments, toolExplanation, toolTitle } from "./toolText";

export { effectLabel, toolTitle as humanTitle } from "./toolText";

const needsAcknowledgement = (tool: AgentTool) => tool.effect === "destructive" || tool.effect === "external_write";

/**
 * Every tool Zoe can call, by what it does — grouped by area, folded until
 * opened or searched. Picking one gives a form to run it directly, which is
 * deterministic: no model chooses the arguments. Machine names, routes and
 * schemas are there for anyone who needs them, under "Technical details".
 */
export function ToolCatalogPanel({ selectedName, onSelect }: { selectedName: string | null; onSelect: (name: string | null) => void }) {
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    getAgentTools({ limit: 500 })
      .then((response) => {
        if (!live) return;
        setTools(response.tools);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (live) setLoadError(error instanceof Error ? error.message : "Could not load the tool catalog.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const needle = search.trim().toLowerCase();
  const grouped = useMemo(() => {
    const byCategory = new Map<string, AgentTool[]>();
    for (const tool of tools) {
      if (needle && !tool.name.toLowerCase().includes(needle) && !tool.description.toLowerCase().includes(needle)) continue;
      byCategory.set(tool.category, [...(byCategory.get(tool.category) ?? []), tool]);
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools, needle]);

  const selected = tools.find((tool) => tool.name === selectedName) ?? null;
  const isOpen = (category: string) => Boolean(needle) || opened.has(category) || selected?.category === category;
  const toggle = (category: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border p-3">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by what it does…"
            aria-label="Search tools"
            className="h-8 w-full rounded border border-border bg-card px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="tool-list">
          {loading ? (
            <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </p>
          ) : loadError ? (
            <p role="alert" className="px-3 py-3 text-xs text-destructive">
              {loadError}
            </p>
          ) : grouped.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">Nothing matches.</p>
          ) : (
            grouped.map(([category, list]) => {
              const open = isOpen(category);
              return (
                <div key={category}>
                  <button
                    type="button"
                    onClick={() => toggle(category)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-foreground hover:bg-secondary"
                  >
                    {open ? <ChevronDown size={12} className="text-muted-foreground" /> : <ChevronRight size={12} className="text-muted-foreground" />}
                    <span className="capitalize">{category.replace(/[-_]/g, " ")}</span>
                    <span className="text-xs text-muted-foreground">{list.length}</span>
                  </button>
                  {open ? (
                    <div className="space-y-1.5 px-3 pb-3 pt-1">
                      {list.map((tool) => {
                        const effect = effectLabel(tool.effect);
                        const active = tool.name === selectedName;
                        return (
                          <button
                            key={tool.name}
                            type="button"
                            onClick={() => onSelect(tool.name)}
                            title={tool.name}
                            aria-pressed={active}
                            className={`block w-full px-3 py-2.5 text-left ${glass} ${active ? glassActive : glassHover} ${tool.available ? "" : "opacity-60"}`}
                          >
                            <span className="block text-sm leading-snug text-foreground">{toolTitle(tool)}</span>
                            {tool.effect !== "read" || !tool.available ? (
                              <span className="mt-1 flex gap-2 text-xs">
                                {tool.effect !== "read" ? <span className={effect.className}>{effect.text}</span> : null}
                                {!tool.available ? <span className="text-muted-foreground">unavailable</span> : null}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selected ? (
          <ToolDetail key={selected.name} summary={selected} />
        ) : (
          <div className={`m-6 max-w-md p-6 text-sm text-muted-foreground md:m-8 ${glass}`}>
            <p>Open an area on the left, or search, and pick a tool.</p>
            <p className="mt-1 text-xs">You will get a short form to fill in and a Run button.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Prose({ text, className = "" }: { text: string; className?: string }) {
  return (
    <p className={className}>
      {inlineSegments(text).map((segment, index) =>
        segment.code ? (
          <code key={index} className="rounded bg-secondary px-1 font-mono text-[0.9em] text-foreground">
            {segment.text}
          </code>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

function ToolDetail({ summary }: { summary: AgentTool }) {
  const [tool, setTool] = useState<AgentTool>(summary);
  const [schemaLoading, setSchemaLoading] = useState(!summary.input_schema);
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; summary: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    if (summary.input_schema) {
      setValues(initialValues(buildFieldGroups(summary.input_schema)));
      return;
    }
    setSchemaLoading(true);
    getAgentTool(summary.name)
      .then((full) => {
        if (!live) return;
        setTool(full);
        setValues(initialValues(buildFieldGroups(full.input_schema)));
      })
      .catch(() => {
        if (live) setValues(initialValues(buildFieldGroups(undefined)));
      })
      .finally(() => {
        if (live) setSchemaLoading(false);
      });
    return () => {
      live = false;
    };
  }, [summary]);

  const groups = useMemo(() => buildFieldGroups(tool.input_schema), [tool.input_schema]);
  const effect = effectSentence(tool.effect);
  const explanation = toolExplanation(tool);
  const gated = needsAcknowledgement(tool) && !acknowledged;

  async function run() {
    const collected = collectArguments(groups, values);
    setErrors(collected.errors);
    if (Object.keys(collected.errors).length > 0) return;
    setRunning(true);
    setResult(null);
    try {
      const response = await callAgentTool({ name: tool.name, arguments: collected.args });
      setResult({ ok: true, text: JSON.stringify(response.result, null, 2), summary: describeResult(response.result) });
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : "The tool call failed.", summary: "Failed" });
    } finally {
      setRunning(false);
    }
  }

  async function copyResult() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable; the text is still selectable.
    }
  }

  return (
    <div className={`m-6 max-w-2xl space-y-6 p-6 md:m-8 ${glass}`} data-testid="tool-detail">
      <header className="space-y-1.5">
        <h3 className="text-lg font-medium leading-snug text-foreground">{toolTitle(tool)}</h3>
        {explanation ? <Prose text={explanation} className="text-sm leading-relaxed text-muted-foreground" /> : null}
        <p className={`text-xs ${effect.className}`}>{effect.text}</p>
        {!tool.available ? (
          <p className="text-xs text-destructive" data-testid="tool-unavailable">
            Unavailable right now{tool.unavailable_reason ? ` — ${tool.unavailable_reason}` : ""}.
          </p>
        ) : null}
      </header>

      {schemaLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </p>
      ) : (
        <SchemaForm groups={groups} values={values} errors={errors} disabled={running} onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))} />
      )}

      {needsAcknowledgement(tool) ? (
        <label className={`flex max-w-xl items-start gap-2 p-3 text-sm text-foreground ${glassDanger}`}>
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5 h-3.5 w-3.5" />
          <span>
            {tool.effect === "destructive"
              ? "This deletes data. I want to run it with exactly these arguments."
              : "This writes to an outside service. I want to run it with exactly these arguments."}
          </span>
        </label>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void run()}
          disabled={running || schemaLoading || gated || !tool.available}
          className="flex items-center gap-1.5 rounded bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {running ? "Running…" : "Run"}
        </button>
        {gated ? <span className="text-xs text-muted-foreground">Tick the box above to enable Run.</span> : null}
      </div>

      {result ? (
        <section className="max-w-xl space-y-1.5">
          <div className="flex items-center justify-between">
            <p className={`text-sm ${result.ok ? "text-foreground" : "text-destructive"}`} data-testid="tool-result-summary">
              {result.ok ? `Done — ${result.summary}` : "Failed"}
            </p>
            {result.ok ? (
              <button type="button" onClick={() => void copyResult()} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
            ) : null}
          </div>
          <pre
            className={`max-h-[26rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs leading-relaxed ${
              result.ok ? "text-muted-foreground" : "text-destructive"
            }`}
            data-testid="tool-result"
          >
            {result.text}
          </pre>
        </section>
      ) : null}

      <details className="max-w-xl text-xs text-muted-foreground" data-testid="tool-technical">
        <summary className="cursor-pointer hover:text-foreground">Technical details</summary>
        <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-y-1 font-mono">
          <dt>name</dt>
          <dd className="text-foreground">{tool.name}</dd>
          {tool.method && tool.path ? (
            <>
              <dt>route</dt>
              <dd className="text-foreground">
                {tool.method} {tool.path}
              </dd>
            </>
          ) : null}
          <dt>runs via</dt>
          <dd className="text-foreground">{tool.execution}</dd>
          <dt>effect</dt>
          <dd className="text-foreground">{tool.effect}</dd>
        </dl>
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed" data-testid="tool-schema">
          {JSON.stringify(tool.input_schema ?? {}, null, 2)}
        </pre>
      </details>
    </div>
  );
}

import { useState, type FormEvent, type KeyboardEvent } from "react";

import { helpText, matchingCommands, parseCommand, type ParsedCommand } from "./commands";

export type CommandExecutor = (command: Extract<ParsedCommand, { kind: "call" | "mcp-call" | "tool" }>) => Promise<string>;

type Entry = { id: number; input: string; output: string; error: boolean };

/**
 * The model-free way to run a tool, folded into one line at the foot of the
 * page until someone wants it. Most visits never need it; when a tool
 * misbehaves it is the only way to know whether the tool or the model is at
 * fault. Plain language is redirected to Zoe rather than sent to a model here.
 */
export function CommandBar({ execute }: { execute: CommandExecutor }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);

  const completions = matchingCommands(input);

  function push(entry: Omit<Entry, "id">) {
    setEntries((current) => [...current.slice(-19), { ...entry, id: Date.now() + Math.random() }]);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const parsed = parseCommand(text);
    if (parsed.kind === "clear") {
      setEntries([]);
      return;
    }
    if (parsed.kind === "help") {
      push({ input: text, output: helpText(), error: false });
      return;
    }
    if (parsed.kind === "invalid") {
      push({ input: text, output: parsed.message, error: true });
      return;
    }
    if (parsed.kind === "unknown") {
      push({
        input: text,
        output: "Not a console command. For plain-language requests, ask Zoe — she runs the same tools. Type /help for what runs here.",
        error: true,
      });
      return;
    }
    setBusy(true);
    try {
      push({ input: text, output: await execute(parsed), error: false });
    } catch (error) {
      push({ input: text, output: error instanceof Error ? error.message : "The command failed.", error: true });
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Tab" && completions[0]) {
      event.preventDefault();
      setInput(completions[0].template ?? `${completions[0].name} `);
    }
  }

  // Left-aligned on purpose: Zoe's dock lives in the bottom-right corner.
  if (!open) {
    return (
      <div className="flex shrink-0 items-center border-t border-border bg-card px-5 py-1.5 md:px-8">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Command line
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-border bg-card pr-72 text-xs">
      <div className="flex items-center gap-3 px-5 pt-2 md:px-8">
        <button type="button" onClick={() => setOpen(false)} aria-expanded className="text-[11px] text-muted-foreground hover:text-foreground">
          Hide
        </button>
        <span className="text-[11px] text-muted-foreground">Runs one tool exactly as typed; no model involved. /help lists the commands.</span>
      </div>

      {entries.length > 0 ? (
        <div className="max-h-56 space-y-3 overflow-y-auto px-5 pt-2 font-mono md:px-8" data-testid="command-output">
          {entries.map((entry) => (
            <div key={entry.id}>
              <p className="text-muted-foreground">&gt; {entry.input}</p>
              <pre className={`mt-1 whitespace-pre-wrap break-words leading-relaxed ${entry.error ? "text-destructive" : "text-foreground"}`}>
                {entry.output}
              </pre>
            </div>
          ))}
        </div>
      ) : null}

      <form onSubmit={(event) => void submit(event)} className="relative px-5 py-2 md:px-8">
        {completions.length > 0 ? (
          <div className="absolute bottom-full left-5 right-5 mb-1 border border-border bg-card md:left-8 md:right-8" role="listbox">
            {completions.map((command) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => setInput(command.template ?? `${command.name} `)}
                className="grid w-full gap-1 px-3 py-1.5 text-left hover:bg-secondary md:grid-cols-[7rem_1fr]"
              >
                <span className="font-mono text-foreground">{command.name}</span>
                <span className="text-muted-foreground">{command.description}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-2 rounded-lg border border-white/15 bg-white/[0.05] px-2.5 py-1.5 font-mono backdrop-blur-md focus-within:border-white/35">
          <span className="text-muted-foreground">&gt;</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            autoFocus
            aria-label="Console command"
            placeholder="/tool api.notes.create_note"
            className="flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
        </div>
      </form>
    </div>
  );
}

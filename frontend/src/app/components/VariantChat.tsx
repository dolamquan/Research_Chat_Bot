import { useEffect, useRef, useState } from "react";
import { Eraser, Loader2, MessagesSquare, Send } from "lucide-react";

import type { DiscussionMessage } from "../types";

/**
 * Conversation about the change on screen. Grounded server-side in the
 * before/after structure, the operations applied, the verification findings
 * and the paper — so this is a discussion about *this* modification, not a
 * generic chat that happens to be nearby.
 */

const OPENERS_VARIANT = [
  "What did this change actually break?",
  "What would have to be true for this to work?",
  "What experiment would settle it?",
  "Has anyone tried this before?",
];

const OPENERS_BASE = [
  "Which stage is the real bottleneck here?",
  "What would you change first to improve this?",
  "Which part of this is load-bearing?",
];

export function VariantChat({
  targetLabel,
  isVariant,
  history,
  loading,
  error,
  onSend,
  onClear,
  onFocusNodes,
}: {
  targetLabel: string;
  isVariant: boolean;
  history: DiscussionMessage[];
  loading: boolean;
  error: string | null;
  onSend: (message: string) => void;
  onClear: () => void;
  onFocusNodes: (nodeIds: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Keep the newest turn in view as the conversation grows.
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [history.length, loading]);

  function submit(text: string) {
    const message = text.trim();
    if (!message || loading) return;
    onSend(message);
    setDraft("");
  }

  const openers = isVariant ? OPENERS_VARIANT : OPENERS_BASE;
  const lastAssistant = [...history]
    .reverse()
    .find((item) => item.role === "assistant");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-zinc-800 p-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-teal-900/60 bg-teal-500/10 text-teal-300">
            <MessagesSquare className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              Discuss
            </div>
            <div className="truncate text-[11px] text-zinc-400">
              {isVariant ? "your change to " : ""}
              <span className="text-zinc-200">{targetLabel}</span>
            </div>
          </div>
        </div>
        {history.length > 0 && (
          <button
            onClick={onClear}
            title="Clear this conversation"
            className="shrink-0 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <Eraser className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {history.length === 0 && !loading && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-zinc-500">
              {isVariant
                ? "Ask about the modification. The answer is grounded in what changed, what the checks proved, and the paper itself — and it will tell you which is which."
                : "Ask about this algorithm before changing anything. Grounded in the diagram and the paper."}
            </p>
            <div className="space-y-1.5">
              {openers.map((opener) => (
                <button
                  key={opener}
                  onClick={() => submit(opener)}
                  className="block w-full rounded-md border border-zinc-800 px-2.5 py-1.5 text-left text-[11px] text-zinc-400 transition-colors hover:border-teal-700 hover:text-teal-200"
                >
                  {opener}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          {history.map((item) => (
            <div key={item.message_id}>
              {item.role === "user" ? (
                <div className="ml-6 rounded-lg border border-teal-900/50 bg-teal-950/30 px-2.5 py-1.5 text-xs text-teal-100/90">
                  {item.content}
                </div>
              ) : (
                <div>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
                    {item.content}
                  </p>
                  {item.node_ids.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="font-mono text-[9px] uppercase tracking-wide text-zinc-600">
                        about
                      </span>
                      {item.node_ids.map((id) => (
                        <button
                          key={id}
                          onClick={() => onFocusNodes([id])}
                          title="Show this stage in the diagram"
                          className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 transition-colors hover:border-teal-600 hover:text-teal-200"
                        >
                          {id}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {loading && (
          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-300" />
            Reading the paper and the change…
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-red-900/60 bg-red-950/80 px-2.5 py-1.5 text-[11px] text-red-300">
            {error}
          </div>
        )}

        {!loading && lastAssistant && lastAssistant.suggestions.length > 0 && (
          <div className="mt-3 space-y-1">
            {lastAssistant.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => submit(suggestion)}
                className="block w-full rounded-md border border-zinc-800 px-2.5 py-1.5 text-left text-[11px] text-zinc-400 transition-colors hover:border-teal-700 hover:text-teal-200"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-zinc-800 p-3">
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // The view closes popups on Escape; don't let that fire mid-sentence.
              if (event.key === "Escape") event.stopPropagation();
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(draft);
              }
            }}
            rows={2}
            placeholder="Ask about this change…"
            className="min-w-0 flex-1 resize-none rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-teal-600/60 focus:outline-none"
          />
          <button
            onClick={() => submit(draft)}
            disabled={!draft.trim() || loading}
            title="Send (Enter)"
            className="shrink-0 self-end rounded-md bg-teal-600 px-2.5 py-2 text-white transition-colors hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-zinc-600">
          Enter to send · Shift+Enter for a newline
        </p>
      </div>
    </div>
  );
}

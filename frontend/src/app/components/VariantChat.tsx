import { useEffect, useRef, useState } from "react";

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
      <div className="flex shrink-0 items-baseline justify-between gap-2 p-4 pb-3">
        <div className="min-w-0">
          <h4 className="text-xs font-medium text-ivory-500">Discuss</h4>
          <div className="mt-0.5 truncate text-xs text-ivory-500">
            {isVariant ? "your change to " : ""}
            <span className="text-ivory-300">{targetLabel}</span>
          </div>
        </div>
        {history.length > 0 && (
          <button
            onClick={onClear}
            title="Clear this conversation"
            className="shrink-0 text-[11px] text-ivory-500 hover:text-ivory-100"
          >
            Clear
          </button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {history.length === 0 && !loading && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-ivory-500">
              {isVariant
                ? "Ask about the modification. The answer is grounded in what changed, what the checks proved, and the paper itself — and it will tell you which is which."
                : "Ask about this algorithm before changing anything. Grounded in the diagram and the paper."}
            </p>
            <div>
              {openers.map((opener) => (
                <button
                  key={opener}
                  onClick={() => submit(opener)}
                  className="block w-full rounded px-2 py-1.5 text-left text-[12px] leading-relaxed text-ivory-300 hover:bg-desk-850 hover:text-accent-300"
                >
                  {opener}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          {history.map((item) => (
            <div key={item.message_id}>
              {item.role === "user" ? (
                <div className="ml-8 rounded bg-desk-800 px-3 py-2 text-xs leading-relaxed text-ivory-100">
                  {item.content}
                </div>
              ) : (
                <div>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-ivory-300">
                    {item.content}
                  </p>
                  {item.node_ids.length > 0 && (
                    <p className="mt-1.5 text-[11px] text-ivory-700">
                      About{" "}
                      {item.node_ids.map((id, index) => (
                        <span key={id}>
                          {index > 0 && ", "}
                          <button
                            onClick={() => onFocusNodes([id])}
                            title="Show this stage in the diagram"
                            className="font-mono text-[10px] text-accent-400 hover:text-accent-300"
                          >
                            {id}
                          </button>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {loading && (
          <p className="mt-3 animate-pulse text-xs text-ivory-300">
            Reading the paper and the change…
          </p>
        )}

        {error && (
          <p className="mt-3 text-[11px] leading-relaxed text-pen-red">
            {error}
          </p>
        )}

        {!loading && lastAssistant && lastAssistant.suggestions.length > 0 && (
          <div className="mt-3">
            {lastAssistant.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => submit(suggestion)}
                className="block w-full rounded px-2 py-1.5 text-left text-[12px] leading-relaxed text-ivory-500 hover:bg-desk-850 hover:text-accent-300"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 p-3 pt-0">
        <div className="flex gap-2 rounded bg-desk-850 p-1.5">
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
            className="min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-xs leading-relaxed text-ivory-100 placeholder:text-ivory-700 focus:outline-none"
          />
          <button
            onClick={() => submit(draft)}
            disabled={!draft.trim() || loading}
            title="Send (Enter)"
            className="shrink-0 self-end rounded px-2 py-1 text-xs font-medium text-accent-400 hover:bg-desk-800 hover:text-accent-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "…" : "Send"}
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[10px] text-ivory-700">
          Enter to send · Shift+Enter for a newline
        </p>
      </div>
    </div>
  );
}

/**
 * One chat message: its pinned context, the answer body, the papers it was
 * grounded in, its citations and the tools the agent ran to produce it.
 */
import { useState } from "react";
import { Bot, FileText, NotebookPen, User } from "lucide-react";

import { getVisualImageUrl } from "../../api";
import { FormattedText } from "../MarkdownBody";
import {
  citationTitle,
  contextLabel,
  isPaperSource,
  paperSourceKey,
  paperSubtitle,
  paperTitle,
  sourceCitationLabel,
  sourceKey,
  sourceTextValue,
} from "../../appHelpers";
import type { Message, Source } from "../../types";

function MessageContextCard({ source, index }: { source: Source; index: number }) {
  const imageUrl =
    typeof source.image_url === "string" ? getVisualImageUrl(source.image_url) : "";
  const text = typeof source.text === "string" ? source.text : "";

  return (
    <div className="w-full rounded border border-primary/25 bg-primary/10 overflow-hidden">
      {imageUrl && (
        <div className="border-b border-primary/20 bg-background/60">
          <img
            src={imageUrl}
            alt={sourceTextValue(source.title) || "Pinned visual context"}
            className="max-h-36 w-full object-contain"
          />
        </div>
      )}
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-primary">
            Referencing
          </span>
          <span className="min-w-0 truncate text-[11px] font-medium text-foreground">
            {contextLabel(source, index)}
          </span>
        </div>
        {text && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-3">
            {text}
          </p>
        )}
      </div>
    </div>
  );
}

function MessagePaperCards({
  sources,
  onOpenSource,
}: {
  sources: Source[];
  onOpenSource: (source: Source) => void;
}) {
  const safeSources = Array.isArray(sources) ? sources : [];
  const paperSources = Array.from(
    safeSources
      .filter(isPaperSource)
      .reduce((papers, source) => {
        const key = paperSourceKey(source);
        if (key && !papers.has(key)) papers.set(key, source);
        return papers;
      }, new Map<string, Source>())
      .values(),
  ).slice(0, 5);

  if (paperSources.length === 0) return null;

  return (
    <div className="mt-2 w-full space-y-2">
      <p className="px-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Retrieved papers
      </p>
      <div className="grid gap-2">
        {paperSources.map((source) => (
          <article
            key={paperSourceKey(source)}
            className="rounded border border-border bg-card px-3 py-2"
          >
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-primary/25 bg-primary/10 text-primary">
                <FileText size={13} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words text-xs font-semibold text-foreground">
                  {paperTitle(source)}
                </p>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                  {paperSubtitle(source) || sourceTextValue(source.source)}
                </p>
                {(sourceTextValue(source.summary) || sourceTextValue(source.text)) && (
                  <p className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
                    {sourceTextValue(source.summary) || sourceTextValue(source.text)}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onOpenSource(source)}
                className="shrink-0 rounded border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/20"
              >
                Read PDF
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export default function MessageBubble({
  message,
  onOpenSource,
  onSaveNote,
}: {
  message: Message;
  onOpenSource: (source: Source) => void;
  onSaveNote?: (message: Message) => Promise<void>;
}) {
  const isUser = message.role === "user";
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );

  async function saveAsNote() {
    if (!onSaveNote || noteState === "saving") return;
    setNoteState("saving");
    try {
      await onSaveNote(message);
      setNoteState("saved");
    } catch {
      setNoteState("error");
    }
  }
  const pinnedSources = Array.isArray(message.pinnedSources) ? message.pinnedSources : [];
  const messageSources = Array.isArray(message.sources) ? message.sources : [];
  const citationSources = messageSources.filter(
    (source) => typeof source?.source === "string" && typeof source?.page === "number",
  );

  return (
    <div
      className={`w-full min-w-0 flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <div
        className={`w-8 h-8 shrink-0 rounded border flex items-center justify-center ${
          isUser
            ? "border-border bg-secondary text-foreground"
            : "bg-background border-border text-muted-foreground"
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div
        className={`min-w-0 max-w-[calc(100vw_-_5.5rem)] md:max-w-[78%] flex flex-col gap-2 ${
          isUser ? "items-end" : "items-start"
        }`}
      >
        {isUser && pinnedSources.length > 0 && (
          <div className="w-full space-y-2">
            {pinnedSources.map((source, index) => (
              <MessageContextCard
                key={`${sourceKey(source)}:${index}`}
                source={source}
                index={index}
              />
            ))}
          </div>
        )}
        <div
          className={`rounded px-4 py-3 text-sm ${
            isUser
              ? "rm-message-user text-foreground"
              : "rm-message-assistant border text-secondary-foreground"
          }`}
        >
          <div className="break-words overflow-hidden">
            <FormattedText content={message.content} />
          </div>
        </div>
        {!isUser && messageSources.length > 0 && (
          <MessagePaperCards sources={messageSources} onOpenSource={onOpenSource} />
        )}
        {messageSources.length > 0 && (
          <div className="px-1 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">
              {messageSources.length} grounded source
              {messageSources.length === 1 ? "" : "s"}
            </span>
            {citationSources.slice(0, 8).map((source, index) => (
              <button
                key={`${sourceKey(source)}:${index}`}
                type="button"
                title={citationTitle(source)}
                onClick={() => onOpenSource(source)}
                className="h-5 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                {sourceCitationLabel(source, index)}
              </button>
            ))}
          </div>
        )}
        {!isUser && message.toolTrace && message.toolTrace.length > 0 && (
          <div className="px-1 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">
              Agent tools:
            </span>
            {message.toolTrace.map((step) => (
              <span
                key={`${step.tool}:${step.timestamp}`}
                title={step.message}
                className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {step.tool}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 px-1">
          <span className="font-mono text-[10px] text-muted-foreground">
            {message.timestamp.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {!isUser && onSaveNote && (
            <button
              type="button"
              title="Save this answer as a research note"
              disabled={noteState === "saving" || noteState === "saved"}
              onClick={() => void saveAsNote()}
              className="h-5 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50 inline-flex items-center gap-1"
            >
              <NotebookPen size={10} />
              {noteState === "saving"
                ? "Saving..."
                : noteState === "saved"
                  ? "Saved to notes"
                  : noteState === "error"
                    ? "Retry save"
                    : "Save as note"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

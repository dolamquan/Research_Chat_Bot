import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Mic, MicOff, Volume2, VolumeX, X } from "lucide-react";

import { ToolTimeline } from "../components/agent/ToolTimeline";
import { MarkdownBody } from "../components/MarkdownBody";
import type { AssistantTurn } from "./assistantTypes";
import { useAssistant } from "./AssistantProvider";

function TurnView({ turn }: { turn: AssistantTurn }) {
  const showThinking = turn.status === "running" && !turn.answer && !turn.streamingText && turn.tools.length === 0;
  return (
    <div className="space-y-2">
      {turn.user.text ? (
        <div className="flex justify-end">
          <div className="rm-message-user max-w-[85%] px-3 py-2 text-sm leading-relaxed">
            {turn.user.source === "voice" && <Mic size={10} className="mr-1.5 inline-block -translate-y-px text-[#bdbdbd]" aria-label="spoken" />}
            {turn.user.text}
          </div>
        </div>
      ) : null}
      {(turn.answer || turn.streamingText || turn.tools.length > 0 || turn.error || showThinking) && (
        <div className="rm-message-assistant border px-3 py-2 text-sm">
          {turn.answer ? (
            <MarkdownBody content={turn.answer} />
          ) : turn.streamingText ? (
            <p className="whitespace-pre-wrap leading-relaxed">
              {turn.streamingText}
              <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-[2px] bg-foreground/60" aria-hidden />
            </p>
          ) : showThinking ? (
            <p className="font-mono text-[10px] text-[#969696]">Thinking</p>
          ) : null}
          <ToolTimeline compact trace={turn.tools} />
          {turn.sources.length > 0 && (
            <ul className="mt-2 space-y-0.5 border-t border-border pt-2 text-[11px] text-[#bdbdbd]">
              {turn.sources.slice(0, 6).map((source, index) => {
                const title = String(source.title || source.source || source.id || "Source");
                const url = typeof source.url === "string" && source.url ? source.url : null;
                return (
                  <li key={`${turn.id}-src-${index}`} className="truncate">
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
                        {title}
                      </a>
                    ) : (
                      title
                    )}
                    {typeof source.page === "number" ? <span className="ml-1 font-mono text-[10px]">p.{source.page}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {turn.error ? <p className="mt-2 text-xs text-destructive">{turn.error}</p> : null}
          {turn.status === "cancelled" ? <p className="mt-2 font-mono text-[10px] text-[#969696]">Cancelled</p> : null}
        </div>
      )}
    </div>
  );
}

export function AssistantPanel() {
  const assistant = useAssistant();
  const { ctx, turns, socket, actions, ttsEnabled, voices, voice, catalogToolCount } = assistant;
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const workspace = useSyncExternalStore(assistant.workspace.subscribe, assistant.workspace.snapshot, assistant.workspace.snapshot);
  const context = workspace.selected_paper?.title || workspace.open_note?.title || workspace.selected_cluster?.cluster_label || "";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, ctx.confirmation]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    actions.sendText(text);
    setDraft("");
  }

  const englishVoices = voices.filter((item) => item.lang?.toLowerCase().startsWith("en"));

  return (
    <div
      className="fixed right-5 bottom-[4.75rem] z-[45] flex w-[24rem] max-h-[min(70vh,40rem)] flex-col rm-panel max-sm:inset-x-3 max-sm:bottom-[4.75rem] max-sm:w-auto"
      role="dialog"
      aria-label="Assistant panel"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-sm font-medium text-foreground">Assistant</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${socket === "open" ? "bg-white" : socket === "connecting" ? "bg-[#555]" : "bg-destructive"}`}
          title={socket === "open" ? `Connected · ${catalogToolCount} tools` : socket === "connecting" ? "Connecting" : "Disconnected"}
        />
        {context ? (
          <span className="min-w-0 truncate text-[11px] text-[#969696]" title={context}>
            on: {context}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={actions.newSession} className="text-[11px] text-[#969696] hover:text-foreground" title="Start a new assistant session">
            New session
          </button>
          <button type="button" onClick={() => actions.setPanelOpen(false)} aria-label="Close assistant panel" className="flex h-7 w-7 items-center justify-center text-[#969696] hover:bg-secondary hover:text-foreground">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {turns.length === 0 && !ctx.confirmation ? (
          <p className="text-xs leading-relaxed text-[#bdbdbd]">
            Ask for anything the app can do: find papers, open one at a page, answer from your library, save a note, start a
            visualization. {ctx.supported && !ctx.textOnlyReason ? 'Say "Hey Zoe" or type below.' : "Type below."}
          </p>
        ) : null}
        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
        {ctx.confirmation ? (
          <div className="border border-[rgba(255,255,255,0.28)] p-3">
            <p className="text-xs text-foreground">{ctx.confirmation.summary}</p>
            <p className="mt-1 font-mono text-[10px] text-[#969696]">
              {ctx.confirmation.tool} · {ctx.confirmation.effect}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button type="button" onClick={() => actions.confirm(true)} className="h-7 border border-border px-3 text-xs text-foreground hover:bg-secondary">
                Yes
              </button>
              <button type="button" onClick={() => actions.confirm(false)} className="h-7 border border-border px-3 text-xs text-foreground hover:bg-secondary">
                No
              </button>
              {ctx.state === "awaiting_confirmation" && ctx.supported ? <span className="text-[11px] text-[#969696]">or just say yes / no</span> : null}
            </div>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={submit} className="flex shrink-0 items-center gap-2 border-t border-border p-2">
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={ctx.supported && !ctx.textOnlyReason ? 'Type, or say "Hey Zoe"' : "Type to the assistant"}
          className="h-9 min-w-0 flex-1 border border-border bg-[#0d0d0d] px-3 text-sm text-foreground outline-none placeholder:text-[#8a8a8a] focus:border-[rgba(255,255,255,0.35)]"
        />
        {ctx.supported && !ctx.textOnlyReason ? (
          <button type="button" onClick={actions.toggleMute} title={ctx.muted ? "Unmute microphone" : "Mute microphone"} className="flex h-8 w-8 items-center justify-center text-[#969696] hover:bg-secondary hover:text-foreground">
            {ctx.muted ? <MicOff size={14} /> : <Mic size={14} />}
          </button>
        ) : null}
        <button type="button" onClick={() => actions.setTtsEnabled(!ttsEnabled)} title={ttsEnabled ? "Turn voice replies off" : "Turn voice replies on"} className="flex h-8 w-8 items-center justify-center text-[#969696] hover:bg-secondary hover:text-foreground">
          {ttsEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        {englishVoices.length > 1 ? (
          <select
            value={voice?.voiceURI ?? ""}
            onChange={(event) => actions.setVoice(event.target.value)}
            title="Voice"
            className="h-8 max-w-[7rem] border border-border bg-[#0d0d0d] px-1 text-[11px] text-[#bdbdbd] outline-none"
          >
            {englishVoices.map((item) => (
              <option key={item.voiceURI} value={item.voiceURI}>
                {item.name.replace(/^Microsoft |^Google /, "").slice(0, 28)}
              </option>
            ))}
          </select>
        ) : null}
      </form>
    </div>
  );
}

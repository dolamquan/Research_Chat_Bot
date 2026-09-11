import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Mic, MicOff, Square } from "lucide-react";

import { AssistantOrb } from "./AssistantOrb";
import { AssistantPanel } from "./AssistantPanel";
import { useAssistant } from "./AssistantProvider";

const ACTIVE_STATES = new Set(["idle_listening", "capturing", "sending", "thinking", "executing", "awaiting_confirmation", "speaking", "error"]);

function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [since]);
  if (since === null) return "";
  return `${Math.max(0, (now - since) / 1000).toFixed(1)}s`;
}

/**
 * The always-present corner of the app: the orb, a two-line caption saying
 * what the assistant hears or does, and the controls to mute or expand.
 */
export function AssistantDock({ yieldGpu = false }: { yieldGpu?: boolean }) {
  const assistant = useAssistant();
  const { ctx, display, caption, activeTool, panelOpen, actions } = assistant;
  const elapsed = useElapsed(activeTool ? activeTool.startedAt : null);
  const busy = ctx.inTurn || ctx.speaking || ctx.state === "capturing";
  const confirmation = ctx.state === "awaiting_confirmation" ? ctx.confirmation : null;
  const status = display === "executing" && activeTool ? `${caption.status} · ${elapsed}` : caption.status;
  const showCaption = Boolean(caption.primary || status);

  const orbTitle =
    display === "text_only"
      ? "Type to the assistant (Ctrl+Shift+J)"
      : display === "dormant"
        ? "Enable voice"
        : "Talk (Ctrl+Shift+Space)";

  return (
    <>
      {panelOpen && <AssistantPanel />}
      <div
        className="fixed right-5 bottom-5 z-[45] flex h-14 max-w-[26rem] items-center gap-3 rm-panel pl-1.5 pr-2 max-sm:left-3 max-sm:right-3 max-sm:max-w-none"
        role="region"
        aria-label="Assistant"
      >
        <button
          type="button"
          onClick={actions.pushToTalk}
          title={orbTitle}
          aria-label={orbTitle}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <AssistantOrb display={display} micLevel={assistant.micLevel} ttsLevel={assistant.ttsLevel} size={44} active={ACTIVE_STATES.has(display)} yield={yieldGpu} />
        </button>

        {showCaption && (
          <div className="min-w-0 flex-1 leading-tight">
            {caption.primary ? (
              <p className={`truncate text-xs ${display === "error" ? "text-destructive" : "text-foreground"}`} title={caption.primary}>
                {caption.primary}
                {display === "capturing" && <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-[2px] bg-foreground/70" aria-hidden />}
              </p>
            ) : null}
            {status ? (
              <p className="truncate font-mono text-[10px] text-[#969696]" title={status}>
                {status}
              </p>
            ) : null}
          </div>
        )}

        {confirmation ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => actions.confirm(true)} className="h-7 border border-border px-2 text-xs text-foreground hover:bg-secondary">
              Yes
            </button>
            <button type="button" onClick={() => actions.confirm(false)} className="h-7 border border-border px-2 text-xs text-foreground hover:bg-secondary">
              No
            </button>
          </div>
        ) : busy ? (
          <button
            type="button"
            onClick={actions.cancel}
            title="Stop (Esc)"
            aria-label="Stop"
            className="flex h-7 w-7 shrink-0 items-center justify-center text-[#969696] hover:bg-secondary hover:text-foreground"
          >
            <Square size={11} />
          </button>
        ) : null}

        {ctx.supported && !ctx.textOnlyReason && (
          <button
            type="button"
            onClick={actions.toggleMute}
            title={ctx.muted ? "Unmute microphone" : "Mute microphone"}
            aria-label={ctx.muted ? "Unmute microphone" : "Mute microphone"}
            className="flex h-7 w-7 shrink-0 items-center justify-center text-[#969696] hover:bg-secondary hover:text-foreground"
          >
            {ctx.muted ? <MicOff size={14} /> : <Mic size={14} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => actions.setPanelOpen(!panelOpen)}
          title={panelOpen ? "Hide assistant panel" : "Show assistant panel (Ctrl+Shift+J)"}
          aria-label={panelOpen ? "Hide assistant panel" : "Show assistant panel"}
          className="flex h-7 w-7 shrink-0 items-center justify-center text-[#969696] hover:bg-secondary hover:text-foreground"
        >
          {panelOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
    </>
  );
}

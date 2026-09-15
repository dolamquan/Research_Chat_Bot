import { useState } from "react";

import { callAgentTool, callMcpTool } from "../../api";
import { ActivityPanel } from "./ActivityPanel";
import { CommandBar, type CommandExecutor } from "./CommandBar";
import { glassBackdrop } from "./glass";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { JobsPanel } from "./JobsPanel";
import { OverviewPanel, type ConsoleTab } from "./OverviewPanel";
import { ToolCatalogPanel } from "./ToolCatalogPanel";

const TABS: Array<{ id: ConsoleTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "tools", label: "Tools" },
  { id: "activity", label: "Activity" },
  { id: "jobs", label: "Jobs" },
  { id: "diagnostics", label: "Diagnostics" },
];

export type ConsoleTarget = "evaluation" | "crawler" | "library";

/**
 * Where you see and operate the machine Zoe drives. The Overview answers the
 * questions that matter in sentences; the other tabs hold the detail, and the
 * command line stays folded away until asked for. The page header above
 * already names this page, so nothing here repeats it.
 */
export function ConsoleView({ onOpenView }: { onOpenView: (view: ConsoleTarget) => void }) {
  const [tab, setTab] = useState<ConsoleTab>("overview");
  const [selectedTool, setSelectedTool] = useState<string | null>(null);

  const execute: CommandExecutor = async (command) => {
    if (command.kind === "tool") {
      setTab("tools");
      setSelectedTool(command.name);
      return `Opened ${command.name} in Tools.`;
    }
    if (command.kind === "call") {
      const response = await callAgentTool({ name: command.name, arguments: command.args });
      return JSON.stringify(response.result, null, 2);
    }
    const response = await callMcpTool({ toolName: command.name, arguments: command.args });
    return JSON.stringify(response.result, null, 2);
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border bg-card px-5 md:px-8">
        <div role="tablist" aria-label="Console sections" className="flex gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`-mb-px border-b-2 px-3 py-2.5 text-xs ${
                tab === item.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`min-h-0 flex-1 overflow-hidden ${glassBackdrop}`} role="tabpanel">
        {tab === "overview" ? (
          <OverviewPanel onOpenTab={setTab} />
        ) : tab === "tools" ? (
          <ToolCatalogPanel selectedName={selectedTool} onSelect={setSelectedTool} />
        ) : tab === "activity" ? (
          <ActivityPanel />
        ) : tab === "jobs" ? (
          <JobsPanel onOpenView={onOpenView} />
        ) : (
          <DiagnosticsPanel />
        )}
      </div>

      <CommandBar execute={execute} />
    </section>
  );
}

export default ConsoleView;

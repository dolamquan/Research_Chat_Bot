import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  CheckCircle2,
  Loader2,
} from "lucide-react";

import { callMcpTool, getAgentSession, getAgentSessions, getMcpTools } from "../api";
import type { AgentSession, ChatHistoryItem, ChatResponse, McpTool } from "../types";

declare global {
  interface Window {
    mermaid?: {
      initialize: (options: Record<string, unknown>) => void;
      render: (
        id: string,
        definition: string,
      ) => Promise<{ svg: string; bindFunctions?: (element: Element) => void }>;
    };
  }
}

type ConsoleEntry =
  | {
      id: string;
      kind: "user";
      content: string;
      timestamp: Date;
    }
  | {
      id: string;
      kind: "agent";
      content: string;
      intent?: string;
      response: ChatResponse;
      timestamp: Date;
    }
  | {
      id: string;
      kind: "error";
      content: string;
      timestamp: Date;
    };

type SlashCommand = {
  name: string;
  label: string;
  description: string;
  template?: string;
  local?: boolean;
};

let mermaidLoader: Promise<void> | null = null;

function loadMermaid(): Promise<void> {
  if (window.mermaid) {
    return Promise.resolve();
  }

  if (mermaidLoader) {
    return mermaidLoader;
  }

  mermaidLoader = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-researchmind-mermaid]",
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Mermaid failed to load")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js";
    script.async = true;
    script.dataset.researchmindMermaid = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Mermaid failed to load"));
    document.head.appendChild(script);
  });

  return mermaidLoader;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/help",
    label: "Show help",
    description: "Explain available commands and tools.",
    local: true,
  },
  {
    name: "/tools",
    label: "List tools",
    description: "Show the internal tools the research agent can call.",
    local: true,
  },
  {
    name: "/mcp-tools",
    label: "List MCP tools",
    description: "Show tools exposed through the MCP bridge.",
    local: true,
  },
  {
    name: "/mcp-call",
    label: "Call MCP tool",
    description: "Call a bridge tool with JSON arguments.",
    template: '/mcp-call research.search_library {"query":"retrieval"}',
  },
  {
    name: "/clear",
    label: "Clear console",
    description: "Clear the agent console output.",
    local: true,
  },
  {
    name: "/resume",
    label: "Resume session",
    description: "List or resume previous agent console conversations.",
    template: "/resume ",
  },
  {
    name: "/search-papers",
    label: "Search papers",
    description: "Find new external papers across academic sources.",
    template: "search papers for ",
  },
  {
    name: "/search-arxiv",
    label: "Search arXiv",
    description: "Find new external arXiv papers only.",
    template: "search arXiv for ",
  },
  {
    name: "/search-library",
    label: "Search library",
    description: "Find papers already indexed in your local library.",
    template: "find indexed papers about  in my library",
  },
  {
    name: "/add-paper",
    label: "Add paper",
    description: "Add an arXiv or PDF URL to your database.",
    template: "add this paper to my database: ",
  },
  {
    name: "/save-note",
    label: "Save note",
    description: "Save a note for the currently selected PDF passage.",
    template: "save this note: ",
  },
  {
    name: "/notion-export",
    label: "Export Notion",
    description: "Create a Notion page from the current paper, selection, or recent answer.",
    template: "export this research context to Notion",
  },
  {
    name: "/github-issue",
    label: "GitHub issue",
    description: "Create a GitHub issue from the current research context.",
    template: "create a GitHub issue for ",
  },
  {
    name: "/github-search",
    label: "Search GitHub",
    description: "Find repositories related to a research implementation topic.",
    template: "search GitHub repositories for ",
  },
  {
    name: "/summarize-paper",
    label: "Summarize paper",
    description: "Summarize the selected paper or research topic.",
    template: "summarize this paper",
  },
  {
    name: "/visualize",
    label: "Generate visual",
    description: "Generate a Mermaid diagram from the selected paper or topic.",
    template: "generate a method diagram for this paper",
  },
  {
    name: "/notion-visual",
    label: "Visual to Notion",
    description: "Generate a Mermaid visualization and store it in Notion.",
    template: "generate a method diagram for this paper and export the visualization to Notion",
  },
  {
    name: "/rebuild-topology",
    label: "Rebuild topology",
    description: "Rebuild the paper topology map.",
    template: "rebuild topology",
  },
];

const TOOL_HELP = [
  ["retrieve_papers", "Answer research questions using Qdrant retrieval."],
  ["search_papers", "Search for new papers across arXiv, PubMed, bioRxiv, medRxiv, and Semantic Scholar."],
  ["search_arxiv", "Search for new papers from arXiv only."],
  ["search_library", "Find indexed papers in your local library."],
  ["add_paper", "Index an arXiv or PDF URL into your database."],
  ["save_note", "Save a note attached to selected PDF context."],
  ["rebuild_topology", "Recompute clusters and topology."],
  ["notion.create_research_page", "Export selected research context to Notion."],
  ["github.create_issue", "Create implementation or research follow-up issues."],
  ["github.search_repositories", "Find external code related to a paper or topic."],
  ["research.summarize_paper", "Create a structured summary from selected paper chunks."],
  ["research.generate_visualization", "Generate Mermaid diagrams from paper context."],
  ["notion.create_visualization_page", "Store Mermaid diagrams and explanations in Notion."],
];

function makeLocalResponse(content: string, intent = "local_command"): ConsoleEntry {
  return {
    id: `agent-${Date.now()}`,
    kind: "agent",
    content,
    intent,
    response: {
      session_id: "",
      answer: content,
      sources: [],
      intent,
      tool_trace: [],
    },
    timestamp: new Date(),
  };
}

function helpText(): string {
  return [
    "Slash commands:",
    ...SLASH_COMMANDS.map(
      (command) => `${command.name.padEnd(18)} ${command.description}`,
    ),
    "",
    "Examples:",
    "  /search-papers graph RAG",
    "  /search-arxiv graph RAG",
    "  /search-library retrieval augmented generation",
    "  /add-paper https://arxiv.org/abs/...",
    "  /notion-export",
    "  /github-issue add citation verifier for retrieved answers",
    "  /github-search graph RAG implementations",
    "  /summarize-paper",
    "  /visualize",
    "  /notion-visual",
    "  /rebuild-topology",
    "",
    "Agent sessions:",
    "  /resume            list previous agent sessions",
    "  /resume 1          resume the first listed session",
    "  /resume <id>       resume a session by id prefix",
  ].join("\n");
}

function toolsText(): string {
  return [
    "Available internal tools:",
    ...TOOL_HELP.map(([tool, description]) => `  ${tool.padEnd(18)} ${description}`),
  ].join("\n");
}

function mcpToolsText(tools: McpTool[]): string {
  if (tools.length === 0) {
    return "No MCP bridge tools are loaded yet.";
  }

  return [
    "MCP bridge tools:",
    ...tools.map((tool) => `  ${tool.name.padEnd(26)} ${tool.description}`),
    "",
    "Example:",
    '  /mcp-call research.search_library {"query":"graph rag","limit":5}',
    '  /mcp-call research.search_papers {"description":"graph rag","sources":["arxiv","pubmed"],"max_results":5}',
    '  /mcp-call research.summarize_paper {"title":"Graph RAG","query":"graph rag"}',
    '  /mcp-call research.generate_visualization {"query":"graph rag","visualization_type":"concept_map"}',
    '  /mcp-call notion.create_research_page {"title":"Graph RAG notes","summary":"Key findings"}',
    '  /mcp-call notion.create_visualization_page {"title":"Graph RAG visual","mermaid":"flowchart TD\\nA[Query] --> B[Retriever]","explanation":"A simple RAG flow"}',
    '  /mcp-call github.create_issue {"title":"Add citation verifier","body":"Track citation coverage"}',
  ].join("\n");
}

function parseMcpCall(command: string): { toolName: string; args: Record<string, unknown> } {
  const rest = command.replace(/^\/mcp-call\s+/i, "").trim();
  const firstSpace = rest.indexOf(" ");
  if (firstSpace === -1) {
    return { toolName: rest, args: {} };
  }

  const toolName = rest.slice(0, firstSpace).trim();
  const rawArgs = rest.slice(firstSpace + 1).trim();
  return {
    toolName,
    args: rawArgs ? JSON.parse(rawArgs) : {},
  };
}

function extractMermaid(content: string): string | null {
  const fenced = content.match(/```mermaid\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) {
    return fenced[1].trim();
  }

  try {
    const parsed = JSON.parse(content) as { mermaid?: unknown };
    if (typeof parsed.mermaid === "string" && parsed.mermaid.trim()) {
      return parsed.mermaid.trim();
    }
  } catch {
    // Not JSON; keep looking for plain Mermaid below.
  }

  const trimmed = content.trim();
  if (/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|mindmap|timeline)\b/i.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function contentWithoutMermaidFence(content: string): string {
  return content.replace(/```mermaid\s*[\s\S]*?```/gi, "[Rendered Mermaid diagram]").trim();
}

function TerminalLogo() {
  const lines = ["  ______", " / ____/", "/ /__  ", "\\___ \\ ", "____/ /", "/_____/ "];

  return (
    <pre className="select-none text-[9px] leading-[0.82rem] text-[#d1d5db] md:text-[10px]">
      {lines.join("\n")}
    </pre>
  );
}

function TerminalBootHeader({ isRunning }: { isRunning: boolean }) {
  return (
    <div className="mb-8 flex items-start gap-6">
      <TerminalLogo />
      <div className="min-w-0 font-mono">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-lg font-semibold text-foreground">
            ResearchMind Agent
          </span>
          <span className="text-muted-foreground">v0.1.0</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          local research tools - MCP bridge - paper automation
        </p>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          ~\OneDrive\Documents\AI Engineer\Research-chatbot
        </p>
        <p className="mt-6 text-sm text-primary">
          {isRunning ? "* agent command running" : "* agent ready"}
          <span className="text-muted-foreground"> - type /help or /tools</span>
        </p>
      </div>
    </div>
  );
}

function MermaidDiagram({ definition }: { definition: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const renderId = `researchmind_mermaid_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;

    setSvg("");
    setError("");

    loadMermaid()
      .then(async () => {
        if (!window.mermaid) {
          throw new Error("Mermaid renderer is unavailable");
        }

        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "dark",
          flowchart: {
            curve: "basis",
            htmlLabels: false,
          },
        });

        const result = await window.mermaid.render(renderId, definition);
        if (active) {
          setSvg(result.svg);
        }
      })
      .catch((caught) => {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not render Mermaid diagram",
          );
        }
      });

    return () => {
      active = false;
    };
  }, [definition]);

  return (
    <div className="mt-3 rounded border border-primary/25 bg-card/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-primary">
          Mermaid diagram
        </span>
        {error && (
          <span className="text-[10px] text-destructive">
            Renderer unavailable
          </span>
        )}
      </div>

      {svg ? (
        <div
          className="overflow-x-auto rounded bg-[#0d0f12] p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="rounded bg-[#0d0f12] p-3 text-xs text-muted-foreground">
          {error ? "Showing Mermaid source instead." : "Rendering diagram..."}
        </div>
      )}

      {error && (
        <pre className="mt-3 max-h-60 overflow-auto rounded bg-[#0d0f12] p-3 text-xs text-secondary-foreground whitespace-pre-wrap">
          {definition}
        </pre>
      )}
    </div>
  );
}

function AgentContent({ content, kind }: { content: string; kind: ConsoleEntry["kind"] }) {
  const mermaid = useMemo(() => extractMermaid(content), [content]);
  const displayContent = mermaid ? contentWithoutMermaidFence(content) : content;

  return (
    <>
      {mermaid && <MermaidDiagram definition={mermaid} />}
      {displayContent && (
        <pre
          className={`mt-2 whitespace-pre-wrap break-words leading-relaxed ${
            kind === "error"
              ? "text-destructive"
              : "text-secondary-foreground"
          }`}
        >
          {displayContent}
        </pre>
      )}
    </>
  );
}

export function AgentConsoleView({
  onRun,
}: {
  onRun: (
    command: string,
    options?: { sessionId?: string; chatHistory?: ChatHistoryItem[] },
  ) => Promise<ChatResponse>;
}) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const [command, setCommand] = useState("");
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [, setAgentSessions] = useState<AgentSession[]>([]);
  const [activeAgentSessionId, setActiveAgentSessionId] = useState<string | undefined>();
  const [entries, setEntries] = useState<ConsoleEntry[]>([
    {
      id: "welcome",
      kind: "agent",
      content:
        "Research Agent ready. Try `search arXiv for graph RAG`, `find indexed papers about retrieval in my library`, `add this paper: <url>`, or `rebuild topology`.",
      intent: "ready",
      response: {
        session_id: "",
        answer: "",
        sources: [],
        intent: "ready",
        tool_trace: [],
      },
      timestamp: new Date(),
    },
  ]);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    let active = true;
    void refreshAgentSessions(active);
    getMcpTools()
      .then((result) => {
        if (active) setMcpTools(result.tools);
      })
      .catch(() => {
        if (active) setMcpTools([]);
      });
    return () => {
      active = false;
    };
  }, []);

  async function refreshAgentSessions(active = true) {
    try {
      const result = await getAgentSessions();
      if (active) setAgentSessions(result.sessions);
    } catch {
      if (active) setAgentSessions([]);
    }
  }

  function agentChatHistory(): ChatHistoryItem[] {
    return entries
      .filter((entry) => entry.kind === "user" || entry.kind === "agent")
      .map((entry) => ({
        role: entry.kind === "user" ? "user" : "assistant",
        content: entry.content,
      }));
  }

  const matchingCommands = command.trim().startsWith("/")
    ? SLASH_COMMANDS.filter((item) =>
        item.name.toLowerCase().startsWith(command.trim().toLowerCase()),
      )
    : [];

  useEffect(() => {
    const container = logRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [entries, isRunning]);

  function applySlashCommand(item: SlashCommand) {
    if (item.name === "/clear") {
      setEntries([]);
      setCommand("");
      return;
    }

    if (item.local) {
      setCommand(item.name);
      return;
    }

    setCommand(item.template || item.name);
  }

  function runLocalCommand(trimmed: string): boolean {
    if (trimmed === "/clear") {
      setEntries([]);
      return true;
    }

    if (trimmed === "/help") {
      setEntries((current) => [...current, makeLocalResponse(helpText(), "help")]);
      return true;
    }

    if (trimmed === "/tools") {
      setEntries((current) => [...current, makeLocalResponse(toolsText(), "tools")]);
      return true;
    }

    if (trimmed === "/mcp-tools") {
      setEntries((current) => [
        ...current,
        makeLocalResponse(mcpToolsText(mcpTools), "mcp_tools"),
      ]);
      return true;
    }

    return false;
  }

  function resumeListText(sessions: AgentSession[]): string {
    if (sessions.length === 0) {
      return "No saved agent sessions yet. Run a command, then use `/resume` later.";
    }

    return [
      "Saved agent sessions:",
      ...sessions.slice(0, 20).map((session, index) => {
        const updated = new Date(session.updated_at).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `${String(index + 1).padStart(2, " ")}. ${session.title}\n    ${session.id} - ${updated}`;
      }),
      "",
      "Resume with `/resume 1` or `/resume <session-id>`.",
    ].join("\n");
  }

  async function runResumeCommand(trimmed: string): Promise<boolean> {
    if (!trimmed.toLowerCase().startsWith("/resume")) {
      return false;
    }

    setIsRunning(true);
    try {
      const sessionsResult = await getAgentSessions();
      const sessions = sessionsResult.sessions;
      setAgentSessions(sessions);
      const target = trimmed.replace(/^\/resume\s*/i, "").trim();

      if (!target) {
        setEntries((current) => [
          ...current,
          makeLocalResponse(resumeListText(sessions), "resume"),
        ]);
        return true;
      }

      const numeric = Number.parseInt(target, 10);
      const session =
        Number.isFinite(numeric) && String(numeric) === target
          ? sessions[numeric - 1]
          : sessions.find(
              (item) =>
                item.id.startsWith(target) ||
                item.title.toLowerCase().includes(target.toLowerCase()),
            );

      if (!session) {
        setEntries((current) => [
          ...current,
          makeLocalResponse(`No agent session matched \`${target}\`.\n\n${resumeListText(sessions)}`, "resume"),
        ]);
        return true;
      }

      const detail = await getAgentSession(session.id);
      const loadedEntries: ConsoleEntry[] = detail.messages.map((message, index) => {
        const timestamp = new Date(message.created_at);
        if (message.role === "user") {
          return {
            id: `loaded-user-${index}-${message.created_at}`,
            kind: "user",
            content: message.content,
            timestamp,
          };
        }

        return {
          id: `loaded-agent-${index}-${message.created_at}`,
          kind: "agent",
          content: message.content,
          intent: message.intent || undefined,
          response: {
            session_id: session.id,
            answer: message.content,
            sources: message.sources || [],
            intent: message.intent || undefined,
            tool_trace: message.tool_trace || [],
          },
          timestamp,
        };
      });

      setActiveAgentSessionId(session.id);
      setEntries([
        makeLocalResponse(`Resumed agent session: ${session.title}\n${session.id}`, "resume"),
        ...loadedEntries,
      ]);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "Could not resume agent session.";
      const content =
        detail === "Not Found" || detail.includes("404")
          ? "Agent session history is not available on the running backend. Restart the backend so it loads the latest `/agent/sessions` routes, then try `/resume` again."
          : detail;

      setEntries((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          kind: "error",
          content,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsRunning(false);
    }

    return true;
  }

  async function runMcpCall(trimmed: string): Promise<boolean> {
    if (!trimmed.toLowerCase().startsWith("/mcp-call")) {
      return false;
    }

    setIsRunning(true);
    try {
      const { toolName, args } = parseMcpCall(trimmed);
      const response = await callMcpTool({ toolName, arguments: args });
      const content = JSON.stringify(response.result, null, 2);
      setEntries((current) => [
        ...current,
        makeLocalResponse(content, "mcp_call"),
      ]);
    } catch (error) {
      setEntries((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          kind: "error",
          content:
            error instanceof Error
              ? error.message
              : "MCP bridge call failed.",
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsRunning(false);
    }

    return true;
  }

  async function submitCommand(event: FormEvent) {
    event.preventDefault();
    const trimmed = command.trim();
    if (!trimmed || isRunning) return;

    setCommand("");
    setEntries((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        kind: "user",
        content: trimmed,
        timestamp: new Date(),
      },
    ]);

    if (runLocalCommand(trimmed)) {
      return;
    }

    if (await runResumeCommand(trimmed)) {
      return;
    }

    if (await runMcpCall(trimmed)) {
      return;
    }

    setIsRunning(true);

    try {
      const response = await onRun(trimmed, {
        sessionId: activeAgentSessionId,
        chatHistory: agentChatHistory(),
      });
      setActiveAgentSessionId(response.session_id);
      void refreshAgentSessions();
      setEntries((current) => [
        ...current,
        {
          id: `agent-${Date.now()}`,
          kind: "agent",
          content: response.answer,
          intent: response.intent,
          response,
          timestamp: new Date(),
        },
      ]);
    } catch (error) {
      setEntries((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          kind: "error",
          content:
            error instanceof Error
              ? error.message
              : "Agent command failed.",
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <section className="h-full min-h-0 flex flex-col bg-[#141617] text-[13px]">
      <div
        ref={logRef}
        className="flex-1 min-h-0 overflow-y-auto px-6 py-7 font-mono md:px-10"
      >
        <TerminalBootHeader isRunning={isRunning} />

        <div className="space-y-7">
          {entries.map((entry) => (
            <div key={entry.id} className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {entry.kind === "user" ? (
                  <>
                    <span className="text-primary">&gt;</span>
                    <span className="text-primary">$</span>
                  </>
                ) : entry.kind === "error" ? (
                  <>
                    <span className="text-destructive">|</span>
                    <span className="text-destructive">error</span>
                  </>
                ) : (
                  <>
                    <span className="text-primary">|</span>
                    <span className="text-primary">agent</span>
                  </>
                )}
                {entry.kind === "agent" && entry.intent && (
                  <span className="rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                    {entry.intent}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {entry.timestamp.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              {entry.kind === "user" ? (
                <pre className="ml-6 whitespace-pre-wrap break-words leading-relaxed text-foreground">
                  {entry.content}
                </pre>
              ) : (
                <div className="ml-6 border-l-4 border-[#d1d5db] pl-4">
                  <AgentContent content={entry.content} kind={entry.kind} />
                </div>
              )}

              {entry.kind === "agent" &&
                entry.response.tool_trace &&
                entry.response.tool_trace.length > 0 && (
                  <div className="ml-6 mt-3 flex flex-wrap gap-1.5">
                    {entry.response.tool_trace.map((step) => (
                      <span
                        key={`${entry.id}-${step.tool}-${step.timestamp}`}
                        title={step.message}
                        className="inline-flex items-center gap-1 rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                      >
                        <CheckCircle2 size={10} />
                        {step.tool}
                      </span>
                    ))}
                  </div>
                )}
            </div>
          ))}

          {isRunning && (
            <div className="flex items-center gap-2 text-primary">
              <span>|</span>
              <Loader2 size={13} className="animate-spin" />
              <span>running command...</span>
            </div>
          )}
        </div>
      </div>

      <form
        onSubmit={(event) => void submitCommand(event)}
        className="shrink-0 border-t border-[#707070] bg-[#141617] px-6 py-3 md:px-10"
      >
        <div className="relative">
          {matchingCommands.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-3 overflow-hidden border border-[#707070] bg-[#101214] shadow-2xl">
              <div className="border-b border-[#303235] px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Slash commands
              </div>
              <div className="max-h-72 overflow-y-auto p-1">
                {matchingCommands.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => applySlashCommand(item)}
                    className="w-full rounded-sm px-3 py-2 text-left font-mono hover:bg-[#1c1f23]"
                  >
                    <div className="grid gap-1 md:grid-cols-[13rem_1fr] md:items-baseline">
                      <span className="text-primary">{item.name}</span>
                      <span className="text-muted-foreground">
                        {item.description}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 border-y border-[#707070] py-2">
            <span className="font-mono text-xl text-foreground">&gt;</span>
            <textarea
              value={command}
              rows={1}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Tab" && matchingCommands[0]) {
                  event.preventDefault();
                  applySlashCommand(matchingCommands[0]);
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitCommand(event);
                }
              }}
              placeholder='Try "/help", "search arXiv for graph RAG", or "add this paper: <url>"'
              className="min-h-8 flex-1 resize-none bg-transparent py-1 font-mono text-base text-foreground outline-none placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              disabled={!command.trim() || isRunning}
              className="h-8 rounded-sm border border-primary/30 px-3 font-mono text-xs text-primary disabled:opacity-35 hover:bg-primary/10"
            >
              {isRunning ? "running" : "run"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

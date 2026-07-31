import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  FilePlus2,
  HelpCircle,
  Loader2,
  RefreshCw,
  Send,
  Search,
  Terminal,
  User,
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
    <section className="h-full min-h-0 flex flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-card px-5 md:px-8 py-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
            <BrainCircuit size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              research agent
            </p>
            <h2
              className="mt-1 text-2xl font-semibold tracking-tight text-foreground"
              style={{ fontFamily: "'Epilogue', sans-serif" }}
            >
              Agent console
            </h2>
          <p className="mt-1 text-sm text-muted-foreground">
              Type `/` for commands, or run natural language tool requests.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 md:px-8 py-5">
        <div className="min-h-full rounded border border-border bg-[#08090a] p-4 font-mono text-xs">
          <div className="mb-4 flex items-center gap-2 border-b border-border pb-3 text-muted-foreground">
            <Terminal size={14} className="text-primary" />
            <span>ResearchMind internal tools</span>
            {isRunning && (
              <span className="ml-auto flex items-center gap-2 text-primary">
                <Loader2 size={13} className="animate-spin" />
                running
              </span>
            )}
          </div>

          <div className="space-y-5">
            {entries.map((entry) => (
              <div key={entry.id} className="flex gap-3">
                <div
                  className={`mt-0.5 w-7 h-7 shrink-0 rounded border flex items-center justify-center ${
                    entry.kind === "user"
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : entry.kind === "error"
                        ? "border-destructive/30 bg-destructive/10 text-destructive"
                        : "border-border bg-card text-primary"
                  }`}
                >
                  {entry.kind === "user" ? (
                    <User size={13} />
                  ) : entry.kind === "error" ? (
                    <Terminal size={13} />
                  ) : (
                    <Bot size={13} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-primary">
                      {entry.kind === "user" ? "$" : "agent"}
                    </span>
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
                  <AgentContent content={entry.content} kind={entry.kind} />
                  {entry.kind === "agent" &&
                    entry.response.tool_trace &&
                    entry.response.tool_trace.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
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
              </div>
            ))}
          </div>
        </div>
      </div>

      <form
        onSubmit={(event) => void submitCommand(event)}
        className="shrink-0 border-t border-border bg-card px-5 md:px-8 py-4"
      >
        <div className="relative mx-auto max-w-5xl">
          {matchingCommands.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-2 rounded border border-border bg-card shadow-xl overflow-hidden">
              <div className="border-b border-border px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Commands
              </div>
              <div className="max-h-64 overflow-y-auto p-1">
                {matchingCommands.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => applySlashCommand(item)}
                    className="w-full rounded px-3 py-2 text-left hover:bg-secondary"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-7 h-7 rounded border border-primary/25 bg-primary/10 text-primary flex items-center justify-center">
                        {item.name === "/help" ? (
                          <HelpCircle size={13} />
                        ) : item.name === "/tools" ? (
                          <Terminal size={13} />
                        ) : item.name === "/add-paper" ? (
                          <FilePlus2 size={13} />
                        ) : item.name === "/rebuild-topology" ? (
                          <RefreshCw size={13} />
                        ) : (
                          <Search size={13} />
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-foreground">
                          {item.name}
                          <span className="ml-2 font-sans text-xs text-muted-foreground">
                            {item.label}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {item.description}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-end gap-2 rounded border border-primary/35 bg-background p-2">
            <div className="px-2 py-2 font-mono text-sm text-primary">$</div>
            <textarea
              value={command}
              rows={2}
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
              placeholder="Type / for commands..."
              className="min-h-12 flex-1 resize-none bg-transparent px-1 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              disabled={!command.trim() || isRunning}
              className="w-10 h-10 rounded bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-45"
            >
              {isRunning ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

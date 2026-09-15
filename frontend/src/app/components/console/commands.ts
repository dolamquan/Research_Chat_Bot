/**
 * The console's command line: the model-free way to run a tool.
 *
 * Zoe can be asked to call a tool, but whether she does — and with which
 * arguments — is the model's decision. `/call` and `/mcp-call` run exactly
 * the named tool with exactly the given JSON, which is what you want when a
 * tool misbehaves and you need to know whether it is the tool or the model.
 */

export type ParsedCommand =
  | { kind: "call"; name: string; args: Record<string, unknown> }
  | { kind: "mcp-call"; name: string; args: Record<string, unknown> }
  | { kind: "tool"; name: string }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "invalid"; message: string }
  | { kind: "unknown"; input: string };

export type CommandSpec = { name: string; description: string; template?: string };

export const COMMANDS: CommandSpec[] = [
  {
    name: "/call",
    description: "Run one catalog tool with JSON arguments, exactly as given; no model involved.",
    template: '/call app.papers {"query":"graph rag","limit":5}',
  },
  {
    name: "/mcp-call",
    description: "Run one MCP bridge tool with JSON arguments.",
    template: '/mcp-call research.search_library {"query":"retrieval"}',
  },
  {
    name: "/tool",
    description: "Open a tool in the catalog, with its schema and run form.",
    template: "/tool api.notes.create_note",
  },
  { name: "/help", description: "List these commands." },
  { name: "/clear", description: "Clear the command output." },
];

function splitNameAndJson(rest: string): { name: string; args: Record<string, unknown> } {
  const trimmed = rest.trim();
  if (!trimmed) throw new Error("a tool name is required");
  const space = trimmed.search(/\s/);
  if (space === -1) return { name: trimmed, args: {} };
  const name = trimmed.slice(0, space);
  const raw = trimmed.slice(space).trim();
  if (!raw) return { name, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("arguments must be a JSON object, e.g. {\"query\":\"graph rag\"}");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("arguments must be a JSON object");
  }
  return { name, args: parsed as Record<string, unknown> };
}

export function parseCommand(input: string): ParsedCommand {
  const text = input.trim();
  if (!text.startsWith("/")) return { kind: "unknown", input: text };
  const space = text.search(/\s/);
  const verb = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : text.slice(space);

  try {
    switch (verb) {
      case "/call":
        return { kind: "call", ...splitNameAndJson(rest) };
      case "/mcp-call":
        return { kind: "mcp-call", ...splitNameAndJson(rest) };
      case "/tool": {
        const name = rest.trim().split(/\s+/)[0] ?? "";
        if (!name) return { kind: "invalid", message: "/tool needs a tool name" };
        return { kind: "tool", name };
      }
      case "/help":
        return { kind: "help" };
      case "/clear":
        return { kind: "clear" };
      default:
        return { kind: "unknown", input: text };
    }
  } catch (error) {
    return { kind: "invalid", message: `${verb}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function helpText(): string {
  return [
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(11)} ${command.description}`),
    "",
    "Examples:",
    ...COMMANDS.filter((c) => c.template).map((c) => `  ${c.template}`),
    "",
    "For anything in plain language, ask Zoe — she runs the same tools and can navigate the app.",
  ].join("\n");
}

/** Commands whose name starts with what was typed, for the completion strip. */
export function matchingCommands(input: string): CommandSpec[] {
  const text = input.trim().toLowerCase();
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  return COMMANDS.filter((command) => command.name.startsWith(text));
}

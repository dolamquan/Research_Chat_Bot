import type { AgentTool } from "../../types";

/**
 * Turning catalog metadata into words a person would use.
 *
 * The catalog describes a route tool with its Python docstring plus the route
 * in brackets: "List agent sessions; `kind=assistant` lists the … [GET
 * /agent/sessions]". The title is the first clause; the rest is explanation;
 * the bracketed route is plumbing and belongs in technical details only.
 */

const ROUTE_SUFFIX = /\s*\[(?:GET|POST|PUT|PATCH|DELETE)\s+[^\]]*\]\s*$/i;
const TITLE_MAX = 64;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Description without the bracketed route. */
export function cleanDescription(tool: AgentTool): string {
  return tool.description.replace(ROUTE_SUFFIX, "").trim();
}

/** The first clause of the description, or the name's last segment as words. */
export function toolTitle(tool: AgentTool): string {
  const text = cleanDescription(tool);
  if (!text) return humanLabel(tool.name.split(".").pop() ?? tool.name);
  // Cut at the first clause boundary; a docstring's first clause is its title.
  const match = text.match(/^(.*?)(?:[.;:]\s|\s[—–-]\s|$)/);
  let title = (match?.[1] ?? text).trim().replace(/[.;:]$/, "");
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX).replace(/\s+\S*$/, "");
    title = `${cut}…`;
  }
  return capitalize(title.replace(/`/g, ""));
}

/** Everything after the title clause, for the detail view. Empty when there is nothing more. */
export function toolExplanation(tool: AgentTool): string {
  const text = cleanDescription(tool);
  const title = toolTitle(tool).replace(/…$/, "");
  const rest = text.replace(/`/g, "").startsWith(title) ? text.slice(text.replace(/`/g, "").indexOf(title) + title.length) : text;
  // Only drop the remainder when the title genuinely was the whole thing.
  const trimmed = rest.replace(/^[\s.;:—–-]+/, "").trim();
  if (!trimmed || trimmed.replace(/`/g, "") === title) return "";
  return capitalize(trimmed);
}

/** `note_id` → "Note ID", `document_source` → "Document source". */
export function humanLabel(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (["id", "url", "pdf", "json", "api", "mcp", "ids", "uri"].includes(lower)) return lower.toUpperCase();
      return lower;
    });
  return capitalize(words.join(" "));
}

/** The HTTP grouping of an api.* tool's arguments, in the user's terms. */
export const GROUP_LABELS: Record<string, { label: string; hint: string }> = {
  path: { label: "Which item", hint: "Identifies what the tool acts on." },
  query: { label: "Options", hint: "" },
  body: { label: "Details", hint: "" },
};

export function groupLabel(name: string | null): { label: string; hint: string } | null {
  if (!name) return null;
  return GROUP_LABELS[name] ?? { label: humanLabel(name), hint: "" };
}

/** What running the tool does, as one sentence. */
export function effectSentence(effect: string): { text: string; className: string } {
  switch (effect) {
    case "destructive":
      return { text: "Deletes data. This cannot be undone.", className: "text-destructive" };
    case "external_write":
      return { text: "Writes to an outside service such as Notion or GitHub.", className: "text-primary" };
    case "write":
      return { text: "Changes data in your workspace.", className: "text-foreground" };
    default:
      return { text: "Read-only. Running it changes nothing.", className: "text-muted-foreground" };
  }
}

/** Short words for a row, and the colour that says how careful to be. */
export function effectLabel(effect: string): { text: string; className: string } {
  switch (effect) {
    case "destructive":
      return { text: "deletes data", className: "text-destructive" };
    case "external_write":
      return { text: "writes outside the app", className: "text-primary" };
    case "write":
      return { text: "changes data", className: "text-muted-foreground" };
    default:
      return { text: "read only", className: "text-muted-foreground" };
  }
}

/** One line about a result: how many things came back, if that is knowable. */
export function describeResult(result: unknown): string {
  if (Array.isArray(result)) return `${result.length} item${result.length === 1 ? "" : "s"}`;
  if (result && typeof result === "object") {
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      if (Array.isArray(value)) return `${value.length} ${humanLabel(key).toLowerCase()}`;
    }
    const keys = Object.keys(result as object);
    if (keys.length === 0) return "Done";
    if (keys.length <= 3) return keys.map((key) => humanLabel(key)).join(", ");
    return `${keys.length} fields`;
  }
  if (result === null || result === undefined) return "Done";
  return String(result);
}

/** Split on backticks so `code` in a docstring renders as code. */
export function inlineSegments(text: string): Array<{ code: boolean; text: string }> {
  return text
    .split(/(`[^`]+`)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("`") ? { code: true, text: part.slice(1, -1) } : { code: false, text: part }));
}

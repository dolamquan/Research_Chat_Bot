/**
 * Tools the browser lends the model, and the dispatcher that runs them
 * against whatever the mounted views have registered.
 */
import type { Article, Cluster } from "../types";
import type { AssistantWorkspace, ClientToolSpec, UiAction } from "./assistantTypes";
import type { UiActionRegistry, WorkspaceStore } from "./uiActionRegistry";

export const VIEWS = ["chat", "library", "crawler", "reddit", "notes", "console", "graph", "evaluation", "visualizer"] as const;

const str = { type: "string" } as const;

export const CLIENT_TOOL_SPECS: ClientToolSpec[] = [
  {
    name: "navigate_to_view",
    description: "Switch the main screen to one of the app's views.",
    effect: "read",
    input_schema: { type: "object", properties: { view: { type: "string", enum: [...VIEWS] } }, required: ["view"] },
  },
  {
    name: "open_paper",
    description: "Open a library paper in the PDF reader and focus chat on it. Give an article_id, a source filename, or a title fragment.",
    effect: "read",
    input_schema: { type: "object", properties: { article_id: str, source: str, title: str } },
  },
  {
    name: "open_pdf_page",
    description: "Jump the open PDF reader to a page (optionally open a different paper by source first).",
    effect: "read",
    input_schema: { type: "object", properties: { page: { type: "integer", minimum: 1 }, source: str }, required: ["page"] },
  },
  {
    name: "open_note",
    description: "Open the Notes view and start editing one note by note_id.",
    effect: "read",
    input_schema: { type: "object", properties: { note_id: str }, required: ["note_id"] },
  },
  {
    name: "create_note",
    description: "Create a new research note with a title and Markdown body, then show it in the Notes view.",
    effect: "write",
    input_schema: {
      type: "object",
      properties: { title: str, body: str, tags: { type: "array", items: str } },
      required: ["title", "body"],
    },
  },
  {
    name: "select_cluster",
    description: "Focus chat on one topology cluster by id or label, or clear the cluster selection.",
    effect: "read",
    input_schema: { type: "object", properties: { cluster_id: { type: "integer" }, label: str, clear: { type: "boolean" } } },
  },
  {
    name: "set_library_filter",
    description: "Filter the Paper Library by domain, category and/or search text (empty string clears a field).",
    effect: "read",
    input_schema: {
      type: "object",
      properties: { domain: str, category: str, search: str, open_library: { type: "boolean" } },
    },
  },
  {
    name: "pin_source",
    description: "Pin a passage or paper as chat context.",
    effect: "read",
    input_schema: {
      type: "object",
      properties: { source: str, title: str, page: { type: "integer" }, text: str, article_id: str },
      required: ["source"],
    },
  },
  {
    name: "unpin_source",
    description: "Remove a pinned source from chat context.",
    effect: "read",
    input_schema: { type: "object", properties: { source: str }, required: ["source"] },
  },
  {
    name: "start_visualization",
    description: "Open the Visualizer on a paper (by article_id or title) so a diagram can be generated or viewed.",
    effect: "read",
    input_schema: { type: "object", properties: { article_id: str, title: str } },
  },
  {
    name: "read_screen",
    description: "Describe what is currently on the user's screen: view, open paper and page, filters, chat scope.",
    effect: "read",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_ui_actions",
    description: "List the screen controls currently available.",
    effect: "read",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "start_new_chat",
    description: "Start a fresh chat session over the whole library.",
    effect: "read",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "load_chat_session",
    description: "Reopen a saved chat session by id.",
    effect: "read",
    input_schema: { type: "object", properties: { session_id: str }, required: ["session_id"] },
  },
  {
    name: "set_retrieval",
    description: "Change chat retrieval settings: context_mode (retrieval|whole_document) and/or retrieval_strategy (vector|graph|hybrid).",
    effect: "read",
    input_schema: {
      type: "object",
      properties: {
        context_mode: { type: "string", enum: ["retrieval", "whole_document"] },
        retrieval_strategy: { type: "string", enum: ["vector", "graph", "hybrid"] },
      },
    },
  },
];

export type ClientToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; candidates?: Array<{ article_id: string; title: string }> };

export type ClientToolDeps = {
  createNote: (payload: {
    note_type?: string;
    source_type?: string;
    source_ref?: string;
    source_title?: string;
    title?: string;
    body_md?: string;
    tags?: string[];
  }) => Promise<{ note: { note_id: string; title: string } }>;
  timeoutMs?: number;
};

const REQUIRED: Record<string, string[]> = Object.fromEntries(
  CLIENT_TOOL_SPECS.map((spec) => [spec.name, ((spec.input_schema as { required?: string[] }).required ?? [])]),
);

function missing(name: string, args: Record<string, unknown>): string | null {
  const absent = (REQUIRED[name] ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === "");
  return absent.length ? `Missing required argument${absent.length > 1 ? "s" : ""}: ${absent.join(", ")}` : null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createClientToolDispatcher(
  registry: UiActionRegistry,
  workspace: WorkspaceStore,
  deps: ClientToolDeps,
): (name: string, args: Record<string, unknown>) => Promise<ClientToolOutcome> {
  const timeoutMs = deps.timeoutMs ?? 10000;
  let queue: Promise<unknown> = Promise.resolve();

  const call = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const action = registry.get(name);
    if (!action) throw new Error(`The screen control "${name}" is not available on this view`);
    return action(...args);
  };

  const resolveArticle = async (ref: { article_id?: unknown; source?: unknown; title?: unknown }): Promise<Article | Article[] | undefined> => {
    const resolver = registry.get("resolveArticle");
    if (!resolver) throw new Error("The paper library is not loaded yet");
    return (await resolver(ref)) as Article | Article[] | undefined;
  };

  const run = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "navigate_to_view": {
        const view = String(args.view);
        if (!(VIEWS as readonly string[]).includes(view)) throw new Error(`Unknown view "${view}". Views: ${VIEWS.join(", ")}`);
        await call("navigateToView", view);
        return { view };
      }
      case "open_paper": {
        const found = await resolveArticle(args);
        if (Array.isArray(found)) {
          const error = new Error("Several papers match; ask the user which one") as Error & { candidates?: unknown };
          error.candidates = found.slice(0, 6).map((a) => ({ article_id: a.article_id, title: a.title }));
          throw error;
        }
        if (!found) throw new Error("No library paper matches that id, source or title");
        await call("openArticle", found);
        return { opened: true, article_id: found.article_id, title: found.title, source: found.source };
      }
      case "open_pdf_page": {
        const page = Number(args.page);
        if (!Number.isInteger(page) || page < 1) throw new Error("page must be a positive integer");
        if (args.source) {
          await call("openSource", { source: String(args.source), page });
          return { opened: true, source: String(args.source), page };
        }
        return call("setReaderPage", page);
      }
      case "open_note": {
        await call("navigateToView", "notes");
        const open = await registry.waitFor("notes.openNote");
        return open(String(args.note_id));
      }
      case "create_note": {
        const snapshot = workspace.snapshot();
        const result = await deps.createNote({
          note_type: "chat_capture",
          source_type: "assistant",
          source_ref: snapshot.active_chat_session?.id ?? "assistant",
          source_title: snapshot.selected_paper?.title ?? "Assistant",
          title: String(args.title).slice(0, 120),
          body_md: String(args.body),
          tags: Array.isArray(args.tags) ? args.tags.map(String) : ["assistant"],
        });
        await call("navigateToView", "notes");
        const refresh = registry.get("notes.refresh");
        if (refresh) await refresh();
        return { created: true, note_id: result.note.note_id, title: result.note.title };
      }
      case "select_cluster": {
        if (args.clear) {
          await call("clearCluster");
          return { cleared: true };
        }
        const resolver = registry.get("resolveCluster");
        if (!resolver) throw new Error("The topology is not loaded yet");
        const cluster = (await resolver(args)) as Cluster | undefined;
        if (!cluster) throw new Error("No cluster matches that id or label");
        await call("chooseCluster", cluster);
        return { selected: true, cluster_id: cluster.cluster_id, cluster_label: cluster.cluster_label };
      }
      case "set_library_filter":
        return call("setLibraryFilter", {
          domain: args.domain as string | undefined,
          category: args.category as string | undefined,
          search: args.search as string | undefined,
          openLibrary: args.open_library !== false,
        });
      case "pin_source": {
        await call("pinSource", {
          source: String(args.source), title: args.title, page: args.page, text: args.text, article_id: args.article_id,
        });
        return { pinned: true, source: String(args.source) };
      }
      case "unpin_source": {
        await call("unpinSource", { source: String(args.source) });
        return { unpinned: true };
      }
      case "start_visualization": {
        const found = await resolveArticle(args);
        if (Array.isArray(found)) {
          const error = new Error("Several papers match; ask the user which one") as Error & { candidates?: unknown };
          error.candidates = found.slice(0, 6).map((a) => ({ article_id: a.article_id, title: a.title }));
          throw error;
        }
        if (!found) throw new Error("No library paper matches that id or title");
        await call("navigateToView", "visualizer");
        const select = await registry.waitFor("visualizer.selectArticle");
        return select(found.article_id);
      }
      case "read_screen": {
        const describe = registry.get("describeScreen");
        return { summary: describe ? await describe() : "", workspace: workspace.snapshot() };
      }
      case "list_ui_actions":
        return { tools: CLIENT_TOOL_SPECS.map((spec) => ({ name: spec.name, description: spec.description })), available: registry.names() };
      case "start_new_chat":
        await call("startNewChat");
        return { started: true };
      case "load_chat_session":
        await call("loadChatSession", String(args.session_id));
        return { loaded: true, session_id: String(args.session_id) };
      case "set_retrieval": {
        if (args.context_mode) await call("setContextMode", String(args.context_mode));
        if (args.retrieval_strategy) await call("setRetrievalStrategy", String(args.retrieval_strategy));
        return { context_mode: args.context_mode ?? null, retrieval_strategy: args.retrieval_strategy ?? null };
      }
      default:
        throw new Error(`Unknown screen control "${name}"`);
    }
  };

  return (name, rawArgs) => {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const task = queue.then(async (): Promise<ClientToolOutcome> => {
      if (!CLIENT_TOOL_SPECS.some((spec) => spec.name === name)) return { ok: false, error: `Unknown screen control "${name}"` };
      const problem = missing(name, args);
      if (problem) return { ok: false, error: problem };
      try {
        const result = await withTimeout(run(name, args), timeoutMs, name);
        return { ok: true, result: result ?? { ok: true } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const candidates = (error as { candidates?: ClientToolOutcome extends { candidates?: infer C } ? C : never })?.candidates;
        return candidates ? { ok: false, error: message, candidates } : { ok: false, error: message };
      }
    });
    queue = task.catch(() => undefined);
    return task;
  };
}

export type { UiAction };

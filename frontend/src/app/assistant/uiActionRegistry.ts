/**
 * Views lend the assistant their handlers by name; the assistant publishes
 * what the user is looking at. Both are plain objects, not React state, so
 * registering the latest closures every render costs nothing.
 */
import type { AssistantWorkspace, UiAction } from "./assistantTypes";

export type UiActionRegistry = {
  register: (actions: Record<string, UiAction>) => () => void;
  /** Remove a name regardless of which closure currently holds it (view unmount). */
  unregister: (names: string[]) => void;
  get: (name: string) => UiAction | undefined;
  has: (name: string) => boolean;
  names: () => string[];
  /** Resolve when a view mounts and registers `name`; reject after `timeoutMs`. */
  waitFor: (name: string, timeoutMs?: number) => Promise<UiAction>;
};

export function createUiActionRegistry(): UiActionRegistry {
  const actions = new Map<string, UiAction>();
  const waiters = new Map<string, Array<(action: UiAction) => void>>();

  const notify = (name: string, action: UiAction) => {
    const list = waiters.get(name);
    if (!list) return;
    waiters.delete(name);
    list.forEach((resolve) => resolve(action));
  };

  return {
    register(next) {
      const keys = Object.keys(next);
      for (const key of keys) {
        actions.set(key, next[key]);
        notify(key, next[key]);
      }
      return () => {
        for (const key of keys) {
          if (actions.get(key) === next[key]) actions.delete(key);
        }
      };
    },
    unregister(names) {
      names.forEach((name) => actions.delete(name));
    },
    get: (name) => actions.get(name),
    has: (name) => actions.has(name),
    names: () => Array.from(actions.keys()).sort(),
    waitFor(name, timeoutMs = 4000) {
      const existing = actions.get(name);
      if (existing) return Promise.resolve(existing);
      return new Promise<UiAction>((resolve, reject) => {
        const timer = setTimeout(() => {
          const list = waiters.get(name) || [];
          waiters.set(name, list.filter((item) => item !== onReady));
          reject(new Error(`The view providing "${name}" did not open in time`));
        }, timeoutMs);
        const onReady = (action: UiAction) => {
          clearTimeout(timer);
          resolve(action);
        };
        waiters.set(name, [...(waiters.get(name) || []), onReady]);
      });
    },
  };
}

export type WorkspaceStore = {
  publish: (partial: Partial<AssistantWorkspace>) => void;
  snapshot: () => AssistantWorkspace;
  subscribe: (listener: (workspace: AssistantWorkspace) => void) => () => void;
};

export function createWorkspaceStore(initial: AssistantWorkspace = {}): WorkspaceStore {
  let current: AssistantWorkspace = { ...initial };
  const listeners = new Set<(workspace: AssistantWorkspace) => void>();
  return {
    publish(partial) {
      let changed = false;
      const next = { ...current };
      for (const [key, value] of Object.entries(partial)) {
        if (value === null || value === undefined) {
          if (key in next) {
            delete next[key];
            changed = true;
          }
        } else if (JSON.stringify(next[key]) !== JSON.stringify(value)) {
          next[key] = value;
          changed = true;
        }
      }
      if (!changed) return;
      current = next;
      listeners.forEach((listener) => listener(current));
    },
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

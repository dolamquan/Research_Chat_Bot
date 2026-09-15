import type { ChatHistoryItem, Message } from "./types";

/**
 * The conversation as the model should see it.
 *
 * The transcript also holds UI chrome — the welcome copy a new session opens
 * with, and client-side failure notices. Sending those as real turns makes the
 * first question of every new chat look like a follow-up: the query rewriter
 * finds "recent conversation" to resolve against and rewrites a perfectly
 * standalone question toward whatever the welcome text happens to mention.
 * Empty turns are dropped for the same reason the backend formatters skip
 * them: they carry nothing and only cost context.
 */
export function toChatHistory(messages: Message[]): ChatHistoryItem[] {
  return messages
    .filter((message) => !message.synthetic && message.content.trim())
    .map(({ role, content }) => ({ role, content }));
}

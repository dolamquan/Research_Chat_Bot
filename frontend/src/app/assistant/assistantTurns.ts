import type { AssistantTurn, ServerMessage } from "./assistantTypes";

/** A batch is one model turn, with every original instruction visible. */
export function startServerTurn(turns: AssistantTurn[], message: Extract<ServerMessage, { type: "turn_start" }>): AssistantTurn[] {
  const ids = new Set(message.message_ids?.length ? message.message_ids : message.message_id ? [message.message_id] : []);
  const matches = ids.size ? turns.filter((turn) => ids.has(turn.id)) : turns.filter((turn) => turn.status === "pending").slice(0, 1);
  if (!matches.length) return turns;
  const first = matches[0];
  const matchedIds = new Set(matches.map((turn) => turn.id));
  return turns.flatMap((turn) => turn.id === first.id ? [{
    ...first, id: message.turn_id, status: "running" as const,
    user: { text: matches.map((item) => item.user.text).join("\n\n"), source: first.user.source },
  }] : matchedIds.has(turn.id) ? [] : [turn]);
}

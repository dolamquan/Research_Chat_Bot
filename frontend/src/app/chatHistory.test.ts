import { describe, expect, it } from "vitest";

import { toChatHistory } from "./chatHistory";
import type { Message } from "./types";

function message(partial: Partial<Message> & Pick<Message, "role" | "content">): Message {
  return { id: partial.content, timestamp: new Date(), ...partial };
}

const WELCOME =
  "Welcome to **Zoetrope**. Explore the paper topology to focus on a research cluster, " +
  "or ask a question across all indexed papers.";

describe("toChatHistory", () => {
  it("sends no history for the first question of a new session", () => {
    const messages = [message({ role: "assistant", content: WELCOME, synthetic: true })];

    expect(toChatHistory(messages)).toEqual([]);
  });

  it("keeps real turns once the conversation has started", () => {
    const messages = [
      message({ role: "assistant", content: WELCOME, synthetic: true }),
      message({ role: "user", content: "what is graph rag?" }),
      message({ role: "assistant", content: "Graph RAG retrieves over a concept graph." }),
    ];

    expect(toChatHistory(messages)).toEqual([
      { role: "user", content: "what is graph rag?" },
      { role: "assistant", content: "Graph RAG retrieves over a concept graph." },
    ]);
  });

  it("drops client-side failure notices", () => {
    const messages = [
      message({ role: "user", content: "what is graph rag?" }),
      message({
        role: "assistant",
        content: "I could not reach the research backend.",
        synthetic: true,
      }),
      message({ role: "user", content: "try again" }),
    ];

    expect(toChatHistory(messages).map((turn) => turn.content)).toEqual([
      "what is graph rag?",
      "try again",
    ]);
  });

  it("drops empty turns", () => {
    expect(toChatHistory([message({ role: "assistant", content: "   " })])).toEqual([]);
  });
});

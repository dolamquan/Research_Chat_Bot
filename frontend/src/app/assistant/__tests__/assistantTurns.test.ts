import { describe, expect, it } from "vitest";
import type { AssistantTurn } from "../assistantTypes";
import { startServerTurn } from "../assistantTurns";

function turn(id: string, text: string, status: AssistantTurn["status"] = "pending"): AssistantTurn {
  return { id, user: { text, source: "voice" }, status, streamingText: "", answer: null, spoken: null, tools: [], sources: [], error: null, createdAt: 1 };
}

describe("server turn grouping", () => {
  it("combines every queued instruction into the correct turn, keeping other work visible", () => {
    const turns = [turn("t1", "open", "done"), turn("m2", "summarize"), turn("m3", "save a note"), turn("m4", "another task")];
    const started = startServerTurn(turns, { type: "turn_start", turn_id: "t2", message_id: "m2", message_ids: ["m2", "m3"] });
    expect(started.map((item) => item.id)).toEqual(["t1", "t2", "m4"]);
    expect(started[1]).toMatchObject({ status: "running", user: { text: "summarize\n\nsave a note" } });
    expect(started[2].status).toBe("pending");
  });
  it("targets a confirmation by id when it jumps ahead of queued work", () => {
    const started = startServerTurn([turn("m1", "save"), turn("confirm", "Yes")], { type: "turn_start", turn_id: "t2", message_id: "confirm" });
    expect(started[0].status).toBe("pending");
    expect(started[1]).toMatchObject({ id: "t2", status: "running", user: { text: "Yes" } });
  });
});

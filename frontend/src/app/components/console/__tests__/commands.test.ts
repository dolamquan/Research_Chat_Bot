import { describe, expect, it } from "vitest";

import { helpText, matchingCommands, parseCommand } from "../commands";

describe("parseCommand", () => {
  it("parses a call with JSON arguments", () => {
    expect(parseCommand('/call app.papers {"query":"graph rag","limit":5}')).toEqual({
      kind: "call",
      name: "app.papers",
      args: { query: "graph rag", limit: 5 },
    });
  });

  it("allows a call with no arguments", () => {
    expect(parseCommand("/call app.context")).toEqual({ kind: "call", name: "app.context", args: {} });
  });

  it("parses mcp calls and tool lookups", () => {
    expect(parseCommand('/mcp-call research.search_library {"query":"x"}')).toEqual({
      kind: "mcp-call",
      name: "research.search_library",
      args: { query: "x" },
    });
    expect(parseCommand("/tool api.notes.create_note extra words")).toEqual({
      kind: "tool",
      name: "api.notes.create_note",
    });
  });

  it("names the problem instead of throwing", () => {
    expect(parseCommand("/call")).toEqual({ kind: "invalid", message: "/call: a tool name is required" });
    expect(parseCommand("/call app.papers {not json}")).toMatchObject({ kind: "invalid" });
    expect(parseCommand("/call app.papers [1,2]")).toEqual({
      kind: "invalid",
      message: "/call: arguments must be a JSON object",
    });
    expect(parseCommand("/tool")).toEqual({ kind: "invalid", message: "/tool needs a tool name" });
  });

  it("is case-insensitive on the verb and recognises help and clear", () => {
    expect(parseCommand("/HELP")).toEqual({ kind: "help" });
    expect(parseCommand("/clear ")).toEqual({ kind: "clear" });
  });

  it("treats anything else as unknown, including plain language", () => {
    expect(parseCommand("/workflow do things")).toEqual({ kind: "unknown", input: "/workflow do things" });
    expect(parseCommand("which papers do I have?")).toEqual({ kind: "unknown", input: "which papers do I have?" });
  });
});

describe("completion and help", () => {
  it("completes only a bare verb prefix", () => {
    expect(matchingCommands("/c").map((c) => c.name)).toEqual(["/call", "/clear"]);
    expect(matchingCommands("/call app")).toEqual([]);
    expect(matchingCommands("hello")).toEqual([]);
  });

  it("points plain-language requests at Zoe", () => {
    expect(helpText()).toContain("/call");
    expect(helpText()).toContain("ask Zoe");
  });
});

import { describe, expect, it } from "vitest";

import { chunkForSpeech, firstSentences, stripMarkdownForSpeech } from "../speechText";

describe("stripMarkdownForSpeech", () => {
  it("removes fences, math, tables, links, headings, bullets and citations", () => {
    const markdown = [
      "# Results",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "",
      "- **Graph RAG** links [concepts](http://x) across papers [1] p.3.",
      "- It uses $E=mc^2$ sometimes.",
    ].join("\n");
    expect(stripMarkdownForSpeech(markdown)).toBe("Graph RAG links concepts across papers. It uses sometimes.");
  });
});

describe("firstSentences", () => {
  it("keeps at most two sentences within the character budget", () => {
    expect(firstSentences("One. Two! Three?")).toBe("One. Two!");
    expect(firstSentences("A".repeat(400), { maxChars: 50 })).toHaveLength(50);
    expect(firstSentences("")).toBe("");
  });
});

describe("chunkForSpeech", () => {
  it("splits on sentences and never exceeds the maximum", () => {
    const text = "First sentence here. Second one, with a clause, and another clause. Third.";
    const chunks = chunkForSpeech(text, 40);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });

  it("hard-splits a single overlong clause", () => {
    const chunks = chunkForSpeech("x".repeat(100), 30);
    expect(chunks).toHaveLength(4);
    expect(chunkForSpeech("   ")).toEqual([]);
  });
});

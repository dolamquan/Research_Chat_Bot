import { describe, expect, it } from "vitest";

import { isEchoOf, matchConfirmation, matchWakeWord, stripWakeWord } from "../wakeWord";

describe("matchWakeWord", () => {
  it("matches the canonical phrase and returns the command that follows", () => {
    const match = matchWakeWord("Hey Zoetrope, open the library");
    expect(match.matched).toBe(true);
    expect(match.remainder).toBe("open the library");
    expect(match.confidence).toBeGreaterThan(0.9);
  });

  it("matches the name alone and common recogniser spellings", () => {
    for (const phrase of ["zoetrope", "hey zoe trope", "hey zootrope", "okay zeotrope", "hi zoetrophy", "hey zoetrobe show notes"]) {
      expect(matchWakeWord(phrase).matched, phrase).toBe(true);
    }
    expect(matchWakeWord("hey zoetrobe show notes").remainder).toBe("show notes");
  });

  it("accepts the short name Zoe and its spellings", () => {
    expect(matchWakeWord("Hey Zoe, open the library")).toMatchObject({ matched: true, remainder: "open the library" });
    expect(matchWakeWord("hey zoey what's on my screen").remainder).toBe("what's on my screen");
    expect(matchWakeWord("okay zo show notes").remainder).toBe("show notes");
    expect(matchWakeWord("zoe").matched).toBe(true);
    expect(matchWakeWord("hey zoe trope open the library").remainder).toBe("open the library");
    expect(matchWakeWord("the zoo is closed").matched).toBe(false);
  });

  it("does not fire on unrelated words or a name mentioned mid-sentence", () => {
    expect(matchWakeWord("the zoo is open").matched).toBe(false);
    expect(matchWakeWord("open the zoetrope paper please").matched).toBe(false);
    expect(matchWakeWord("").matched).toBe(false);
    expect(matchWakeWord("what a lovely trope").matched).toBe(false);
  });

  it("strips a leading wake word from a command", () => {
    expect(stripWakeWord("Hey Zoetrope what's on my screen?")).toBe("what's on my screen");
    expect(stripWakeWord("open the library")).toBe("open the library");
  });
});

describe("matchConfirmation", () => {
  it("recognises short yes/no answers only", () => {
    expect(matchConfirmation("yes")).toBe("yes");
    expect(matchConfirmation("Yes, go ahead.")).toBe("yes");
    expect(matchConfirmation("go for it")).toBe("yes");
    expect(matchConfirmation("no thanks")).toBe("no");
    expect(matchConfirmation("never mind")).toBe("no");
    expect(matchConfirmation("nope")).toBe("no");
    expect(matchConfirmation("yes but first search for graph papers")).toBeNull();
    expect(matchConfirmation("open the library")).toBeNull();
    expect(matchConfirmation("")).toBeNull();
  });
});

describe("isEchoOf", () => {
  it("treats the assistant's own sentence coming back through the mic as an echo", () => {
    expect(isEchoOf("I opened Graph RAG for Science at page four", "I opened Graph RAG for Science at page four.")).toBe(true);
    expect(isEchoOf("hey zoetrope stop", "I opened Graph RAG for Science at page four.")).toBe(false);
    expect(isEchoOf("ok", "okay then")).toBe(false);
  });
});

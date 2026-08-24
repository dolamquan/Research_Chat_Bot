import { describe, expect, it } from "vitest";

import { isKnownPrimitive, primitiveRegistry, resolvePrimitive } from "../SceneCompiler";
import NoteScene from "../primitives/NoteScene";
import TokenStreamScene from "../primitives/TokenStreamScene";
import { SUPPORTED_PRIMITIVES } from "../sceneTypes";

describe("primitive registry", () => {
  it("covers every primitive in the whitelist", () => {
    // If this fails, a primitive was added to the IR without a renderer, and
    // real scenes would silently degrade to the note fallback.
    for (const primitive of SUPPORTED_PRIMITIVES) {
      expect(isKnownPrimitive(primitive), `missing renderer for ${primitive}`).toBe(true);
    }
  });

  it("registers no renderer outside the whitelist", () => {
    const allowed = new Set<string>(SUPPORTED_PRIMITIVES);
    for (const key of Object.keys(primitiveRegistry)) {
      expect(allowed.has(key), `unexpected registry key ${key}`).toBe(true);
    }
  });

  it("maps a known primitive to its own component", () => {
    expect(resolvePrimitive("token_stream")).toBe(TokenStreamScene);
  });

  it("falls back to NoteScene for an unknown primitive", () => {
    expect(resolvePrimitive("summon_gpu_daemon")).toBe(NoteScene);
    expect(resolvePrimitive("")).toBe(NoteScene);
  });

  it("does not resolve inherited object properties", () => {
    // A model-supplied string must not reach Object.prototype members.
    expect(resolvePrimitive("toString")).toBe(NoteScene);
    expect(resolvePrimitive("constructor")).toBe(NoteScene);
    expect(resolvePrimitive("__proto__")).toBe(NoteScene);
  });

  it("only ever uses the string as a lookup key", () => {
    // The registry is a plain object of components; nothing is callable from a
    // string, so there is no path from model output to execution.
    for (const value of Object.values(primitiveRegistry)) {
      expect(typeof value).toBe("function");
    }
  });
});

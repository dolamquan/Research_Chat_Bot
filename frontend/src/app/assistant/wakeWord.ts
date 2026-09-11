/**
 * Recognising "Hey Zoetrope" in noisy transcripts, and a few other pure
 * text judgements the voice machine needs.
 */

const TARGET = "zoetrope";
// The short name is what people actually say; recognisers spell it a few ways.
const SHORT_NAMES: Record<string, number> = { zoe: 0, zoey: 0, zoie: 0, zoi: 1, zo: 1, joey: 1 };
const LEADERS = new Set(["hey", "hi", "ok", "okay", "yo", "hello", "a", "the"]);
const MAX_START_TOKEN = 3;

export type WakeWordMatch = {
  matched: boolean;
  confidence: number;
  remainder: string;
  matchedText?: string;
};

export function normalizeTranscript(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** "zoe", "zoey", "zoe trope", "zootrope", "zeotrope", "zoetrophy" all count; "zoo" does not. */
function looksLikeTarget(fused: string): number | null {
  if (fused in SHORT_NAMES) return SHORT_NAMES[fused];
  if (fused.length < 6 || fused.length > 11) return null;
  const distance = levenshtein(fused, TARGET);
  if (distance <= 2) return distance;
  // Common recogniser splits: "zoe trope" -> "zoetrope" handled by fusion; "so a trope" -> "soatrope".
  if (fused.endsWith("trope") && distance <= 3) return distance;
  return null;
}

export function matchWakeWord(transcript: string): WakeWordMatch {
  const tokens = normalizeTranscript(transcript).split(" ").filter(Boolean);
  if (!tokens.length) return { matched: false, confidence: 0, remainder: "" };
  const lastStart = Math.min(MAX_START_TOKEN, tokens.length - 1);
  let best: { start: number; length: number; distance: number } | null = null;
  for (let start = 0; start <= lastStart; start += 1) {
    for (const length of [1, 2, 3]) {
      if (start + length > tokens.length) break;
      const fused = tokens.slice(start, start + length).join("");
      const distance = looksLikeTarget(fused);
      if (distance === null) continue;
      // Ties go to the longer match so "zoe trope" is one name, not "zoe" + "trope ...".
      if (
        !best ||
        distance < best.distance ||
        (distance === best.distance && (length > best.length || (length === best.length && start < best.start)))
      ) {
        best = { start, length, distance };
      }
    }
  }
  if (!best) return { matched: false, confidence: 0, remainder: "" };
  // Everything before the name must be a greeting-ish filler, otherwise the
  // name is being mentioned mid-sentence ("open the zoetrope paper").
  const prefix = tokens.slice(0, best.start);
  if (prefix.some((token) => !LEADERS.has(token))) {
    return { matched: false, confidence: 0, remainder: "" };
  }
  const remainder = tokens.slice(best.start + best.length).join(" ");
  const confidence = Math.max(0.2, 1 - best.distance / 4);
  return { matched: true, confidence, remainder, matchedText: tokens.slice(best.start, best.start + best.length).join(" ") };
}

/** Strip a leading wake word from a command; unchanged when there is none. */
export function stripWakeWord(transcript: string): string {
  const match = matchWakeWord(transcript);
  return match.matched ? match.remainder : normalizeTranscript(transcript);
}

const AFFIRMATIVE = new Set([
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed", "affirmative", "correct", "right",
  "absolutely", "do it", "go ahead", "go for it", "proceed", "please do", "yes please", "yes do it",
]);
const NEGATIVE = new Set([
  "no", "nope", "nah", "cancel", "stop", "don't", "dont", "do not", "never mind", "nevermind", "abort", "negative",
  "no thanks", "no thank you", "skip", "leave it", "forget it",
]);
const NEW_INSTRUCTION = new Set(["but", "first", "instead", "after", "before", "then"]);

export function matchConfirmation(text: string): "yes" | "no" | null {
  const normalized = normalizeTranscript(text);
  if (!normalized) return null;
  const words = normalized.split(" ");
  if (words.length > 6) return null;
  if (NEGATIVE.has(normalized)) return "no";
  if (AFFIRMATIVE.has(normalized)) return "yes";
  const lead = words.slice(0, 2).join(" ");
  if (["no", "nope", "nah", "cancel", "stop", "abort"].includes(words[0]) || ["never mind", "do not", "don't do"].includes(lead)) {
    return "no";
  }
  if (
    ["yes", "yeah", "yep", "yup", "sure", "okay", "ok", "confirm", "proceed", "affirmative"].includes(words[0]) ||
    ["go ahead", "do it", "please do"].includes(lead)
  ) {
    return words.some((word) => NEW_INSTRUCTION.has(word)) ? null : "yes";
  }
  return null;
}

/** True when most of what the microphone heard is what the speaker is saying. */
export function isEchoOf(transcript: string, spokenText: string): boolean {
  const heard = normalizeTranscript(transcript).split(" ").filter((t) => t.length > 2);
  if (heard.length < 2) return false;
  const spoken = new Set(normalizeTranscript(spokenText).split(" ").filter(Boolean));
  if (!spoken.size) return false;
  const overlap = heard.filter((token) => spoken.has(token)).length;
  return overlap / heard.length >= 0.7;
}

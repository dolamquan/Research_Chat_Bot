/** Turning Markdown into something speechSynthesis can say well. */

export function stripMarkdownForSpeech(markdown: string): string {
  let text = markdown || "";
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/\$\$[\s\S]*?\$\$/g, " ");
  text = text.replace(/\$[^$\n]+\$/g, " ");
  text = text.replace(/^\s*\|.*\|\s*$/gm, " ");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/^\s{0,3}#{1,6}\s.*$/gm, " ");
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "");
  text = text.replace(/\[\d+(?:,\s*\d+)*\](?:\s*p\.\s*\d+)?/g, "");
  text = text.replace(/(\*\*|__|\*|_|`|~~)/g, "");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\s*\n\s*/g, " ");
  text = text.replace(/\s+([.,;:!?])/g, "$1");
  return text.trim();
}

export function firstSentences(
  text: string,
  { maxSentences = 2, maxChars = 350 }: { maxSentences?: number; maxChars?: number } = {},
): string {
  const clean = (text || "").trim();
  if (!clean) return "";
  const parts = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  let out = "";
  for (const part of parts.slice(0, maxSentences)) {
    const candidate = `${out} ${part}`.trim();
    if (out && candidate.length > maxChars) break;
    out = candidate;
  }
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars - 1);
    out = `${(cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[,;:\-\s]+$/, "")}…`;
  }
  return out;
}

/**
 * Chrome stalls on utterances longer than roughly fifteen seconds. Splitting
 * on sentences, then commas, then hard breaks keeps every chunk short.
 */
export function chunkForSpeech(text: string, maxChars = 180): string[] {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      push();
      let piece = "";
      for (const clause of sentence.split(/(?<=,)\s+/)) {
        if (clause.length > maxChars) {
          if (piece) chunks.push(piece.trim());
          piece = "";
          for (let i = 0; i < clause.length; i += maxChars) chunks.push(clause.slice(i, i + maxChars).trim());
          continue;
        }
        if ((piece + " " + clause).trim().length > maxChars) {
          chunks.push(piece.trim());
          piece = clause;
        } else {
          piece = `${piece} ${clause}`.trim();
        }
      }
      if (piece.trim()) chunks.push(piece.trim());
      continue;
    }
    if ((current + " " + sentence).trim().length > maxChars) {
      push();
    }
    current = `${current} ${sentence}`.trim();
  }
  push();
  return chunks.filter(Boolean);
}

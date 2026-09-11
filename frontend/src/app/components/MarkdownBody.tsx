import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

const KATEX_OPTIONS = { throwOnError: false, strict: false };

/** Repairs mojibake that PDF extraction leaves in formulas (e.g. "â†’" for "→"). */
export function repairMathText(content: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/â†|â/g, "←"],
    [/â†’|â/g, "→"],
    [/âˆˆ|â/g, "∈"],
    [/âˆ‰|â/g, "∉"],
    [/â‰¤|â¤/g, "≤"],
    [/â‰¥|â¥/g, "≥"],
    [/â‰ˆ|â/g, "≈"],
    [/â‰ |â /g, "≠"],
    [/âˆ’|â/g, "−"],
    [/âˆ‘|â/g, "∑"],
    [/âˆ|â/g, "∏"],
    [/âˆž|â/g, "∞"],
    [/âˆ¥|â¥/g, "∥"],
    [/âˆ—|â/g, "∗"],
    [/Î±/g, "α"],
    [/Î²/g, "β"],
    [/Î³/g, "γ"],
    [/Î´/g, "δ"],
    [/Îµ/g, "ε"],
    [/Î»/g, "λ"],
    [/Î¼/g, "μ"],
    [/Ïƒ/g, "σ"],
    [/Ï„/g, "τ"],
    [/Ï†/g, "φ"],
  ];

  return replacements.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    content,
  );
}

function latexEscape(text: string): string {
  return text
    .replace(/\\/g, "\\backslash ")
    .replace(/([{}&#%])/g, "\\$1")
    .replace(/_/g, "\\_")
    .replace(/\^/g, "\\^{}");
}

function mathTextToLatex(text: string): string {
  return repairMathText(text)
    .split("\n")
    .map((line) => latexEscape(line.trim()))
    .filter(Boolean)
    .join(" \\\\ ");
}

function hasPdfFormulaExtractionArtifact(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 12) return false;

  const tinyLines = lines.filter((line) => line.length <= 2).length;
  return tinyLines / lines.length > 0.5;
}

function shouldRenderTextBlockAsMath(text: string): boolean {
  if (!text || text.length > 500 || hasPdfFormulaExtractionArtifact(text)) return false;

  const mathSignalCount =
    text.match(/[=←→∈∉≤≥≈≠∑∏∞∥∗α-ωΑ-Ω]|\\frac|\\sum|\\prod|\\min|\\max|\\operatorname/g)?.length ??
    0;
  const proseWordCount =
    text.match(/\b(the|this|that|context|figure|table|paper|formula|component|retrieval|graph)\b/gi)
      ?.length ?? 0;

  if (mathSignalCount === 0 && !/\b(arg|max|min|top-k|k\s*=|d\s*=)\b/i.test(text)) {
    return false;
  }

  return proseWordCount <= 8 || mathSignalCount >= 4;
}

export function normalizeMathMarkdown(content: string): string {
  const repaired = repairMathText(content);

  return repaired.replace(
    /```text\n([\s\S]*?)```/g,
    (_match, body: string) => {
      const cleaned = body.trim();

      if (!shouldRenderTextBlockAsMath(cleaned)) {
        return `\`\`\`text\n${cleaned}\n\`\`\``;
      }

      return `$$\n\\begin{aligned}\n${mathTextToLatex(cleaned)}\n\\end{aligned}\n$$`;
    },
  );
}

/**
 * The app's one Markdown renderer (math-aware), used by the chat bubbles and
 * the assistant panel so answers look the same everywhere.
 */
export function MarkdownBody({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
      components={{
        p: ({ children }) => <p className="mb-2 leading-relaxed last:mb-0">{children}</p>,
        strong: ({ children }) => (
          <strong className="font-semibold text-foreground">{children}</strong>
        ),
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        code: ({ className, children }) => {
          const block = typeof className === "string" && className.startsWith("language-");
          return block ? (
            <code className="block overflow-x-auto whitespace-pre rounded border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
              {children}
            </code>
          ) : (
            <code className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[0.85em]">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <pre className="mb-2 overflow-x-auto">{children}</pre>,
      }}
    >
      {normalizeMathMarkdown(content)}
    </ReactMarkdown>
  );
}

export const FormattedText = MarkdownBody;

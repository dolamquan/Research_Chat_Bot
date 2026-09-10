import { Fragment, useMemo, type ReactNode } from "react";
import katex from "katex";
import { parseNote } from "./noteFormat";
import "./notes.css";

export function FormulaPreview({latex, block = false}: {latex: string; block?: boolean}) {
  const result = useMemo(() => {
    try {
      return {html: katex.renderToString(latex, {displayMode: block, throwOnError: true, trust: false, maxExpand: 1000}), error: ""};
    } catch (error) { return {html: "", error: error instanceof Error ? error.message : "Invalid formula"}; }
  }, [latex, block]);
  if (result.error) return <span className="note-formula-error" title={result.error}>{latex || "Enter a formula"}</span>;
  return <span className={block ? "note-equation-block" : "note-equation-inline"} aria-label={`Formula: ${latex}`} dangerouslySetInnerHTML={{__html: result.html}} />;
}

type NoteNode = {type?: string; text?: string; attrs?: Record<string, any>; content?: NoteNode[]; marks?: NoteNode[]};
function renderNode(node: NoteNode, key: number): ReactNode {
  const children = node.content?.map(renderNode);
  let result: ReactNode;
  switch (node.type) {
    case "doc": result = children; break;
    case "paragraph": result = <p>{children || <br />}</p>; break;
    case "heading": result = node.attrs?.level === 1 ? <h1>{children}</h1> : node.attrs?.level === 2 ? <h2>{children}</h2> : <h3>{children}</h3>; break;
    case "bulletList": result = <ul>{children}</ul>; break;
    case "orderedList": result = <ol start={node.attrs?.start || 1}>{children}</ol>; break;
    case "listItem": result = <li>{children}</li>; break;
    case "blockquote": result = <blockquote>{children}</blockquote>; break;
    case "codeBlock": result = <pre><code>{children}</code></pre>; break;
    case "hardBreak": result = <br />; break;
    case "horizontalRule": result = <hr />; break;
    case "inlineMath": case "blockMath": result = <FormulaPreview latex={node.attrs?.latex || ""} block={node.type === "blockMath"} />; break;
    default: result = node.text || children;
  }
  for (const mark of node.marks || []) {
    switch (mark.type) {
      case "bold": result = <strong>{result}</strong>; break;
      case "italic": result = <em>{result}</em>; break;
      case "underline": result = <u>{result}</u>; break;
      case "strike": result = <s>{result}</s>; break;
      case "highlight": result = <mark>{result}</mark>; break;
      case "code": result = <code>{result}</code>; break;
      case "link": {
        const href = String(mark.attrs?.href || "");
        if (/^(https?:\/\/|mailto:)/i.test(href)) result = <a href={href} target="_blank" rel="noreferrer">{result}</a>;
        break;
      }
    }
  }
  return <Fragment key={key}>{result}</Fragment>;
}

export function NotePreview({value, className = ""}: {value: string; className?: string}) {
  const content = useMemo(() => {
    try { return renderNode(parseNote(value), 0); }
    catch { return <p className="whitespace-pre-wrap">{value}</p>; }
  }, [value]);
  return <div className={`note-document ${className}`}>{content}</div>;
}

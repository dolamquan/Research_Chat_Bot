import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Markdown } from "@tiptap/markdown";
import katex from "katex";
import { Bold, Italic, Underline, Highlighter, List, ListOrdered, Quote, Undo2, Redo2, Sigma, Link2, Code2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { noteExtensions } from "./noteFormat";
import { FormulaPreview, NotePreview } from "./NotePreview";
import "./notes.css";

type Formula = {latex: string; block: boolean; from: number; to: number};
export function NoteEditor({value, onChange, onSave, label = "Note document"}: {
  value: string; onChange: (value: string) => void; onSave?: () => void; label?: string;
}) {
  const [source, setSource] = useState(false);
  const sourceId = useId();
  const [formula, setFormula] = useState<Formula | null>(null);
  const [link, setLink] = useState<{url: string; from: number; to: number} | null>(null);
  const latest = useRef(value);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const editor = useEditor({
    extensions: [...noteExtensions((latex, pos, size, block) => setFormula({latex, from: pos, to: pos + size, block})), Markdown],
    content: value,
    contentType: "markdown",
    shouldRerenderOnTransaction: true,
    editorProps: {attributes: {class: "note-document note-editable", role: "textbox", "aria-label": label, "aria-multiline": "true"}},
    onUpdate: ({editor: current}) => {
      const next = current.getMarkdown();
      latest.current = next;
      changeRef.current(next);
    },
  });
  useEffect(() => {
    if (!editor || source || value === latest.current) return;
    editor.commands.setContent(value, {contentType: "markdown", emitUpdate: false});
    latest.current = value;
  }, [editor, value, source]);
  const formulaError = useMemo(() => {
    if (!formula?.latex.trim()) return "Enter a LaTeX expression.";
    if (formula.latex.length > 2000) return "Keep each formula under 2,000 characters.";
    try { katex.renderToString(formula.latex, {throwOnError: true, trust: false, maxExpand: 1000}); return ""; }
    catch (error) { return error instanceof Error ? error.message.replace(/^KaTeX parse error: /, "") : "Check the LaTeX syntax."; }
  }, [formula?.latex]);
  if (!editor) return <div className="p-4 text-sm">Loading editor…</div>;
  const tool = (name: string, Icon: typeof Bold, action: () => void, active = false, disabled = false) => (
    <button type="button" title={name} aria-label={name} aria-pressed={active} disabled={disabled || source}
      onMouseDown={event => event.preventDefault()} onClick={action}><Icon size={15} /></button>
  );
  return <div className="note-editor" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && onSave) {event.preventDefault(); onSave();}
  }}>
    <div className="note-toolbar" role="toolbar" aria-label="Text formatting">
      {tool("Undo", Undo2, () => {editor.chain().focus().undo().run();}, false, !editor.can().undo())}
      {tool("Redo", Redo2, () => {editor.chain().focus().redo().run();}, false, !editor.can().redo())}
      <select aria-label="Paragraph style" disabled={source} value={editor.isActive("heading") ? String(editor.getAttributes("heading").level) : "paragraph"}
        onChange={event => { const level = Number(event.target.value) as 1 | 2 | 3; if (level) editor.chain().focus().setHeading({level}).run(); else editor.chain().focus().setParagraph().run(); }}>
        <option value="paragraph">Normal text</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option>
      </select>
      {tool("Bold (Ctrl+B)", Bold, () => {editor.chain().focus().toggleBold().run();}, editor.isActive("bold"))}
      {tool("Italic (Ctrl+I)", Italic, () => {editor.chain().focus().toggleItalic().run();}, editor.isActive("italic"))}
      {tool("Underline (Ctrl+U)", Underline, () => {editor.chain().focus().toggleUnderline().run();}, editor.isActive("underline"))}
      {tool("Highlight text", Highlighter, () => {editor.chain().focus().toggleHighlight().run();}, editor.isActive("highlight"))}
      {tool("Bullet list", List, () => {editor.chain().focus().toggleBulletList().run();}, editor.isActive("bulletList"))}
      {tool("Numbered list", ListOrdered, () => {editor.chain().focus().toggleOrderedList().run();}, editor.isActive("orderedList"))}
      {tool("Quote", Quote, () => {editor.chain().focus().toggleBlockquote().run();}, editor.isActive("blockquote"))}
      {tool("Link", Link2, () => setLink({url: editor.getAttributes("link").href || "", from: editor.state.selection.from, to: editor.state.selection.to}), editor.isActive("link"))}
      {tool("Insert formula", Sigma, () => setFormula({latex: "", block: false, from: editor.state.selection.from, to: editor.state.selection.to}))}
      <button type="button" className="note-source-toggle" aria-pressed={source} onClick={() => setSource(!source)} title="Edit Markdown and LaTeX source"><Code2 size={14} /> {source ? "Document" : "Source"}</button>
    </div>
    {source ? <div className="note-source-view">
      <div><label htmlFor={sourceId}>Markdown / LaTeX</label><textarea id={sourceId} aria-label="Markdown and LaTeX source" value={value} onChange={event => onChange(event.target.value)} spellCheck={false} /></div>
      <div><span className="note-preview-label">Live preview</span><NotePreview value={value} /></div>
    </div> : <EditorContent editor={editor} className="note-editor-scroll" />}
    <div className="note-editor-hint">{source ? "Inline: $x^2$ · Equation: $$ … $$ · Highlight: ==text==" : "Select text to format it. Use Σ for a formula; click any formula to edit."}</div>
    <Dialog open={formula !== null} onOpenChange={open => {if (!open) setFormula(null);}}>
      <DialogContent className="sm:max-w-2xl" onCloseAutoFocus={event => {event.preventDefault(); if (!editor.isDestroyed && editor.isInitialized) editor.commands.focus();}}>
        <DialogTitle>LaTeX formula</DialogTitle>
        <DialogDescription>Write an expression and preview it as you type.</DialogDescription>
        <div className="flex flex-wrap gap-2">
          {[["Fraction", "\\frac{a}{b}"], ["Sum", "\\sum_{i=1}^{n} x_i"], ["Matrix", "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}"], ["Integral", "\\int_0^1 x^2\\,dx"]].map(([name, latex]) =>
            <button type="button" className="rounded border px-3 py-1 text-xs" key={name} onClick={() => setFormula(current => current && {...current, latex})}>{name}</button>)}
        </div>
        <label className="text-sm" htmlFor={`${sourceId}-formula`}>LaTeX source</label>
        <textarea id={`${sourceId}-formula`} autoFocus className="w-full rounded border bg-background p-3 font-mono text-sm" rows={4} value={formula?.latex || ""} onChange={event => setFormula(current => current && {...current, latex: event.target.value})} spellCheck={false} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={formula?.block || false} onChange={event => setFormula(current => current && {...current, block: event.target.checked})} /> Display on its own line</label>
        <div className="min-h-20 overflow-x-auto rounded border bg-secondary/30 p-4" aria-label="Formula preview"><FormulaPreview latex={formula?.latex || ""} block={formula?.block} /></div>
        {formulaError && formula?.latex && <p role="alert" className="text-sm text-destructive">{formulaError}</p>}
        <p className="text-xs text-muted-foreground">Supports LaTeX math expressions, including fractions, matrices, sums, and aligned equations.</p>
        <button type="button" className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40" disabled={!!formulaError} onClick={() => {
          if (!formula) return;
          editor.chain().focus().insertContentAt({from: formula.from, to: formula.to}, {type: formula.block ? "blockMath" : "inlineMath", attrs: {latex: formula.latex.trim()}}).run();
          setFormula(null);
        }}>Apply formula</button>
      </DialogContent>
    </Dialog>
    <Dialog open={link !== null} onOpenChange={open => {if (!open) setLink(null);}}>
      <DialogContent><DialogTitle>Link</DialogTitle><DialogDescription>Enter a web address. Leave it empty to remove the link.</DialogDescription>
        <input aria-label="Link URL" type="url" className="rounded border bg-background p-2" value={link?.url || ""} onChange={event => setLink(current => current && {...current, url: event.target.value})} />
        <button type="button" disabled={!!link?.url && !/^(https?:\/\/|mailto:)/i.test(link.url)} onClick={() => {
          if (!link) return;
          const chain = editor.chain().focus().setTextSelection({from: link.from, to: link.to}).extendMarkRange("link");
          if (link.url) chain.setLink({href: link.url}).run(); else chain.unsetLink().run();
          setLink(null);
        }}>Apply link</button>
      </DialogContent>
    </Dialog>
  </div>;
}

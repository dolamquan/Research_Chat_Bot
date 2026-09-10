import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import Mathematics from "@tiptap/extension-mathematics";
import { MarkdownManager } from "@tiptap/markdown";

export function noteExtensions(onMath?: (latex: string, pos: number, size: number, block: boolean) => void) {
  return [
    StarterKit.configure({link: {openOnClick: false}, heading: {levels: [1, 2, 3]}}),
    Highlight,
    Mathematics.configure({
      katexOptions: {throwOnError: false, trust: false, maxExpand: 1000},
      inlineOptions: {onClick: (node, pos) => onMath?.(node.attrs.latex, pos, node.nodeSize, false)},
      blockOptions: {onClick: (node, pos) => onMath?.(node.attrs.latex, pos, node.nodeSize, true)},
    }),
  ];
}

// Preview uses the same grammar as the editor, without mounting an editor per card.
const markdown = new MarkdownManager({extensions: noteExtensions()});
export const parseNote = (value: string) => markdown.parse(value);

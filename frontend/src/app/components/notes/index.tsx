import { lazy, Suspense, type ComponentProps } from "react";

const Editor = lazy(() => import("./NoteEditor").then(module => ({default: module.NoteEditor})));
const Preview = lazy(() => import("./NotePreview").then(module => ({default: module.NotePreview})));

export function NoteEditor(props: ComponentProps<typeof Editor>) {
  return <Suspense fallback={<div className="flex-1 p-4 text-sm text-muted-foreground">Loading editor…</div>}><Editor {...props} /></Suspense>;
}
export function NotePreview(props: ComponentProps<typeof Preview>) {
  return <Suspense fallback={<p className="whitespace-pre-wrap text-sm">{props.value}</p>}><Preview {...props} /></Suspense>;
}

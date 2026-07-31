import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileText,
  NotebookPen,
  MessageSquarePlus,
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

import {
  createAnnotation,
  deleteAnnotation,
  extractDocumentVisuals,
  getAnnotations,
  getPdfUrl,
  getVisualAssets,
  getVisualImageUrl,
} from "../api";
import type { Annotation, ClusterDocument, Source, VisualAsset } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

type TextNodeSlice = {
  node: Text;
  offset: number;
};

type HighlightRect = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

function normalizeForMatch(value: string): string {
  return value.replace(/[\s\u00ad-]+/g, "").trim().toLowerCase();
}

function shouldIndexTextChar(char: string): boolean {
  return !/[\s\u00ad-]/.test(char);
}

function collectIndexedTextNodes(textLayer: Element): { normalized: string; slices: TextNodeSlice[] } {
  let normalized = "";
  const slices: TextNodeSlice[] = [];
  const walker = window.document.createTreeWalker(
    textLayer,
    window.NodeFilter.SHOW_TEXT,
  );
  let currentNode = walker.nextNode();

  while (currentNode) {
    const node = currentNode as Text;
    const text = node.textContent || "";

    for (let offset = 0; offset < text.length; offset += 1) {
      const char = text[offset];
      if (!shouldIndexTextChar(char)) continue;

      normalized += char.toLowerCase();
      slices.push({ node, offset });
    }

    currentNode = walker.nextNode();
  }

  return { normalized, slices };
}

function createDomRangeFromMatch(
  slices: TextNodeSlice[],
  startIndex: number,
  length: number,
): Range | null {
  const startSlice = slices[startIndex];
  const endSlice = slices[startIndex + length - 1];
  if (!startSlice || !endSlice) return null;

  const range = window.document.createRange();
  range.setStart(startSlice.node, startSlice.offset);
  range.setEnd(endSlice.node, endSlice.offset + 1);
  return range;
}

export function DocumentReader({
  document,
  initialPage,
  onClose,
  onPinSelection,
}: {
  document: ClusterDocument;
  initialPage?: number;
  onClose: () => void;
  onPinSelection: (source: Source) => void;
}) {
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.05);
  const [selectedText, setSelectedText] = useState("");
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteEditorOpen, setNoteEditorOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [visuals, setVisuals] = useState<VisualAsset[]>([]);
  const [annotationStatus, setAnnotationStatus] = useState("");
  const [visualStatus, setVisualStatus] = useState("");
  const [isSavingAnnotation, setIsSavingAnnotation] = useState(false);
  const [isExtractingVisuals, setIsExtractingVisuals] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [detailsHeight, setDetailsHeight] = useState(360);
  const [loadError, setLoadError] = useState("");
  const [pageWidth, setPageWidth] = useState(520);
  const [savedHighlightRects, setSavedHighlightRects] = useState<HighlightRect[]>([]);
  const readerRef = useRef<HTMLElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const pageShellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = pageContainerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setPageWidth(Math.max(300, entry.contentRect.width - 32));
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    let active = true;

    getAnnotations(document.source)
      .then((result) => {
        if (active) setAnnotations(result.annotations);
      })
      .catch(() => {
        if (active) setAnnotations([]);
      });

    getVisualAssets(document.source)
      .then((result) => {
        if (active) setVisuals(result.visuals);
      })
      .catch(() => {
        if (active) setVisuals([]);
      });

    setSelectedText("");
    setSelectionToolbar(null);
    setNoteText("");
    setNoteEditorOpen(false);
    setAnnotationStatus("");
    setVisualStatus("");

    return () => {
      active = false;
    };
  }, [document.source]);

  useEffect(() => {
    if (!initialPage) return;
    setPageNumber(Math.max(1, initialPage));
  }, [document.source, initialPage]);

  useEffect(() => {
    const pageAnnotations = annotations.filter(
      (annotation) => annotation.page === pageNumber && annotation.selected_text.trim().length > 0,
    );

    setSavedHighlightRects([]);
    if (pageAnnotations.length === 0) return undefined;

    const timeoutId = window.setTimeout(() => {
      const textLayer = pageShellRef.current?.querySelector(
        ".react-pdf__Page__textContent, .textLayer",
      );
      const pageRect = pageShellRef.current?.getBoundingClientRect();
      if (!textLayer || !pageRect) return;

      const indexedPageText = collectIndexedTextNodes(textLayer);

      const rects = pageAnnotations.flatMap((annotation) => {
        const needle = normalizeForMatch(annotation.selected_text);
        if (!needle) return [];

        const matchIndex = indexedPageText.normalized.indexOf(needle);
        if (matchIndex < 0) return [];

        const range = createDomRangeFromMatch(indexedPageText.slices, matchIndex, needle.length);
        if (!range) return [];

        return Array.from(range.getClientRects())
          .filter((rect) => rect.width > 1 && rect.height > 1)
          .map((rect, index) => ({
            id: `${annotation.annotation_id}:${index}`,
            left: rect.left - pageRect.left,
            top: rect.top - pageRect.top,
            width: rect.width,
            height: rect.height,
          }));
      });

      setSavedHighlightRects(rects);
    }, 150);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [annotations, document.source, pageNumber, pageWidth, scale]);

  function captureSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";

    if (!selection || text.length < 3 || selection.rangeCount === 0) {
      setSelectionToolbar(null);
      return;
    }

    const selectionRect = selection.getRangeAt(0).getBoundingClientRect();
    const readerRect = readerRef.current?.getBoundingClientRect();

    if (!readerRect || selectionRect.width === 0 || selectionRect.height === 0) {
      setSelectionToolbar(null);
      return;
    }

    setSelectedText(text);
    setNoteEditorOpen(false);
    setSelectionToolbar({
      x: Math.min(
        readerRect.width - 320,
        Math.max(16, selectionRect.left - readerRect.left + selectionRect.width / 2 - 80),
      ),
      y: Math.max(62, selectionRect.top - readerRect.top - 46),
    });
  }

  function addSelection() {
    if (!selectedText) return;

    onPinSelection({
      id: `selection:${document.source}:${pageNumber}:${Date.now()}`,
      source: document.source,
      page: pageNumber,
      text: selectedText,
      selection: true,
      cluster_id: document.cluster_id,
      cluster_label: document.cluster_label,
    });
    setSelectedText("");
    setSelectionToolbar(null);
    setNoteText("");
    setNoteEditorOpen(false);
    window.getSelection()?.removeAllRanges();
  }

  async function saveAnnotation() {
    if (!selectedText || isSavingAnnotation) return;

    setIsSavingAnnotation(true);
    setAnnotationStatus("Saving note...");

    try {
      const result = await createAnnotation({
        source: document.source,
        article_id: document.article_id,
        title: document.title,
        page: pageNumber,
        selected_text: selectedText,
        note: noteText,
      });
      setAnnotations((current) => [result.annotation, ...current]);
      setSelectedText("");
      setSelectionToolbar(null);
      setNoteText("");
      setNoteEditorOpen(false);
      setAnnotationStatus("Saved annotation.");
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      setAnnotationStatus(
        error instanceof Error ? `Could not save note: ${error.message}` : "Could not save note.",
      );
    } finally {
      setIsSavingAnnotation(false);
    }
  }

  async function removeAnnotation(annotationId: string) {
    setAnnotations((current) =>
      current.filter((annotation) => annotation.annotation_id !== annotationId),
    );

    try {
      await deleteAnnotation(annotationId);
    } catch {
      const result = await getAnnotations(document.source);
      setAnnotations(result.annotations);
    }
  }

  function addAnnotationToChat(annotation: Annotation) {
    onPinSelection({
      id: `annotation:${annotation.annotation_id}`,
      source: annotation.source,
      page: annotation.page,
      text: annotation.note
        ? `${annotation.selected_text}\n\nNote: ${annotation.note}`
        : annotation.selected_text,
      selection: true,
      annotation_id: annotation.annotation_id,
      title: annotation.title || document.title,
      article_id: annotation.article_id || document.article_id,
      cluster_id: document.cluster_id,
      cluster_label: document.cluster_label,
    });
  }

  async function extractVisuals() {
    if (isExtractingVisuals) return;

    setIsExtractingVisuals(true);
    setVisualStatus("Extracting figures and graphs...");

    try {
      const result = await extractDocumentVisuals(document.source);
      setVisuals(result.visuals);
      setVisualStatus(
        result.visuals.length
          ? `Extracted ${result.visuals.length} visual asset${result.visuals.length === 1 ? "" : "s"}.`
          : "No embedded images were found in this PDF.",
      );
    } catch (error) {
      setVisualStatus(
        error instanceof Error
          ? `Could not extract visuals: ${error.message}`
          : "Could not extract visuals.",
      );
    } finally {
      setIsExtractingVisuals(false);
    }
  }

  function addVisualToChat(visual: VisualAsset) {
    onPinSelection({
      id: `visual:${visual.asset_id}`,
      source: visual.source,
      page: visual.page || undefined,
      text: visual.caption,
      selection: true,
      asset_id: visual.asset_id,
      image_url: visual.image_url,
      title: visual.title || document.title,
      article_id: visual.article_id || document.article_id,
      document_type: "visual_asset",
      section_type: "figure",
      cluster_id: document.cluster_id,
      cluster_label: document.cluster_label,
    });
  }

  function clampDetailsHeight(value: number): number {
    const readerHeight =
      readerRef.current?.getBoundingClientRect().height || window.innerHeight;
    const maxHeight = Math.max(220, readerHeight - 170);
    return Math.min(maxHeight, Math.max(120, value));
  }

  function startDetailsResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startY = event.clientY;
    const startHeight = detailsHeight;

    const resize = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const nextHeight = startHeight + startY - moveEvent.clientY;
      setDetailsHeight(clampDetailsHeight(nextHeight));
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      window.document.body.style.cursor = "";
      window.document.body.style.userSelect = "";
    };

    window.document.body.style.cursor = "row-resize";
    window.document.body.style.userSelect = "none";
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  return (
    <aside
      ref={readerRef}
      className="relative hidden md:flex h-full w-[46vw] min-w-[420px] max-w-[620px] shrink-0 border-l border-border bg-card flex-col min-h-0"
    >
      {selectionToolbar && selectedText ? (
        <div
          className="absolute z-50 rounded-lg border border-primary/35 bg-card/95 p-1 shadow-2xl backdrop-blur"
          style={{ left: selectionToolbar.x, top: selectionToolbar.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Add selected text to chat"
              onClick={addSelection}
              className="flex h-8 w-8 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <MessageSquarePlus size={15} />
            </button>
            <button
              type="button"
              title="Add a note description"
              disabled={isSavingAnnotation}
              onClick={() => setNoteEditorOpen((value) => !value)}
              className={`flex h-8 w-8 items-center justify-center rounded border border-border text-primary hover:bg-secondary disabled:opacity-50 ${
                noteEditorOpen ? "bg-primary/10" : ""
              }`}
            >
              <NotebookPen size={15} />
            </button>
          </div>
          {noteEditorOpen && (
            <div className="mt-1 w-72 rounded border border-border bg-background p-2">
              <textarea
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                rows={3}
                placeholder="Add your note about this selection..."
                className="block w-full resize-none rounded border border-border bg-card px-2 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
                onMouseDown={(event) => event.stopPropagation()}
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNoteText("");
                    setNoteEditorOpen(false);
                  }}
                  className="h-7 rounded border border-border px-2 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isSavingAnnotation}
                  onClick={() => void saveAnnotation()}
                  className="h-7 rounded bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {isSavingAnnotation ? "Saving" : "Save note"}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <header className="h-14 px-3 border-b border-border flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onClose}
          title="Close article"
          className="w-8 h-8 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary"
        >
          <X size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground truncate">
            {document.source.replace(/\.pdf$/i, "").replace(/_/g, " ")}
          </h2>
          <p className="font-mono text-[10px] text-muted-foreground truncate">
            {document.cluster_label}
          </p>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            title="Previous page"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
            className="w-8 h-8 rounded flex items-center justify-center hover:bg-secondary disabled:opacity-30"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="font-mono text-xs text-muted-foreground min-w-20 text-center">
            {pageNumber} / {pageCount || "—"}
          </span>
          <button
            type="button"
            title="Next page"
            disabled={!pageCount || pageNumber >= pageCount}
            onClick={() =>
              setPageNumber((value) => Math.min(pageCount, value + 1))
            }
            className="w-8 h-8 rounded flex items-center justify-center hover:bg-secondary disabled:opacity-30"
          >
            <ChevronRight size={15} />
          </button>
          <div className="w-px h-5 bg-border mx-1" />
          <button
            type="button"
            title="Zoom out"
            onClick={() => setScale((value) => Math.max(0.65, value - 0.1))}
            className="w-8 h-8 rounded flex items-center justify-center hover:bg-secondary"
          >
            <Minus size={14} />
          </button>
          <span className="font-mono text-xs text-muted-foreground w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            title="Zoom in"
            onClick={() => setScale((value) => Math.min(1.8, value + 0.1))}
            className="w-8 h-8 rounded flex items-center justify-center hover:bg-secondary"
          >
            <Plus size={14} />
          </button>
          <div className="w-px h-5 bg-border mx-1" />
          <button
            type="button"
            title={detailsOpen ? "Collapse details" : "Show details"}
            onClick={() => setDetailsOpen((value) => !value)}
            className="h-8 px-2 rounded border border-border text-xs text-muted-foreground flex items-center gap-1.5 hover:text-primary hover:bg-secondary"
          >
            <ChevronUp
              size={13}
              className={`transition-transform ${detailsOpen ? "" : "rotate-180"}`}
            />
            Details
          </button>
        </div>
      </header>

      <div
        ref={pageContainerRef}
        className="flex-1 min-h-0 overflow-auto bg-[#090a0c] py-5 px-4"
        onMouseUp={captureSelection}
      >
        <Document
          file={getPdfUrl(document.source)}
          onLoadSuccess={({ numPages }) => {
            setLoadError("");
            setPageCount(numPages);
            setPageNumber((value) => Math.min(value, numPages));
          }}
          onLoadError={(error) => setLoadError(error.message)}
          loading={
            <div className="h-80 flex items-center justify-center text-sm text-muted-foreground">
              Loading article…
            </div>
          }
          error={
            <div className="h-80 flex items-center justify-center px-8 text-center">
              <div>
                <p className="text-sm text-destructive">
                  This PDF could not be rendered.
                </p>
                {loadError && (
                  <p className="mt-2 font-mono text-[10px] text-muted-foreground break-words">
                    {loadError}
                  </p>
                )}
              </div>
            </div>
          }
          className="flex justify-center"
        >
          <div ref={pageShellRef} className="relative">
            <Page
              pageNumber={pageNumber}
              width={pageWidth}
              scale={scale}
              renderTextLayer
              renderAnnotationLayer
              className="shadow-2xl"
            />
            <div className="pointer-events-none absolute inset-0 z-20">
              {savedHighlightRects.map((rect) => (
                <span
                  key={rect.id}
                  className="absolute rounded-[2px] border border-primary/70 bg-primary/35 shadow-[0_0_0_1px_rgba(224,180,65,0.18)]"
                  style={{
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                  }}
                />
              ))}
            </div>
          </div>
        </Document>
      </div>

      <div
        className="border-t border-border shrink-0 min-h-0"
        style={
          detailsOpen
            ? {
                flex: `0 0 ${detailsHeight}px`,
                height: detailsHeight,
                minHeight: detailsHeight,
                maxHeight: detailsHeight,
              }
            : undefined
        }
      >
        {!detailsOpen ? (
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            className="w-full h-10 px-3 flex items-center gap-2 text-left text-xs text-muted-foreground hover:bg-secondary"
          >
            <ChevronUp size={13} className="rotate-180 text-primary" />
            <span className="font-mono uppercase tracking-widest">
              Details collapsed
            </span>
            <span className="ml-auto">
              {`${annotations.length} notes · ${visuals.length} visuals`}
            </span>
          </button>
        ) : (
        <div className="h-full min-h-0 flex flex-col">
          <div
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize details"
            onPointerDown={startDetailsResize}
            className="group h-5 shrink-0 cursor-row-resize border-b border-border bg-card hover:bg-primary/10 active:bg-primary/15 flex items-center justify-center touch-none select-none relative z-20"
          >
            <span className="h-1 w-16 rounded-full bg-border group-hover:bg-primary/70" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
        {annotationStatus && (
          <p
            className={`px-1 text-[11px] ${
              annotationStatus.startsWith("Could not")
                ? "text-destructive"
                : "text-muted-foreground"
            }`}
          >
            {annotationStatus}
          </p>
        )}

        <div className="rounded border border-border bg-background">
          <div className="px-3 py-2 border-b border-border flex items-center gap-2">
            <NotebookPen size={12} className="text-primary" />
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Saved notes
            </p>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {annotations.length}
            </span>
          </div>
          <div className="max-h-40 overflow-y-auto">
            {annotations.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                Saved highlights and notes for this PDF will appear here.
              </p>
            ) : (
              annotations.slice(0, 8).map((annotation) => (
                <article
                  key={annotation.annotation_id}
                  className="px-3 py-3 border-b border-border last:border-b-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-primary">
                      p.{annotation.page}
                    </span>
                    <button
                      type="button"
                      onClick={() => addAnnotationToChat(annotation)}
                      className="ml-auto text-[10px] text-primary flex items-center gap-1"
                    >
                      <MessageSquarePlus size={11} />
                      Use in chat
                    </button>
                    <button
                      type="button"
                      title="Delete note"
                      onClick={() => void removeAnnotation(annotation.annotation_id)}
                      className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-secondary"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-2">
                    {annotation.selected_text}
                  </p>
                  {annotation.note && (
                    <p className="mt-1 text-xs text-foreground leading-relaxed line-clamp-2">
                      {annotation.note}
                    </p>
                  )}
                </article>
              ))
            )}
          </div>
        </div>

        <div className="rounded border border-border bg-background">
          <div className="px-3 py-2 border-b border-border flex items-center gap-2">
            <FileText size={12} className="text-primary" />
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Figures and images
            </p>
            <button
              type="button"
              disabled={isExtractingVisuals}
              onClick={() => void extractVisuals()}
              className="ml-auto h-6 px-2 rounded border border-border text-[10px] text-primary hover:bg-secondary disabled:opacity-40"
            >
              {isExtractingVisuals ? "Extracting" : "Extract"}
            </button>
          </div>
          {visualStatus && (
            <p
              className={`px-3 py-2 text-[11px] ${
                visualStatus.startsWith("Could not")
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {visualStatus}
            </p>
          )}
          <div className="max-h-56 overflow-y-auto">
            {visuals.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                Extract figures to make graphs and images available as chat context.
              </p>
            ) : (
              visuals.slice(0, 8).map((visual) => (
                <article
                  key={visual.asset_id}
                  className="px-3 py-3 border-b border-border last:border-b-0"
                >
                  <img
                    src={getVisualImageUrl(visual.image_url)}
                    alt={visual.title || "PDF visual"}
                    className="w-full max-h-32 rounded border border-border object-contain bg-card"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <span className="font-mono text-[10px] text-primary">
                      {visual.page ? `p.${visual.page}` : visual.asset_type}
                    </span>
                    <button
                      type="button"
                      onClick={() => addVisualToChat(visual)}
                      className="ml-auto text-[10px] text-primary flex items-center gap-1"
                    >
                      <MessageSquarePlus size={11} />
                      Use in chat
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-3">
                    {visual.caption}
                  </p>
                </article>
              ))
            )}
          </div>
          </div>
        </div>
        </div>
        )}
      </div>
    </aside>
  );
}

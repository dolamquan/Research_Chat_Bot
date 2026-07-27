import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  MessageSquarePlus,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

import { getPdfUrl } from "../api";
import type { ClusterDocument, Source } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export function DocumentReader({
  document,
  onClose,
  onPinSelection,
}: {
  document: ClusterDocument;
  onClose: () => void;
  onPinSelection: (source: Source) => void;
}) {
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.05);
  const [selectedText, setSelectedText] = useState("");
  const [loadError, setLoadError] = useState("");
  const [pageWidth, setPageWidth] = useState(520);
  const pageContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = pageContainerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setPageWidth(Math.max(300, entry.contentRect.width - 32));
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  function captureSelection() {
    const selection = window.getSelection()?.toString().trim() || "";
    if (selection.length >= 3) setSelectedText(selection);
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
    window.getSelection()?.removeAllRanges();
  }

  return (
    <aside className="hidden md:flex w-[46vw] min-w-[420px] max-w-[620px] shrink-0 border-l border-border bg-card flex-col min-h-0">
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
          <Page
            pageNumber={pageNumber}
            width={pageWidth}
            scale={scale}
            renderTextLayer
            renderAnnotationLayer
            className="shadow-2xl"
          />
        </Document>
      </div>

      <div className="border-t border-border p-3 shrink-0">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Selected PDF text
            </p>
            <div className="mt-1 min-h-8 max-h-20 overflow-y-auto">
              {selectedText ? (
                <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">
                  {selectedText}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Highlight text directly on the page to use it as chat context.
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={!selectedText}
            onClick={addSelection}
            className="h-9 px-3 rounded bg-primary text-primary-foreground flex items-center justify-center gap-2 text-xs disabled:opacity-35 shrink-0"
          >
            <MessageSquarePlus size={14} />
            Add to chat
          </button>
        </div>
      </div>
    </aside>
  );
}

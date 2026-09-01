import { useMemo, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";

import type { Cluster, ClusterDocument, ClusterGraph } from "../types";

/**
 * A map you can actually travel: scroll zooms toward the cursor, dragging
 * pans, cluster names live on the map itself, and a dot is a paper — hover
 * names it, clicking selects it without silently rescoping the chat. The
 * sidebar carries search, the cluster index, and whatever is selected.
 */

const CLUSTER_COLORS = [
  "#67e8f9",
  "#93c5fd",
  "#a78bfa",
  "#f0abfc",
  "#fb7185",
  "#fdba74",
  "#86efac",
  "#5eead4",
  "#c4b5fd",
  "#f9a8d4",
  "#bef264",
  "#7dd3fc",
];

const WIDTH = 980;
const HEIGHT = 620;
const PADDING = 56;
const MIN_SCALE = 0.6;
const MAX_SCALE = 9;

function clusterColor(clusterId: number): string {
  return CLUSTER_COLORS[Math.abs(clusterId) % CLUSTER_COLORS.length];
}

function graphPosition(value: number, size: number): number {
  const normalized = (Math.max(-1, Math.min(1, value)) + 1) / 2;
  return PADDING + normalized * (size - PADDING * 2);
}

function titleFromSource(source: string): string {
  return source
    .replace(/\.pdf$/i, "")
    .replace(/^\d{4}\.\d+(?:v\d+)?_/i, "")
    .replace(/[_-]+/g, " ");
}

function documentTitle(document: ClusterDocument): string {
  return document.title || titleFromSource(document.source);
}

type PlacedDocument = ClusterDocument & { px: number; py: number };

export function TopologyExplorer({
  graph,
  selectedCluster,
  onSelectCluster,
  onClear,
  onClose,
  onOpenDocument,
}: {
  graph: ClusterGraph;
  selectedCluster?: Cluster;
  onSelectCluster: (cluster: Cluster) => void;
  onClear: () => void;
  onClose: () => void;
  onOpenDocument?: (document: ClusterDocument) => void;
}) {
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [hovered, setHovered] = useState<{
    document: PlacedDocument;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [selectedDocument, setSelectedDocument] =
    useState<PlacedDocument | null>(null);
  const [query, setQuery] = useState("");

  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startViewX: number;
    startViewY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  const documents = useMemo<PlacedDocument[]>(
    () =>
      graph.documents.map((document) => ({
        ...document,
        px: graphPosition(document.x, WIDTH),
        py: graphPosition(-document.y, HEIGHT),
      })),
    [graph.documents],
  );

  // Label anchors: the mean position of each cluster's papers.
  const centroids = useMemo(() => {
    const sums = new Map<
      number,
      { x: number; y: number; count: number; label: string }
    >();
    for (const document of documents) {
      const entry = sums.get(document.cluster_id) ?? {
        x: 0,
        y: 0,
        count: 0,
        label: document.cluster_label,
      };
      entry.x += document.px;
      entry.y += document.py;
      entry.count += 1;
      sums.set(document.cluster_id, entry);
    }
    return [...sums.entries()].map(([clusterId, entry]) => ({
      clusterId,
      x: entry.x / entry.count,
      y: entry.y / entry.count,
      label: entry.label,
    }));
  }, [documents]);

  const trimmedQuery = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      trimmedQuery
        ? documents.filter((document) =>
            documentTitle(document).toLowerCase().includes(trimmedQuery),
          )
        : [],
    [documents, trimmedQuery],
  );
  const matchedSources = useMemo(
    () => new Set(matches.map((document) => document.source)),
    [matches],
  );

  function clientToView(clientX: number, clientY: number) {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    const point = clientToView(event.clientX, event.clientY);
    setViewport((current) => {
      const nextScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, current.scale * (event.deltaY > 0 ? 0.88 : 1.14)),
      );
      const ratio = nextScale / current.scale;
      return {
        x: point.x - (point.x - current.x) * ratio,
        y: point.y - (point.y - current.y) * ratio,
        scale: nextScale,
      };
    });
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = clientToView(event.clientX, event.clientY);
    dragRef.current = {
      pointerId: event.pointerId,
      startViewX: point.x,
      startViewY: point.y,
      startX: viewport.x,
      startY: viewport.y,
      moved: false,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = clientToView(event.clientX, event.clientY);
    const dx = point.x - drag.startViewX;
    const dy = point.y - drag.startViewY;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    setViewport((current) => ({
      ...current,
      x: drag.startX + dx,
      y: drag.startY + dy,
    }));
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      // A press that never travelled is a click on empty space: deselect.
      if (!drag.moved) setSelectedDocument(null);
      dragRef.current = null;
    }
  }

  function fitAll() {
    setViewport({ x: 0, y: 0, scale: 1 });
  }

  function zoomTo(documentsInScope: PlacedDocument[]) {
    if (documentsInScope.length === 0) return;
    const xs = documentsInScope.map((document) => document.px);
    const ys = documentsInScope.map((document) => document.py);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 40);
    const spanY = Math.max(maxY - minY, 40);
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(WIDTH / spanX, HEIGHT / spanY) * 0.7),
    );
    setViewport({
      x: WIDTH / 2 - ((minX + maxX) / 2) * scale,
      y: HEIGHT / 2 - ((minY + maxY) / 2) * scale,
      scale,
    });
  }

  function handleClusterClick(cluster: Cluster) {
    if (selectedCluster?.cluster_id === cluster.cluster_id) {
      onClear();
      fitAll();
      return;
    }
    onSelectCluster(cluster);
    zoomTo(
      documents.filter(
        (document) => document.cluster_id === cluster.cluster_id,
      ),
    );
  }

  function revealDocument(document: PlacedDocument) {
    setSelectedDocument(document);
    setViewport({
      x: WIDTH / 2 - document.px * 3,
      y: HEIGHT / 2 - document.py * 3,
      scale: 3,
    });
  }

  const containerRect = containerRef.current?.getBoundingClientRect();
  const clusterOf = (clusterId: number) =>
    graph.clusters.find((cluster) => cluster.cluster_id === clusterId);

  return (
    <div className="h-full min-h-0 max-w-7xl mx-auto flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold text-foreground">
          Paper topology
        </h2>
        <span className="text-xs text-muted-foreground">
          {graph.documents.length} papers · {graph.clusters.length} clusters
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={fitAll}
            title="Reset zoom and position"
            className="h-8 px-3 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            Fit
          </button>
          {selectedCluster && (
            <button
              type="button"
              onClick={() => {
                onClear();
                fitAll();
              }}
              title="Chat across all indexed papers again"
              className="h-8 px-3 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              Clear selection
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Return to chat"
            className="h-8 px-3 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            Close
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 grid grid-cols-[minmax(0,1fr)_300px] gap-4">
        <div
          ref={containerRef}
          className="relative min-h-0 rounded border border-border bg-[#08090b] overflow-hidden"
        >
          {graph.documents.length > 0 ? (
            <>
              <svg
                ref={svgRef}
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                className={`block w-full h-full touch-none ${
                  dragRef.current ? "cursor-grabbing" : "cursor-grab"
                }`}
                role="img"
                aria-label="Paper cluster topology map"
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                <g
                  transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}
                >
                  {documents.map((document) => {
                    const inActiveCluster =
                      selectedCluster?.cluster_id === document.cluster_id;
                    const dimmed =
                      (selectedCluster && !inActiveCluster) ||
                      (trimmedQuery && !matchedSources.has(document.source));
                    const isSelected =
                      selectedDocument?.source === document.source;
                    const isHovered =
                      hovered?.document.source === document.source;
                    const color = clusterColor(document.cluster_id);
                    const radius =
                      (isSelected ? 9 : isHovered ? 8 : 5.5) /
                      Math.sqrt(viewport.scale);

                    return (
                      <circle
                        key={document.source}
                        cx={document.px}
                        cy={document.py}
                        r={radius}
                        fill={color}
                        fillOpacity={dimmed ? 0.28 : 0.9}
                        stroke={
                          isSelected || isHovered
                            ? "#ffffff"
                            : matchedSources.has(document.source)
                              ? "#ffffff"
                              : color
                        }
                        strokeOpacity={
                          isSelected || isHovered
                            ? 0.95
                            : matchedSources.has(document.source)
                              ? 0.7
                              : 0.35
                        }
                        strokeWidth={
                          (isSelected ? 2 : 1) / Math.sqrt(viewport.scale)
                        }
                        className="cursor-pointer"
                        onPointerDown={(event) => event.stopPropagation()}
                        onPointerEnter={(event) =>
                          setHovered({
                            document,
                            clientX: event.clientX,
                            clientY: event.clientY,
                          })
                        }
                        onPointerMove={(event) =>
                          setHovered({
                            document,
                            clientX: event.clientX,
                            clientY: event.clientY,
                          })
                        }
                        onPointerLeave={() => setHovered(null)}
                        onClick={() => setSelectedDocument(document)}
                      />
                    );
                  })}

                  {centroids.map((centroid) => {
                    const active =
                      selectedCluster?.cluster_id === centroid.clusterId;
                    return (
                      <text
                        key={centroid.clusterId}
                        x={centroid.x}
                        y={centroid.y}
                        textAnchor="middle"
                        fontSize={12 / viewport.scale}
                        fontWeight={600}
                        fill={active ? "#ffffff" : "#8f8f8f"}
                        opacity={selectedCluster && !active ? 0.4 : 0.95}
                        stroke="#08090b"
                        strokeWidth={3.5 / viewport.scale}
                        paintOrder="stroke"
                        className="cursor-pointer select-none"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          const cluster = clusterOf(centroid.clusterId);
                          if (cluster) handleClusterClick(cluster);
                        }}
                      >
                        {centroid.label}
                      </text>
                    );
                  })}
                </g>
              </svg>

              <div className="pointer-events-none absolute bottom-2.5 left-3 text-[11px] text-muted-foreground/70">
                Scroll to zoom · drag to pan · click a dot to inspect a paper ·
                click a name to focus its cluster
              </div>

              {hovered && containerRect && (
                <div
                  className="pointer-events-none absolute z-10 max-w-[18rem] rounded bg-[#161616] px-2.5 py-1.5"
                  style={{
                    left: Math.min(
                      hovered.clientX - containerRect.left + 14,
                      containerRect.width - 300,
                    ),
                    top: Math.min(
                      hovered.clientY - containerRect.top + 12,
                      containerRect.height - 70,
                    ),
                  }}
                >
                  <div className="text-xs leading-snug text-foreground">
                    {documentTitle(hovered.document)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{
                        backgroundColor: clusterColor(
                          hovered.document.cluster_id,
                        ),
                      }}
                    />
                    {hovered.document.cluster_label}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-center px-8">
              <p className="text-xs text-muted-foreground">
                Start the backend to load the saved research topology.
              </p>
            </div>
          )}
        </div>

        <aside className="min-h-0 rounded border border-border bg-card flex flex-col">
          <div className="p-3 shrink-0">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search papers…"
              className="w-full rounded bg-secondary px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {trimmedQuery ? (
              <>
                <p className="px-1.5 pb-1 text-xs font-medium text-muted-foreground">
                  {matches.length === 0
                    ? "No papers match"
                    : `${matches.length} matching paper${matches.length === 1 ? "" : "s"}`}
                </p>
                {matches.slice(0, 30).map((document) => (
                  <button
                    type="button"
                    key={document.source}
                    onClick={() => revealDocument(document)}
                    className={`w-full rounded px-2 py-1.5 text-left ${
                      selectedDocument?.source === document.source
                        ? "bg-secondary"
                        : "hover:bg-secondary"
                    }`}
                  >
                    <span className="block text-xs leading-snug text-foreground line-clamp-2">
                      {documentTitle(document)}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                        style={{
                          backgroundColor: clusterColor(document.cluster_id),
                        }}
                      />
                      <span className="truncate">
                        {document.cluster_label}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <p className="px-1.5 pb-1 text-xs font-medium text-muted-foreground">
                  Clusters
                </p>
                {graph.clusters.map((cluster) => {
                  const active =
                    selectedCluster?.cluster_id === cluster.cluster_id;
                  return (
                    <button
                      type="button"
                      key={cluster.cluster_id}
                      onClick={() => handleClusterClick(cluster)}
                      title={
                        active
                          ? "Click again to chat across all papers"
                          : "Focus the map and scope chat to this cluster"
                      }
                      className={`w-full flex items-center gap-2 rounded px-2 py-1.5 text-left ${
                        active ? "bg-secondary" : "hover:bg-secondary"
                      }`}
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{
                          backgroundColor: clusterColor(cluster.cluster_id),
                        }}
                      />
                      <span
                        className={`min-w-0 flex-1 truncate text-xs ${
                          active ? "text-foreground" : "text-foreground/85"
                        }`}
                      >
                        {cluster.cluster_label}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {cluster.document_count}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>

          <div className="p-3 border-t border-border shrink-0">
            {selectedDocument ? (
              <div>
                <p className="text-xs leading-snug text-foreground">
                  {documentTitle(selectedDocument)}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: clusterColor(
                        selectedDocument.cluster_id,
                      ),
                    }}
                  />
                  <span className="truncate">
                    {selectedDocument.cluster_label}
                  </span>
                  {selectedDocument.domain && (
                    <span className="shrink-0">
                      · {selectedDocument.domain}
                    </span>
                  )}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  {onOpenDocument && (
                    <button
                      type="button"
                      onClick={() => onOpenDocument(selectedDocument)}
                      className="h-7 px-3 rounded bg-primary text-primary-foreground text-xs font-medium hover:opacity-90"
                    >
                      Open paper
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const cluster = clusterOf(selectedDocument.cluster_id);
                      if (cluster) handleClusterClick(cluster);
                    }}
                    className="h-7 px-2 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary"
                  >
                    Focus cluster
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Chat scope
                </p>
                <p className="mt-1 text-xs text-foreground leading-snug">
                  {selectedCluster?.cluster_label || "All indexed papers"}
                </p>
                {selectedCluster && (
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                    Answers retrieve only from this cluster.
                  </p>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

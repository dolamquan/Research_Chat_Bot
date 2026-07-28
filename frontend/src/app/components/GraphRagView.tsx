import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { GitBranch, Loader2, Maximize2, Network, RefreshCw, Search } from "lucide-react";

import { buildGraphRag, getGraphRag, queryGraphRag } from "../api";
import type { GraphRagGraph, GraphRagNode, GraphRagQueryResponse } from "../types";

const EMPTY_GRAPH: GraphRagGraph = {
  nodes: [],
  edges: [],
  stats: { paper_count: 0, concept_count: 0, edge_count: 0 },
  stale: true,
};

type GraphRagViewProps = {
  domain?: string;
  category?: string;
};

function nodeColor(type: string): string {
  if (type === "paper") return "#e0b441";
  if (type === "concept") return "#62b8ad";
  if (type === "domain") return "#a36fc5";
  if (type === "category") return "#7698df";
  return "#94a3b8";
}

function clampLabel(label: string, limit = 74): string {
  return label.length > limit ? `${label.slice(0, limit - 1)}...` : label;
}

function toSvgPoint(node: GraphRagNode, width: number, height: number) {
  return {
    x: width / 2 + node.x * (width * 0.42),
    y: height / 2 + node.y * (height * 0.42),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function GraphRagView({ domain, category }: GraphRagViewProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [graph, setGraph] = useState<GraphRagGraph>(EMPTY_GRAPH);
  const [selectedNode, setSelectedNode] = useState<GraphRagNode | null>(null);
  const [query, setQuery] = useState("");
  const [queryResult, setQueryResult] = useState<GraphRagQueryResponse | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isQuerying, setIsQuerying] = useState(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [dragState, setDragState] = useState<
    | {
        type: "canvas";
        pointerId: number;
        startClientX: number;
        startClientY: number;
        startX: number;
        startY: number;
      }
    | {
        type: "node";
        pointerId: number;
        nodeId: string;
      }
    | null
  >(null);

  const scopeLabel = domain || category ? [domain, category].filter(Boolean).join(" / ") : "All papers";

  async function loadGraph() {
    setIsLoading(true);
    setError("");
    try {
      const result = await getGraphRag({ domain, category });
      setGraph(result);
      setStatus(result.stale ? "No graph has been built for this scope yet." : "Graph loaded.");
      if (selectedNode && !result.nodes.some((node) => node.id === selectedNode.id)) {
        setSelectedNode(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Graph RAG.");
    } finally {
      setIsLoading(false);
    }
  }

  async function rebuildGraph() {
    setIsLoading(true);
    setError("");
    setStatus("Building graph...");
    try {
      const result = await buildGraphRag({ domain, category });
      setGraph(result);
      setStatus("Graph rebuilt.");
      setSelectedNode(null);
      setQueryResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build Graph RAG.");
    } finally {
      setIsLoading(false);
    }
  }

  async function runQuery() {
    const trimmed = query.trim();
    if (!trimmed) return;
    setIsQuerying(true);
    setError("");
    try {
      const result = await queryGraphRag({ query: trimmed, domain, category });
      setQueryResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not query Graph RAG.");
    } finally {
      setIsQuerying(false);
    }
  }

  useEffect(() => {
    void loadGraph();
  }, [domain, category]);

  const nodeById = useMemo(() => {
    return new Map(graph.nodes.map((node) => [node.id, node]));
  }, [graph.nodes]);

  const highlightedIds = useMemo(() => {
    const ids = new Set<string>();
    queryResult?.nodes.forEach((node) => ids.add(node.id));
    if (selectedNode) ids.add(selectedNode.id);
    return ids;
  }, [queryResult, selectedNode]);

  const width = 980;
  const height = 560;

  function clientToSvgPoint(event: ReactPointerEvent<SVGSVGElement> | ReactWheelEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return { x: width / 2, y: height / 2 };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const screenCtm = svg.getScreenCTM();
    if (!screenCtm) return { x: width / 2, y: height / 2 };
    return point.matrixTransform(screenCtm.inverse());
  }

  function worldToGraphCoords(point: { x: number; y: number }) {
    const worldX = (point.x - viewport.x) / viewport.scale;
    const worldY = (point.y - viewport.y) / viewport.scale;
    return {
      x: clamp((worldX - width / 2) / (width * 0.42), -1.25, 1.25),
      y: clamp((worldY - height / 2) / (height * 0.42), -1.25, 1.25),
    };
  }

  function resetViewport() {
    setViewport({ x: 0, y: 0, scale: 1 });
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const point = clientToSvgPoint(event);
    const nextScale = clamp(viewport.scale * (event.deltaY > 0 ? 0.9 : 1.1), 0.45, 3.5);
    const scaleRatio = nextScale / viewport.scale;
    setViewport({
      x: point.x - (point.x - viewport.x) * scaleRatio,
      y: point.y - (point.y - viewport.y) * scaleRatio,
      scale: nextScale,
    });
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({
      type: "canvas",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y,
    });
  }

  function handleNodePointerDown(event: ReactPointerEvent<SVGGElement>, node: GraphRagNode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNode(node);
    setDragState({
      type: "node",
      pointerId: event.pointerId,
      nodeId: node.id,
    });
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    if (dragState.type === "canvas") {
      const rect = svgRef.current?.getBoundingClientRect();
      const scaleX = rect ? width / rect.width : 1;
      const scaleY = rect ? height / rect.height : 1;
      setViewport({
        ...viewport,
        x: dragState.startX + (event.clientX - dragState.startClientX) * scaleX,
        y: dragState.startY + (event.clientY - dragState.startClientY) * scaleY,
      });
      return;
    }

    const graphCoords = worldToGraphCoords(clientToSvgPoint(event));
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === dragState.nodeId
          ? { ...node, x: graphCoords.x, y: graphCoords.y }
          : node,
      ),
    }));
    setSelectedNode((current) =>
      current?.id === dragState.nodeId
        ? { ...current, x: graphCoords.x, y: graphCoords.y }
        : current,
    );
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragState?.pointerId === event.pointerId) {
      setDragState(null);
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background">
      <div className="mx-auto max-w-7xl px-6 py-6 space-y-5">
        <section className="border border-border bg-card rounded-lg overflow-hidden">
          <div className="p-5 border-b border-border flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
                <GitBranch size={18} />
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Graph RAG
                </p>
                <h2 className="text-xl font-semibold">Paper concept graph</h2>
                <p className="text-sm text-muted-foreground">
                  {scopeLabel} · {graph.stats?.paper_count ?? 0} paper nodes ·{" "}
                  {graph.stats?.concept_count ?? 0} concept nodes ·{" "}
                  {graph.stats?.edge_count ?? 0} edges
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void rebuildGraph()}
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded border border-primary/35 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-60"
            >
              {isLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Build graph
            </button>
          </div>

          {(error || status) && (
            <div className="px-5 pt-4">
              {error ? (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{status}</p>
              )}
            </div>
          )}

          <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="relative min-h-[440px] overflow-hidden rounded-lg border border-border bg-[#090b0d]">
              {graph.nodes.length === 0 ? (
                <div className="h-[560px] flex items-center justify-center text-center text-sm text-muted-foreground">
                  Build the graph to create paper, concept, and relationship nodes.
                </div>
              ) : (
                <>
                  <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded border border-border bg-card/90 px-2 py-1.5 backdrop-blur">
                    <button
                      type="button"
                      onClick={resetViewport}
                      title="Reset graph view"
                      className="h-7 w-7 rounded border border-border bg-background text-muted-foreground flex items-center justify-center hover:text-foreground"
                    >
                      <Maximize2 size={13} />
                    </button>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      Drag canvas · wheel zoom · drag nodes
                    </span>
                  </div>
                  <svg
                    ref={svgRef}
                    viewBox={`0 0 ${width} ${height}`}
                    className={`h-full min-h-[560px] w-full touch-none ${
                      dragState?.type === "canvas" ? "cursor-grabbing" : "cursor-grab"
                    }`}
                    onWheel={handleWheel}
                    onPointerDown={handleCanvasPointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                  >
                    <rect width={width} height={height} fill="#090b0d" />
                    <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
                      {graph.edges.map((edge) => {
                        const source = nodeById.get(edge.source);
                        const target = nodeById.get(edge.target);
                        if (!source || !target) return null;
                        const start = toSvgPoint(source, width, height);
                        const end = toSvgPoint(target, width, height);
                        const active = highlightedIds.has(source.id) || highlightedIds.has(target.id);
                        return (
                          <line
                            key={edge.id}
                            x1={start.x}
                            y1={start.y}
                            x2={end.x}
                            y2={end.y}
                            stroke={active ? "#e0b441" : "#26313a"}
                            strokeWidth={active ? 1.6 : 0.8}
                            opacity={active ? 0.75 : 0.35}
                            className="transition-opacity duration-200"
                          />
                        );
                      })}
                      {graph.nodes.map((node) => {
                        const point = toSvgPoint(node, width, height);
                        const active = highlightedIds.size === 0 || highlightedIds.has(node.id);
                        const radius = node.type === "paper" ? 5 : node.type === "concept" ? 7 : 9;
                        const isDragging = dragState?.type === "node" && dragState.nodeId === node.id;
                        return (
                          <g
                            key={node.id}
                            role="button"
                            tabIndex={0}
                            className={isDragging ? "cursor-grabbing" : "cursor-pointer"}
                            onPointerDown={(event) => handleNodePointerDown(event, node)}
                            onClick={() => setSelectedNode(node)}
                          >
                            <circle
                              cx={point.x}
                              cy={point.y}
                              r={radius + Math.min(Number(node.weight || 1), 18) * 0.25}
                              fill={nodeColor(node.type)}
                              opacity={active ? 0.88 : 0.2}
                              stroke={selectedNode?.id === node.id ? "#ffffff" : "transparent"}
                              strokeWidth={2}
                              className="transition-[opacity,stroke-width] duration-200"
                            />
                            {selectedNode?.id === node.id && (
                              <>
                                <circle
                                  cx={point.x}
                                  cy={point.y}
                                  r={radius + 9}
                                  fill="none"
                                  stroke="#e0b441"
                                  strokeWidth={1.2}
                                  opacity={0.55}
                                  className="animate-pulse"
                                />
                                <text
                                  x={point.x + 11}
                                  y={point.y - 9}
                                  fill="#e5e7eb"
                                  fontSize="12"
                                  fontFamily="Inter, sans-serif"
                                >
                                  {clampLabel(node.label, 44)}
                                </text>
                              </>
                            )}
                          </g>
                        );
                      })}
                    </g>
                  </svg>
                </>
              )}
            </div>

            <aside className="rounded-lg border border-border bg-secondary/30 min-h-[440px] flex flex-col">
              <div className="p-4 border-b border-border">
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Selection
                </p>
                {selectedNode ? (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: nodeColor(selectedNode.type) }}
                      />
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">
                        {selectedNode.type}
                      </span>
                    </div>
                    <h3 className="text-base font-semibold leading-snug">
                      {selectedNode.label}
                    </h3>
                    {selectedNode.abstract && (
                      <p className="text-xs leading-5 text-muted-foreground line-clamp-6">
                        {selectedNode.abstract}
                      </p>
                    )}
                    {selectedNode.tags && selectedNode.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedNode.tags.slice(0, 8).map((tag) => (
                          <span
                            key={tag}
                            className="rounded border border-border bg-background px-2 py-1 text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Click a paper, concept, category, or domain node.
                  </p>
                )}
              </div>

              <div className="p-4 space-y-3">
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Graph query
                </p>
                <textarea
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Ask about relationships, shared concepts, or papers connected to a topic..."
                  className="min-h-24 w-full resize-none rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => void runQuery()}
                  disabled={isQuerying || !query.trim()}
                  className="w-full inline-flex items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {isQuerying ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
                  Query graph
                </button>
              </div>
            </aside>
          </div>
        </section>

        {queryResult && (
          <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="mb-3 flex items-center gap-2 text-primary">
                <Network size={15} />
                <p className="font-mono text-[10px] uppercase tracking-widest">
                  Graph answer
                </p>
              </div>
              <p className="text-sm leading-6 text-foreground">{queryResult.answer}</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Matched concepts
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {queryResult.concepts.length ? (
                    queryResult.concepts.slice(0, 10).map((node) => (
                      <button
                        type="button"
                        key={node.id}
                        onClick={() => setSelectedNode(node)}
                        className="rounded border border-border bg-secondary px-2 py-1 text-xs hover:border-primary/40"
                      >
                        {node.label}
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">No direct concept matches.</span>
                  )}
                </div>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Matched papers
                </p>
                <div className="mt-2 space-y-2">
                  {queryResult.papers.map((paper) => (
                    <button
                      type="button"
                      key={paper.id}
                      onClick={() => setSelectedNode(paper)}
                      className="w-full rounded border border-border bg-secondary/50 px-3 py-2 text-left text-xs leading-5 hover:border-primary/40"
                    >
                      {paper.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { GitBranch, Loader2, Maximize2, Network, RefreshCw, Search } from "lucide-react";

import {
  buildGraphRag,
  explainGraphRagPath,
  generateResearchBrief,
  getArticles,
  getGraphRag,
  getGraphRagNeighbors,
  queryGraphRag,
} from "../api";
import type {
  Article,
  GraphRagGraph,
  GraphRagNeighborsResponse,
  GraphRagNode,
  GraphRagPathResponse,
  GraphRagQueryResponse,
  ResearchBriefResponse,
} from "../types";

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
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticleIds, setSelectedArticleIds] = useState<string[]>([]);
  const [paperSearch, setPaperSearch] = useState("");
  const [graphSearch, setGraphSearch] = useState("");
  const [neighbors, setNeighbors] = useState<GraphRagNeighborsResponse | null>(null);
  const [pathStart, setPathStart] = useState<GraphRagNode | null>(null);
  const [pathEnd, setPathEnd] = useState<GraphRagNode | null>(null);
  const [pathResult, setPathResult] = useState<GraphRagPathResponse | null>(null);
  const [briefTopic, setBriefTopic] = useState("");
  const [briefResult, setBriefResult] = useState<ResearchBriefResponse | null>(null);
  const [isLoadingArticles, setIsLoadingArticles] = useState(false);
  const [isLoadingNeighbors, setIsLoadingNeighbors] = useState(false);
  const [isExplainingPath, setIsExplainingPath] = useState(false);
  const [isGeneratingBrief, setIsGeneratingBrief] = useState(false);
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

  const graphScope = useMemo(
    () => ({
      domain,
      category,
      articleIds: selectedArticleIds,
    }),
    [domain, category, selectedArticleIds],
  );

  const scopeLabel =
    selectedArticleIds.length > 0
      ? `${selectedArticleIds.length} selected paper${selectedArticleIds.length === 1 ? "" : "s"}`
      : domain || category
        ? [domain, category].filter(Boolean).join(" / ")
        : "All papers";

  async function loadGraph() {
    setIsLoading(true);
    setError("");
    try {
      const result = await getGraphRag(graphScope);
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
      const result = await buildGraphRag(graphScope);
      setGraph(result);
      setStatus("Graph rebuilt.");
      setSelectedNode(null);
      setQueryResult(null);
      setNeighbors(null);
      setPathResult(null);
      setBriefResult(null);
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
      const result = await queryGraphRag({ query: trimmed, ...graphScope });
      setQueryResult(result);
      setPathResult(null);
      setBriefResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not query Graph RAG.");
    } finally {
      setIsQuerying(false);
    }
  }

  useEffect(() => {
    void loadGraph();
  }, [graphScope]);

  useEffect(() => {
    async function loadArticles() {
      setIsLoadingArticles(true);
      try {
        const result = await getArticles({ domain, category, limit: 1000 });
        setArticles(result.articles.filter((article) => article.status === "indexed"));
      } catch {
        setArticles([]);
      } finally {
        setIsLoadingArticles(false);
      }
    }

    void loadArticles();
  }, [domain, category]);

  useEffect(() => {
    setSelectedArticleIds([]);
    setPaperSearch("");
    setGraphSearch("");
    setPathStart(null);
    setPathEnd(null);
    setPathResult(null);
    setBriefResult(null);
  }, [domain, category]);

  useEffect(() => {
    if (!selectedNode) {
      setNeighbors(null);
      return;
    }

    let active = true;
    setIsLoadingNeighbors(true);
    getGraphRagNeighbors({
      nodeId: selectedNode.id,
      ...graphScope,
    })
      .then((result) => {
        if (active) setNeighbors(result);
      })
      .catch(() => {
        if (active) setNeighbors(null);
      })
      .finally(() => {
        if (active) setIsLoadingNeighbors(false);
      });

    return () => {
      active = false;
    };
  }, [selectedNode?.id, graphScope]);

  const nodeById = useMemo(() => {
    return new Map(graph.nodes.map((node) => [node.id, node]));
  }, [graph.nodes]);

  const filteredGraphNodes = useMemo(() => {
    const terms = graphSearch
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (!terms.length) return [];

    return graph.nodes
      .filter((node) => {
        const text = [
          node.label,
          node.type,
          node.domain,
          node.category,
          node.source,
          (node.tags || []).join(" "),
          node.abstract,
        ]
          .join(" ")
          .toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .slice(0, 12);
  }, [graph.nodes, graphSearch]);

  const highlightedIds = useMemo(() => {
    const ids = new Set<string>();
    queryResult?.nodes.forEach((node) => ids.add(node.id));
    neighbors?.nodes.forEach((node) => ids.add(node.id));
    pathResult?.nodes.forEach((node) => ids.add(node.id));
    filteredGraphNodes.forEach((node) => ids.add(node.id));
    if (selectedNode) ids.add(selectedNode.id);
    if (pathStart) ids.add(pathStart.id);
    if (pathEnd) ids.add(pathEnd.id);
    return ids;
  }, [filteredGraphNodes, neighbors, pathEnd, pathResult, pathStart, queryResult, selectedNode]);

  const selectedArticleSet = useMemo(
    () => new Set(selectedArticleIds),
    [selectedArticleIds],
  );

  const filteredArticles = useMemo(() => {
    const terms = paperSearch
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (!terms.length) return articles.slice(0, 80);
    return articles
      .filter((article) => {
        const text = [
          article.title,
          article.source,
          article.domain,
          article.category,
          article.tags.join(" "),
        ]
          .join(" ")
          .toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .slice(0, 80);
  }, [articles, paperSearch]);

  const connectedPapers = useMemo(
    () => (neighbors?.papers || []).filter((node) => node.id !== selectedNode?.id),
    [neighbors, selectedNode],
  );

  const connectedConcepts = useMemo(
    () => (neighbors?.concepts || []).filter((node) => node.id !== selectedNode?.id),
    [neighbors, selectedNode],
  );

  const activeGraphResult = pathResult || queryResult;

  function toggleArticle(articleId: string) {
    setSelectedArticleIds((current) =>
      current.includes(articleId)
        ? current.filter((id) => id !== articleId)
        : [...current, articleId],
    );
    setQueryResult(null);
    setSelectedNode(null);
    setBriefResult(null);
  }

  function selectVisibleArticles() {
    setSelectedArticleIds((current) => {
      const next = new Set(current);
      for (const article of filteredArticles.slice(0, 30)) {
        next.add(article.article_id);
      }
      return Array.from(next);
    });
    setQueryResult(null);
    setSelectedNode(null);
    setBriefResult(null);
  }

  function handleNodeClick(node: GraphRagNode) {
    setSelectedNode(node);
    if (!pathStart || pathEnd) {
      setPathStart(node);
      setPathEnd(null);
      setPathResult(null);
      return;
    }
    if (pathStart.id !== node.id) {
      setPathEnd(node);
      setPathResult(null);
    }
  }

  async function explainPath() {
    if (!pathStart || !pathEnd || pathStart.id === pathEnd.id) return;
    setIsExplainingPath(true);
    setError("");
    try {
      const result = await explainGraphRagPath({
        sourceId: pathStart.id,
        targetId: pathEnd.id,
        ...graphScope,
      });
      setPathResult(result);
      setQueryResult(null);
      setBriefResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not explain graph path.");
    } finally {
      setIsExplainingPath(false);
    }
  }

  async function runBrief() {
    setIsGeneratingBrief(true);
    setError("");
    try {
      const result = await generateResearchBrief({
        topic: briefTopic.trim(),
        ...graphScope,
        limit: 8,
      });
      setBriefResult(result);
      setQueryResult(null);
      setPathResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate research brief.");
    } finally {
      setIsGeneratingBrief(false);
    }
  }

  const width = 1600;
  const height = 900;

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
    <div className="relative h-full min-h-0 overflow-hidden bg-[#191919]">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className={`absolute inset-0 h-full w-full touch-none ${
          dragState?.type === "canvas" ? "cursor-grabbing" : "cursor-grab"
        }`}
        onWheel={handleWheel}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <rect width={width} height={height} fill="#191919" />
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
                stroke={active ? "#e0b441" : "#4b5563"}
                strokeWidth={active ? 1.6 : 0.7}
                opacity={active ? 0.72 : 0.22}
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
                onClick={() => handleNodeClick(node)}
              >
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={radius + Math.min(Number(node.weight || 1), 18) * 0.25}
                  fill={nodeColor(node.type)}
                  opacity={active ? 0.9 : 0.24}
                  stroke={selectedNode?.id === node.id ? "#ffffff" : "transparent"}
                  strokeWidth={2}
                  className="transition-[opacity,stroke-width] duration-200"
                />
                {selectedNode?.id === node.id && (
                  <>
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r={radius + 10}
                      fill="none"
                      stroke="#e0b441"
                      strokeWidth={1.2}
                      opacity={0.7}
                      className="animate-pulse"
                    />
                    <text
                      x={point.x + 13}
                      y={point.y - 10}
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

      {graph.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Build the graph from the paper set panel to create paper, concept, and relationship nodes.
        </div>
      )}

      <div className="absolute left-5 top-5 max-w-md rounded-lg border border-border bg-card/90 p-4 shadow-2xl backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-primary/30 bg-primary/10 text-primary">
            <GitBranch size={18} />
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Graph RAG
            </p>
            <h2 className="text-xl font-semibold">Paper concept graph</h2>
            <p className="text-sm text-muted-foreground">
              {scopeLabel} - {graph.stats?.paper_count ?? 0} paper nodes -{" "}
              {graph.stats?.concept_count ?? 0} concept nodes - {graph.stats?.edge_count ?? 0} edges
            </p>
          </div>
        </div>
        {(error || status) && (
          <div className="mt-3">
            {error ? (
              <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{status}</p>
            )}
          </div>
        )}
      </div>

      <div className="absolute left-5 top-36 flex items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2 shadow-2xl backdrop-blur">
        <button
          type="button"
          onClick={resetViewport}
          title="Reset graph view"
          className="flex h-8 w-8 items-center justify-center rounded border border-border bg-background text-muted-foreground hover:text-foreground"
        >
          <Maximize2 size={14} />
        </button>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Drag canvas - wheel zoom - drag nodes
        </span>
      </div>

      <aside className="absolute bottom-5 right-5 top-5 flex w-[380px] flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-2xl backdrop-blur">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Graph paper set
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedArticleIds.length
                  ? `${selectedArticleIds.length} selected paper${selectedArticleIds.length === 1 ? "" : "s"}`
                  : "All papers in the current scope"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void rebuildGraph()}
              disabled={isLoading}
              className="inline-flex h-9 items-center gap-2 rounded border border-primary/35 bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Build
            </button>
          </div>
        </div>

        <div className="border-b border-border p-4">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={paperSearch}
              onChange={(event) => setPaperSearch(event.target.value)}
              placeholder="Search papers to include..."
              className="h-10 w-full rounded border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={selectVisibleArticles}
              disabled={filteredArticles.length === 0}
              className="h-8 flex-1 rounded border border-border bg-background px-3 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
            >
              Select visible
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedArticleIds([]);
                setQueryResult(null);
                setSelectedNode(null);
              }}
              disabled={selectedArticleIds.length === 0}
              className="h-8 rounded border border-border bg-background px-3 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="border-b border-border p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Search graph
          </p>
          <div className="relative mt-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={graphSearch}
              onChange={(event) => setGraphSearch(event.target.value)}
              placeholder="Find concepts, papers, domains..."
              className="h-10 w-full rounded border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </div>
          {graphSearch && (
            <div className="mt-3 max-h-36 space-y-1 overflow-y-auto">
              {filteredGraphNodes.length ? (
                filteredGraphNodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => setSelectedNode(node)}
                    className="flex w-full items-center gap-2 rounded border border-border bg-background px-2 py-1.5 text-left hover:border-primary/40 hover:bg-secondary"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: nodeColor(node.type) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs">{node.label}</span>
                    <span className="font-mono text-[9px] uppercase text-muted-foreground">
                      {node.type}
                    </span>
                  </button>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">No graph nodes match.</p>
              )}
            </div>
          )}
        </div>

        <div className="max-h-64 overflow-y-auto border-b border-border">
          {isLoadingArticles ? (
            <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
              Loading papers...
            </div>
          ) : filteredArticles.length ? (
            filteredArticles.map((article) => {
              const checked = selectedArticleSet.has(article.article_id);
              return (
                <button
                  key={article.article_id}
                  type="button"
                  onClick={() => toggleArticle(article.article_id)}
                  className={`flex w-full items-start gap-3 border-b border-border/60 px-4 py-3 text-left last:border-b-0 hover:bg-secondary ${
                    checked ? "bg-primary/10" : ""
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-transparent"
                    }`}
                  >
                    +
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{article.title}</span>
                    <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
                      {article.category || "uncategorized"} - {article.source}
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
              No papers match this search.
            </div>
          )}
        </div>

        <div className="border-b border-border p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Selection
          </p>
          {selectedNode ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: nodeColor(selectedNode.type) }}
                />
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {selectedNode.type}
                </span>
              </div>
              <h3 className="text-sm font-semibold leading-snug">{selectedNode.label}</h3>
              {selectedNode.abstract && (
                <p className="line-clamp-5 text-xs leading-5 text-muted-foreground">
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
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setPathStart(selectedNode);
                    setPathResult(null);
                  }}
                  className={`rounded border px-2 py-1.5 text-xs ${
                    pathStart?.id === selectedNode.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Path start
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPathEnd(selectedNode);
                    setPathResult(null);
                  }}
                  className={`rounded border px-2 py-1.5 text-xs ${
                    pathEnd?.id === selectedNode.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Path end
                </button>
              </div>
              <div className="rounded border border-border bg-background p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Neighbors
                  </span>
                  {isLoadingNeighbors && <Loader2 size={12} className="animate-spin text-primary" />}
                </div>
                {neighbors?.answer && (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{neighbors.answer}</p>
                )}
                {connectedPapers.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Connected papers
                    </p>
                    <div className="space-y-1">
                      {connectedPapers.slice(0, 5).map((paper) => (
                        <button
                          type="button"
                          key={paper.id}
                          onClick={() => setSelectedNode(paper)}
                          className="w-full truncate rounded border border-border bg-card px-2 py-1.5 text-left text-xs hover:border-primary/40"
                        >
                          {paper.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {connectedConcepts.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Connected concepts
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {connectedConcepts.slice(0, 8).map((concept) => (
                        <button
                          type="button"
                          key={concept.id}
                          onClick={() => setSelectedNode(concept)}
                          className="rounded border border-border bg-card px-2 py-1 text-[10px] hover:border-primary/40"
                        >
                          {concept.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Click two nodes to prepare a path explanation, or inspect one node at a time.
            </p>
          )}
        </div>

        <div className="p-4">
          <div className="mb-4 rounded border border-border bg-background p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Explain connection
            </p>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <p>
                Start:{" "}
                <span className="text-foreground">
                  {pathStart ? clampLabel(pathStart.label, 40) : "Select a node"}
                </span>
              </p>
              <p>
                End:{" "}
                <span className="text-foreground">
                  {pathEnd ? clampLabel(pathEnd.label, 40) : "Select a node"}
                </span>
              </p>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void explainPath()}
                disabled={!pathStart || !pathEnd || pathStart.id === pathEnd.id || isExplainingPath}
                className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isExplainingPath ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />}
                Explain path
              </button>
              <button
                type="button"
                onClick={() => {
                  setPathStart(null);
                  setPathEnd(null);
                  setPathResult(null);
                }}
                className="h-8 rounded border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            </div>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Graph query
          </p>
          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask about relationships, shared concepts, or papers connected to a topic..."
            className="mt-3 min-h-24 w-full resize-none rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={() => void runQuery()}
            disabled={isQuerying || !query.trim()}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {isQuerying ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            Query graph
          </button>

        </div>
        </div>
      </aside>

      {activeGraphResult && (
        <div className="absolute bottom-5 left-5 right-[425px] grid max-h-56 grid-cols-[minmax(0,1fr)_320px] gap-4 overflow-hidden">
          <section className="rounded-lg border border-border bg-card/95 p-4 shadow-2xl backdrop-blur">
            <div className="mb-3 flex items-center gap-2 text-primary">
              <Network size={15} />
              <p className="font-mono text-[10px] uppercase tracking-widest">
                {pathResult ? "Path explanation" : "Graph answer"}
              </p>
            </div>
            <p className="max-h-36 overflow-y-auto text-sm leading-6 text-foreground">
              {activeGraphResult.answer}
            </p>
            {pathResult?.path.length ? (
              <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {pathResult.path.length} nodes in path
              </p>
            ) : null}
          </section>
          <section className="space-y-3 overflow-y-auto rounded-lg border border-border bg-card/95 p-4 shadow-2xl backdrop-blur">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Matched concepts
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {activeGraphResult.concepts.length ? (
                  activeGraphResult.concepts.slice(0, 8).map((node) => (
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
                {activeGraphResult.papers.slice(0, 4).map((paper) => (
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
          </section>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { ChevronDown, GitBranch, Loader2, Maximize2, Network, RefreshCw, Search } from "lucide-react";

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
  if (type === "paper") return "#e8e2d4";
  if (type === "concept") return "#6ee7d8";
  if (type === "domain") return "#a5b4fc";
  if (type === "category") return "#f0abfc";
  return "#cbd5e1";
}

function nodeGlowColor(type: string): string {
  if (type === "paper") return "#f4d58d";
  if (type === "concept") return "#14b8a6";
  if (type === "domain") return "#818cf8";
  if (type === "category") return "#c084fc";
  return "#94a3b8";
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function nodeRadius(node: GraphRagNode): number {
  const base = node.type === "paper" ? 5.8 : node.type === "concept" ? 7.8 : 10;
  return base + Math.min(Number(node.weight || 1), 18) * 0.24;
}

function animatedSvgPoint(
  node: GraphRagNode,
  width: number,
  height: number,
  time: number,
  isDragging: boolean,
  panImpulse: { x: number; y: number },
) {
  const point = toSvgPoint(node, width, height);
  const seed = hashString(node.id);
  const depth = ((seed % 1000) / 1000) * 2 - 1;
  const lag = 0.025 + ((seed % 17) / 17) * 0.045 + Math.abs(depth) * 0.018;
  const springX = -panImpulse.x * lag + Math.sin(time * 2.1 + seed * 0.017) * Math.abs(panImpulse.x) * 0.006;
  const springY = -panImpulse.y * lag + Math.cos(time * 1.9 + seed * 0.019) * Math.abs(panImpulse.y) * 0.006;
  if (isDragging) {
    return { x: point.x + springX * 0.2, y: point.y + springY * 0.2, depth, scale: 1 + depth * 0.08 };
  }

  const amplitude = node.type === "paper" ? 2.6 : node.type === "concept" ? 4.4 : 3.4;
  const phase = seed * 0.013;
  return {
    x: point.x + Math.sin(time * 0.9 + phase) * amplitude + depth * 4 + springX,
    y: point.y + Math.cos(time * 0.72 + phase * 0.7) * amplitude + depth * 2 + springY,
    depth,
    scale: 1 + depth * 0.1 + clamp(Math.hypot(panImpulse.x, panImpulse.y) / 2800, 0, 0.08),
  };
}

function edgeCurve(start: { x: number; y: number; depth: number }, end: { x: number; y: number; depth: number }) {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = clamp(distance * 0.08 + (start.depth - end.depth) * 16, -46, 46);
  const controlX = midX - (dy / distance) * bend;
  const controlY = midY + (dx / distance) * bend;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} Q ${controlX.toFixed(2)} ${controlY.toFixed(
    2,
  )} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
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
  const lastCanvasDragRef = useRef<{ clientX: number; clientY: number } | null>(null);
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
  const [showPaperSet, setShowPaperSet] = useState(false);
  const [showGraphSearch, setShowGraphSearch] = useState(false);
  const [showSelectionDetails, setShowSelectionDetails] = useState(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [graphTime, setGraphTime] = useState(0);
  const [panImpulse, setPanImpulse] = useState({ x: 0, y: 0 });
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

  useEffect(() => {
    let frameId = 0;
    let lastFrame = 0;

    function tick(now: number) {
      if (now - lastFrame > 32) {
        setGraphTime(now / 1000);
        setPanImpulse((current) => {
          if (Math.abs(current.x) < 0.2 && Math.abs(current.y) < 0.2) {
            return current.x === 0 && current.y === 0 ? current : { x: 0, y: 0 };
          }
          return { x: current.x * 0.86, y: current.y * 0.86 };
        });
        lastFrame = now;
      }
      frameId = window.requestAnimationFrame(tick);
    }

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

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

  function getDisplayPoint(node: GraphRagNode) {
    const isDragging = dragState?.type === "node" && dragState.nodeId === node.id;
    return animatedSvgPoint(node, width, height, graphTime, isDragging, panImpulse);
  }

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
    setPanImpulse({ x: 0, y: 0 });
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
    lastCanvasDragRef.current = { clientX: event.clientX, clientY: event.clientY };
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
      const lastDrag = lastCanvasDragRef.current;
      if (lastDrag) {
        const impulseX = (event.clientX - lastDrag.clientX) * scaleX;
        const impulseY = (event.clientY - lastDrag.clientY) * scaleY;
        setPanImpulse({
          x: clamp(impulseX * 16, -260, 260),
          y: clamp(impulseY * 16, -260, 260),
        });
      }
      lastCanvasDragRef.current = { clientX: event.clientX, clientY: event.clientY };
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
      lastCanvasDragRef.current = null;
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
        <defs>
          <radialGradient id="graphBackdrop" cx="50%" cy="46%" r="72%">
            <stop offset="0%" stopColor="#27272a" stopOpacity="0.72" />
            <stop offset="58%" stopColor="#18181b" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#111111" stopOpacity="0" />
          </radialGradient>
          <filter id="graphNodeGlow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="graphEdgeGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <ellipse cx={width / 2} cy={height / 2} rx="620" ry="330" fill="url(#graphBackdrop)" />
        <g opacity="0.15">
          {[0, 1, 2, 3].map((ring) => (
            <ellipse
              key={ring}
              cx={width / 2}
              cy={height / 2}
              rx={250 + ring * 135}
              ry={110 + ring * 78}
              fill="none"
              stroke="#3f3f46"
              strokeWidth="0.8"
              transform={`rotate(${ring * 7 - 10} ${width / 2} ${height / 2})`}
            />
          ))}
        </g>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {graph.edges.map((edge) => {
            const source = nodeById.get(edge.source);
            const target = nodeById.get(edge.target);
            if (!source || !target) return null;
            const start = getDisplayPoint(source);
            const end = getDisplayPoint(target);
            const active = highlightedIds.has(source.id) || highlightedIds.has(target.id);
            const stroke = active ? nodeGlowColor(source.type) : "#3f3f46";
            return (
              <path
                key={edge.id}
                d={edgeCurve(start, end)}
                fill="none"
                stroke={stroke}
                strokeLinecap="round"
                strokeWidth={active ? 2.1 : 0.82}
                opacity={active ? 0.76 : 0.2}
                filter={active ? "url(#graphEdgeGlow)" : undefined}
                className="transition-[opacity,stroke-width] duration-200"
              />
            );
          })}
          {[...graph.nodes]
            .sort((a, b) => getDisplayPoint(a).depth - getDisplayPoint(b).depth)
            .map((node) => {
            const point = getDisplayPoint(node);
            const active = highlightedIds.size === 0 || highlightedIds.has(node.id);
            const radius = nodeRadius(node) * point.scale;
            const color = nodeColor(node.type);
            const glow = nodeGlowColor(node.type);
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
                  cx={point.x + point.depth * 6}
                  cy={point.y + 9 + point.depth * 3}
                  r={radius * 1.18}
                  fill="#020617"
                  opacity={active ? 0.42 : 0.16}
                />
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={radius + 10}
                  fill={glow}
                  opacity={active ? 0.18 : 0.04}
                  filter="url(#graphNodeGlow)"
                />
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={radius}
                  fill={color}
                  opacity={active ? 0.96 : 0.26}
                  stroke={selectedNode?.id === node.id ? "#ffffff" : "rgba(255,255,255,0.22)"}
                  strokeWidth={selectedNode?.id === node.id ? 2.2 : 0.75}
                  filter={active ? "url(#graphNodeGlow)" : undefined}
                  className="transition-[opacity,stroke-width] duration-200"
                />
                <circle
                  cx={point.x - radius * 0.28}
                  cy={point.y - radius * 0.32}
                  r={Math.max(radius * 0.22, 2)}
                  fill="#ffffff"
                  opacity={active ? 0.55 : 0.14}
                />
                {selectedNode?.id === node.id && (
                  <>
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r={radius + 13}
                      fill="none"
                      stroke={glow}
                      strokeWidth={1.2}
                      opacity={0.7}
                      className="animate-pulse"
                    />
                    <text
                      x={point.x + 13}
                      y={point.y - 10}
                      fill="#f5f5f4"
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

      <div className="absolute left-5 top-5 max-w-xl rounded border border-border bg-background/80 shadow-2xl backdrop-blur-md">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-card text-muted-foreground">
            <GitBranch size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <p className="text-sm font-semibold text-foreground">Paper concept graph</p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {scopeLabel}
              </p>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {graph.stats?.paper_count ?? 0} papers · {graph.stats?.concept_count ?? 0} concepts ·{" "}
              {graph.stats?.edge_count ?? 0} edges
            </p>
          </div>
          <button
            type="button"
            onClick={resetViewport}
            title="Reset graph view"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-card text-muted-foreground hover:text-foreground"
          >
            <Maximize2 size={14} />
          </button>
        </div>
        {(error || status) && (
          <div className="border-t border-border px-3 py-2">
            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {status} · Drag canvas · wheel zoom · drag nodes
              </p>
            )}
          </div>
        )}
      </div>

      <aside className="absolute bottom-5 right-5 top-5 flex w-[360px] flex-col overflow-hidden rounded border border-border bg-card/95 shadow-2xl backdrop-blur">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Graph setup
              </p>
              <p className="mt-1 text-sm text-foreground">
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

        <button
          type="button"
          onClick={() => setShowPaperSet((value) => !value)}
          className="flex w-full items-center justify-between border-b border-border px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-secondary"
        >
          Choose papers
          <ChevronDown size={14} className={`transition-transform ${showPaperSet ? "rotate-180" : ""}`} />
        </button>

        {showPaperSet && (
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
        )}

        <button
          type="button"
          onClick={() => setShowGraphSearch((value) => !value)}
          className="flex w-full items-center justify-between border-b border-border px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-secondary"
        >
          Search graph
          <ChevronDown size={14} className={`transition-transform ${showGraphSearch ? "rotate-180" : ""}`} />
        </button>

        {showGraphSearch && (
          <div className="border-b border-border p-4">
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
        )}

        {showPaperSet && (
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
        )}

        <button
          type="button"
          onClick={() => setShowSelectionDetails((value) => !value)}
          className="flex w-full items-center justify-between border-b border-border px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-secondary"
        >
          Selection
          <ChevronDown size={14} className={`transition-transform ${showSelectionDetails ? "rotate-180" : ""}`} />
        </button>

        {showSelectionDetails && (
          <div className="border-b border-border p-4">
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
        )}

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

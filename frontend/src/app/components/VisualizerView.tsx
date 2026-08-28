import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import {
  AlertTriangle,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  GitBranch,
  Image as ImageIcon,
  Layers,
  Loader2,
  Maximize2,
  MessagesSquare,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";

import {
  applyModification,
  clearDiscussion,
  deleteVariant,
  deleteVisualization,
  discussChange,
  expandVisualizationNode,
  generateAlgorithmScene,
  generateVisualization,
  getAlgorithmScene,
  getArticles,
  getDiscussion,
  getMissingBackendRoutes,
  getPreparedStages,
  getVariantsForVisualization,
  getVisualizations,
  proposeModification,
  verifyTarget,
} from "../api";
import type {
  AlgorithmVariant,
  Article,
  DiscussionMessage,
  DiagramKind,
  DiagramNode,
  DiffState,
  NodeExpansion,
  PaperVisualization,
  ProcessStep,
  VariantProposal,
  VariantTreeRow,
  VerificationReportData,
} from "../types";
import {
  diffTint,
  edgeStroke,
  formatKind,
  nodeStroke,
  primitiveColor,
} from "./diagramPalette";
import { buildDiagramDiff, edgeKey } from "./diagramDiff";
import type { TheaterControl } from "./ProcessTheater";
import ScenePlayer from "./visualization/ScenePlayer";
import type { SceneRecord } from "./visualization/sceneTypes";
import { VariantChat } from "./VariantChat";
import { VariantPanel } from "./VariantPanel";
import { VerificationReport } from "./VerificationReport";
import { Visualizer3D } from "./Visualizer3D";

const NODE_W = 180;
const NODE_H = 48;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;

const KIND_OPTIONS: { value: "auto" | DiagramKind; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "architecture", label: "Architecture" },
  { value: "method_flow", label: "Method flow" },
  { value: "pipeline", label: "Pipeline" },
];

function wrapLabel(label: string, maxChars = 24): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length > 2) {
    const second = lines.slice(1).join(" ");
    return [lines[0], second.length > maxChars ? `${second.slice(0, maxChars - 1)}…` : second];
  }
  return lines;
}

function ExpansionSection({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  if (!children) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
        {title}
      </div>
      <p className="text-xs leading-relaxed text-zinc-300">{children}</p>
    </div>
  );
}

export function VisualizerView() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(true);
  const [articleQuery, setArticleQuery] = useState("");
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [kind, setKind] = useState<"auto" | DiagramKind>("auto");
  const [saved, setSaved] = useState<PaperVisualization[]>([]);
  const [viz, setViz] = useState<PaperVisualization | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<DiagramNode | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [playing3d, setPlaying3d] = useState(false);
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [preparedIds, setPreparedIds] = useState<Set<string>>(new Set());
  // Storyboards for every prepared stage, so each 3D chassis can be built from
  // the machinery the paper describes for that stage.
  const [storyboards, setStoryboards] = useState<Record<string, ProcessStep[]>>(
    {},
  );
  const [prepareDone, setPrepareDone] = useState<number | null>(null);
  const [prepareTotal, setPrepareTotal] = useState(0);
  const [expansion, setExpansion] = useState<NodeExpansion | null>(null);
  const [expansionLoading, setExpansionLoading] = useState(false);
  const [expansionError, setExpansionError] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  // --- variant lab -------------------------------------------------------
  const [variants, setVariants] = useState<AlgorithmVariant[]>([]);
  const [tree, setTree] = useState<VariantTreeRow[]>([]);
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [dockTab, setDockTab] = useState<
    "paper" | "modify" | "findings" | "discuss" | "scene"
  >("paper");
  // Evidence-grounded Scene IR for the current visualization. Loaded lazily and
  // kept separate from `viz` so the existing diagram, variants and findings are
  // untouched whether or not a scene exists.
  const [sceneRecord, setSceneRecord] = useState<SceneRecord | null>(null);
  const [sceneLoading, setSceneLoading] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [discussion, setDiscussion] = useState<DiscussionMessage[]>([]);

  // Fetch the stored scene when the Scene tab is opened. A 404 is the normal
  // "not generated yet" case, not an error worth showing.
  useEffect(() => {
    if (dockTab !== "scene" || !viz) return;
    let live = true;
    setSceneLoading(true);
    setSceneError(null);
    getAlgorithmScene(viz.viz_id)
      .then((response) => {
        if (live) setSceneRecord(response.scene);
      })
      .catch(() => {
        if (live) setSceneRecord(null);
      })
      .finally(() => {
        if (live) setSceneLoading(false);
      });
    return () => {
      live = false;
    };
  }, [dockTab, viz?.viz_id]);

  const requestScene = useCallback(
    async (force: boolean) => {
      if (!viz) return;
      setSceneLoading(true);
      setSceneError(null);
      try {
        const response = await generateAlgorithmScene({
          vizId: viz.viz_id,
          force,
          allowOfflineFallback: true,
        });
        setSceneRecord(response.scene);
      } catch (error) {
        setSceneError(
          error instanceof Error ? error.message : "Scene generation failed.",
        );
      } finally {
        setSceneLoading(false);
      }
    },
    [viz?.viz_id],
  );

  const [discussing, setDiscussing] = useState(false);
  const [discussError, setDiscussError] = useState<string | null>(null);
  const [staleRoutes, setStaleRoutes] = useState<string[]>([]);
  const [overlayMode, setOverlayMode] = useState<"none" | "diff">("none");
  const [dimUnchanged, setDimUnchanged] = useState(true);
  const [intent, setIntent] = useState("");
  const [baseVariantId, setBaseVariantId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<VariantProposal | null>(null);
  const [proposing, setProposing] = useState(false);
  const [proposeElapsed, setProposeElapsed] = useState(0);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [report, setReport] = useState<VerificationReportData | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [hoverOpTarget, setHoverOpTarget] = useState<string | null>(null);
  const [findingNodeIds, setFindingNodeIds] = useState<string[]>([]);

  const [viewMode, setViewMode] = useState<"2d" | "3d">("3d");
  const [fit3dCounter, setFit3dCounter] = useState(0);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvas3dRef = useRef<HTMLCanvasElement | null>(null);
  const activeNodeRef = useRef<string | null>(null);
  // Guards the paper-selection race: without it a slow getVisualizations for
  // paper A resolves after the user has moved to paper B and renders A's
  // diagram under B's name, which then poisons storyboards, chat and any
  // variant created from it.
  const selectionRef = useRef<string | null>(null);
  // Same idea one level down: which *diagram* (baseline or variant) is on
  // screen. Storyboards, variants, verdicts and transcripts are all scoped to
  // it, so each async write is checked against this before it lands.
  const diagramRef = useRef<string | null>(null);
  const theaterControlRef = useRef<TheaterControl>({
    paused: false,
    seekStep: null,
  });
  // The theater reads this every frame; opening the deep-dive popup pauses playback.
  theaterControlRef.current.paused = paused || popupOpen;
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setArticlesLoading(true);
    getArticles({ limit: 500 })
      .then((response) => {
        if (cancelled) return;
        setArticles(
          response.articles.filter((article) => article.status === "indexed"),
        );
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setArticlesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Detect a backend running older code, so a missing route reads as
  // "restart your backend" rather than a bare 404 on every button.
  useEffect(() => {
    let cancelled = false;
    getMissingBackendRoutes()
      .then((missing) => {
        if (!cancelled) setStaleRoutes(missing);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredArticles = useMemo(() => {
    const query = articleQuery.trim().toLowerCase();
    if (!query) return articles;
    return articles.filter((article) =>
      article.title.toLowerCase().includes(query),
    );
  }, [articles, articleQuery]);

  const nodeById = useMemo(() => {
    const map = new Map<string, DiagramNode>();
    for (const node of viz?.diagram.nodes ?? []) map.set(node.id, node);
    return map;
  }, [viz]);


  const activeVariant = activeVariantId
    ? variants.find((item) => item.variant_id === activeVariantId) ?? null
    : null;
  // Storyboards and expansions belong to whichever diagram is on screen.
  const activeDiagramId = activeVariant?.variant_id ?? viz?.viz_id ?? null;
  const parentDiagram = activeVariant
    ? variants.find(
        (item) => item.variant_id === activeVariant.parent_variant_id,
      )?.diagram ?? viz?.diagram ?? null
    : null;
  const variantDiagram = activeVariant?.diagram ?? viz?.diagram;
  const diff = useMemo(
    () =>
      activeVariant && parentDiagram
        ? buildDiagramDiff(parentDiagram, activeVariant.diagram)
        : null,
    [activeVariant, parentDiagram],
  );
  diagramRef.current = activeDiagramId;
  const showDiff = overlayMode === "diff" && diff !== null;
  const diagram = showDiff && diff ? diff.merged : variantDiagram;
  const highlightNodeIds = useMemo(
    () => (hoverOpTarget ? [hoverOpTarget] : findingNodeIds),
    [hoverOpTarget, findingNodeIds],
  );

  const fitView = useCallback(
    (target?: PaperVisualization | null) => {
      const diagram = (target ?? viz)?.diagram;
      const svg = svgRef.current;
      if (!diagram || !svg || diagram.nodes.length === 0) return;
      const xs = diagram.nodes.map((node) => node.x);
      const ys = diagram.nodes.map((node) => node.y);
      let minX = Math.min(...xs) - NODE_W / 2;
      let maxX = Math.max(...xs) + NODE_W / 2;
      let minY = Math.min(...ys) - NODE_H / 2;
      let maxY = Math.max(...ys) + NODE_H / 2;
      for (const group of diagram.groups) {
        minX = Math.min(minX, group.x);
        maxX = Math.max(maxX, group.x + group.w);
        minY = Math.min(minY, group.y);
        maxY = Math.max(maxY, group.y + group.h);
      }
      const rect = svg.getBoundingClientRect();
      const padding = 60;
      const scale = Math.min(
        MAX_SCALE,
        Math.max(
          MIN_SCALE,
          Math.min(
            (rect.width - padding * 2) / Math.max(maxX - minX, 1),
            (rect.height - padding * 2) / Math.max(maxY - minY, 1),
          ),
        ),
      );
      setViewport({
        x: rect.width / 2 - ((minX + maxX) / 2) * scale,
        y: rect.height / 2 - ((minY + maxY) / 2) * scale,
        scale,
      });
    },
    [viz],
  );

  const loadSaved = useCallback((article: Article) => {
    getVisualizations(article.article_id)
      .then((response) => {
        if (selectionRef.current !== article.article_id) return;
        setSaved(response.visualizations);
      })
      .catch(() => {
        if (selectionRef.current === article.article_id) setSaved([]);
      });
  }, []);

  function selectArticle(article: Article) {
    selectionRef.current = article.article_id;
    setSelectedArticle(article);
    closeNodePopup();
    setError(null);
    setViz(null);
    setSaved([]);
    setVariants([]);
    setTree([]);
    setActiveVariantId(null);
    setOverlayMode("none");
    setReport(null);
    setProposal(null);
    getVisualizations(article.article_id)
      .then((response) => {
        // Another paper was clicked while this was in flight.
        if (selectionRef.current !== article.article_id) return;
        setSaved(response.visualizations);
        if (response.visualizations.length > 0) {
          showVisualization(response.visualizations[0]);
        }
      })
      .catch((err: Error) => {
        if (selectionRef.current === article.article_id) setError(err.message);
      });
  }

  function showVisualization(record: PaperVisualization) {
    if (
      selectionRef.current !== null &&
      record.article_id !== selectionRef.current
    ) {
      console.warn(
        `refusing to show a diagram for ${record.article_id} while ${selectionRef.current} is selected`,
      );
      return;
    }
    setViz(record);
    closeNodePopup();
    // Fit after the SVG has the new content sized.
    requestAnimationFrame(() => fitView(record));
  }

  function closeNodePopup() {
    activeNodeRef.current = null;
    setSelectedNode(null);
    setPopupOpen(false);
    setPlaying3d(false);
    setTourIndex(null);
    setStepIndex(0);
    setPaused(false);
    theaterControlRef.current.seekStep = null;
    setExpansion(null);
    setExpansionLoading(false);
    setExpansionError(null);
  }

  function loadExpansion(node: DiagramNode) {
    if (!viz) return;
    const targetDiagramId = activeDiagramId;
    activeNodeRef.current = node.id;
    setExpansion(null);
    setExpansionError(null);
    setExpansionLoading(true);
    expandVisualizationNode({ vizId: activeDiagramId ?? viz.viz_id, nodeId: node.id })
      .then((response) => {
        // Ignore stale responses after the user clicked another node.
        if (diagramRef.current !== targetDiagramId) return;
        setPreparedIds((current) => new Set(current).add(node.id));
        const steps = response.expansion.content.process_steps;
        if (steps && steps.length > 0) {
          setStoryboards((current) => ({ ...current, [node.id]: steps }));
        }
        refreshViz();
        if (activeNodeRef.current !== node.id) return;
        setExpansion(response.expansion);
        setExpansionLoading(false);
      })
      .catch((err: Error) => {
        if (activeNodeRef.current !== node.id) return;
        setExpansionError(err.message);
        setExpansionLoading(false);
      });
  }

  function openNodePopup(node: DiagramNode) {
    if (!viz) return;
    setSelectedNode(node);
    setPopupOpen(true);
    setPlaying3d(false);
    if (diff?.ghostNodeIds.has(node.id)) {
      // Removed by this variant: there is nothing on the server to expand.
      activeNodeRef.current = null;
      setExpansion(null);
      setExpansionLoading(false);
      setExpansionError(null);
      return;
    }
    loadExpansion(node);
  }

  // Which stages already have a stored storyboard (so playback is instant).
  useEffect(() => {
    if (!viz) {
      setPreparedIds(new Set());
      setStoryboards({});
      return;
    }
    let cancelled = false;
    getPreparedStages(activeDiagramId ?? viz.viz_id)
      .then((response) => {
        if (cancelled) return;
        setPreparedIds(new Set(response.prepared));
        const next: Record<string, ProcessStep[]> = {};
        for (const expansion of response.expansions) {
          const steps = expansion.content.process_steps;
          if (steps && steps.length > 0) next[expansion.node_id] = steps;
        }
        setStoryboards(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [viz]);

  // The worked example is generated server-side on the first expansion, so
  // pull the record again once stages exist to pick it up.
  const refreshViz = useCallback(() => {
    if (!viz || viz.worked_example) return;
    getVisualizations(viz.article_id)
      .then((response) => {
        const fresh = response.visualizations.find(
          (item) => item.viz_id === viz.viz_id,
        );
        if (fresh?.worked_example) {
          setViz((current) =>
            current?.viz_id === fresh.viz_id ? fresh : current,
          );
          setSaved(response.visualizations);
        }
      })
      .catch(() => undefined);
  }, [viz]);

  const activePrimitives = useMemo(() => {
    const seen = new Map<string, number>();
    for (const steps of Object.values(storyboards)) {
      for (const step of steps) {
        if (step.primitive === "note") continue;
        seen.set(step.primitive, (seen.get(step.primitive) ?? 0) + 1);
      }
    }
    return [...seen.keys()].sort();
  }, [storyboards]);

  const unpreparedCount = viz
    ? (activeVariant?.diagram.nodes ?? viz.diagram.nodes).filter(
        (node) => !preparedIds.has(node.id),
      ).length
    : 0;

  const prepareAbortRef = useRef(false);
  const proposeAbortRef = useRef<AbortController | null>(null);

  const loadVariants = useCallback(
    (vizId: string) =>
      getVariantsForVisualization(vizId)
        .then((response) => {
          // A different paper may have been selected while this was in flight.
          if (selectionRef.current && response.variants[0]) {
            if (response.variants[0].article_id !== selectionRef.current) return;
          }
          setVariants(response.variants);
          setTree(response.tree);
        })
        .catch(() => undefined),
    [],
  );

  useEffect(() => {
    if (!viz) {
      setVariants([]);
      setTree([]);
      setActiveVariantId(null);
      setOverlayMode("none");
      setProposal(null);
      setReport(null);
      return;
    }
    void loadVariants(viz.viz_id);
  }, [viz, loadVariants]);

  // The conversation belongs to the diagram on screen, so switching variants
  // switches transcripts rather than mixing them.
  useEffect(() => {
    if (!activeDiagramId) {
      setDiscussion([]);
      return;
    }
    let cancelled = false;
    setDiscussError(null);
    getDiscussion(activeDiagramId)
      .then((response) => {
        if (!cancelled) setDiscussion(response.history);
      })
      .catch(() => {
        if (!cancelled) setDiscussion([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDiagramId]);

  // A 404 from these endpoints almost always means the backend predates the
  // code, not that something is genuinely missing.
  function explainError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (staleRoutes.length > 0 || /not found/i.test(message)) {
      return "The backend is running older code and does not have this endpoint yet. Restart it with restart-backend.ps1, then try again.";
    }
    return message;
  }

  async function handleDiscuss(message: string) {
    if (!activeDiagramId || discussing) return;
    setDiscussing(true);
    setDiscussError(null);
    // Show the question straight away rather than after the round trip.
    const pending: DiscussionMessage = {
      message_id: `pending-${Date.now()}`,
      target_id: activeDiagramId,
      role: "user",
      content: message,
      node_ids: [],
      suggestions: [],
      model: "",
      created_at: new Date().toISOString(),
    };
    setDiscussion((current) => [...current, pending]);
    try {
      const response = await discussChange({
        targetId: activeDiagramId,
        message,
      });
      if (diagramRef.current !== activeDiagramId) return;
      setDiscussion(response.history);
    } catch (err) {
      setDiscussion((current) =>
        current.filter((item) => item.message_id !== pending.message_id),
      );
      if (diagramRef.current !== activeDiagramId) return;
      setDiscussError(explainError(err));
    } finally {
      setDiscussing(false);
    }
  }

  async function handleClearDiscussion() {
    if (!activeDiagramId) return;
    try {
      await clearDiscussion(activeDiagramId);
      setDiscussion([]);
    } catch (err) {
      setDiscussError(err instanceof Error ? err.message : String(err));
    }
  }

  // Elapsed counter so a slow proposal never looks stuck.
  useEffect(() => {
    if (!proposing) return;
    setProposeElapsed(0);
    const timer = window.setInterval(
      () => setProposeElapsed((value) => value + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [proposing]);

  async function handlePropose() {
    const targetId = baseVariantId ?? activeVariantId ?? viz?.viz_id;
    if (!targetId || !intent.trim() || proposing) return;
    proposeAbortRef.current?.abort();
    const controller = new AbortController();
    proposeAbortRef.current = controller;
    setProposing(true);
    setProposeError(null);
    setProposal(null);
    try {
      const response = await proposeModification({
        targetId,
        intent: intent.trim(),
        signal: controller.signal,
      });
      setProposal(response.proposal);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setProposeError(explainError(err));
    } finally {
      setProposing(false);
    }
  }

  async function handleApply() {
    const targetId = proposal?.base.id;
    if (!proposal || !targetId || applying) return;
    // Applying takes a round trip; remember which paper asked for it.
    const forArticle = selectionRef.current;
    setApplying(true);
    setProposeError(null);
    try {
      const response = await applyModification({
        targetId,
        intent: proposal.intent,
        patch: proposal.patch,
      });
      const variant = response.variant;
      // The user moved to another paper mid-apply. The variant is saved
      // server-side and will appear when they come back; do not graft it onto
      // whatever is on screen now.
      if (selectionRef.current !== forArticle) return;
      setVariants((current) => [variant, ...current]);
      setActiveVariantId(variant.variant_id);
      setBaseVariantId(null);
      setProposal(null);
      setOverlayMode("diff");
      setReport(response.run.report ?? null);
      setDockTab("findings");
      closeNodePopup();
      if (viz) void loadVariants(viz.viz_id);
    } catch (err) {
      setProposeError(explainError(err));
    } finally {
      setApplying(false);
    }
  }

  async function handleVerify(targetId: string) {
    setVerifying(true);
    setVerifyError(null);
    try {
      const response = await verifyTarget(targetId);
      // Don't show a verdict for a diagram the user has navigated away from.
      if (diagramRef.current !== targetId) return;
      setReport(response.report);
      if (viz) void loadVariants(viz.viz_id);
    } catch (err) {
      setVerifyError(explainError(err));
    } finally {
      setVerifying(false);
    }
  }

  function handleSelectVariant(variantId: string | null) {
    setActiveVariantId(variantId);
    setOverlayMode(variantId ? "diff" : "none");
    setFindingNodeIds([]);
    closeNodePopup();
    const selected = variantId
      ? variants.find((item) => item.variant_id === variantId)
      : null;
    setReport(null);
    if (selected) void handleVerify(selected.variant_id);
  }

  async function handleDeleteVariant(variantId: string) {
    try {
      await deleteVariant(variantId);
      if (activeVariantId === variantId) handleSelectVariant(null);
      if (viz) void loadVariants(viz.viz_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function prepareAllStages() {
    if (!viz || prepareDone !== null) return;
    const nodes = activeVariant?.diagram.nodes ?? viz.diagram.nodes;
    const pending = nodes.filter((node) => !preparedIds.has(node.id));
    if (pending.length === 0) return;

    prepareAbortRef.current = false;
    const targetDiagramId = activeDiagramId;
    setPrepareTotal(pending.length);
    setPrepareDone(0);

    const CONCURRENCY = 3;
    let cursor = 0;
    let completed = 0;

    async function worker() {
      while (cursor < pending.length && !prepareAbortRef.current) {
        const node = pending[cursor++];
        try {
          const response = await expandVisualizationNode({
            vizId: targetDiagramId ?? viz.viz_id,
            nodeId: node.id,
          });
          // Storyboards are per-diagram; drop late arrivals for an old one.
          if (diagramRef.current !== targetDiagramId) return;
          setPreparedIds((current) => new Set(current).add(node.id));
          const steps = response.expansion.content.process_steps;
          if (steps && steps.length > 0) {
            setStoryboards((current) => ({ ...current, [node.id]: steps }));
          }
        } catch {
          // A failed stage stays unprepared; it retries on demand when played.
        }
        completed += 1;
        setPrepareDone(completed);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker),
    );
    setPrepareDone(null);
    setPrepareTotal(0);
    refreshViz();
  }

  useEffect(() => {
    return () => {
      prepareAbortRef.current = true;
    };
  }, []);

  const tourOrder = useMemo(() => {
    // The variant's real stages, never the diff's ghosts.
    const source = activeVariant?.diagram.nodes ?? viz?.diagram.nodes;
    if (!source) return [] as DiagramNode[];
    return [...source].sort((a, b) => a.layer - b.layer || a.x - b.x);
  }, [viz, activeVariant]);

  function focusAndPlay(node: DiagramNode, viaTourIndex: number | null = null) {
    if (!viz) return;
    setSelectedNode(node);
    setPopupOpen(false);
    setPlaying3d(true);
    setStepIndex(0);
    setPaused(false);
    theaterControlRef.current.seekStep = null;
    setTourIndex(viaTourIndex);
    loadExpansion(node);
    // Warm the server cache for the next stage while this one plays.
    if (viaTourIndex !== null && viaTourIndex + 1 < tourOrder.length) {
      expandVisualizationNode({
        vizId: activeDiagramId ?? viz.viz_id,
        nodeId: tourOrder[viaTourIndex + 1].id,
      }).catch(() => undefined);
    }
  }

  function handle3dNodeClick(node: DiagramNode) {
    const index = tourOrder.findIndex((item) => item.id === node.id);
    focusAndPlay(node, tourIndex !== null && index >= 0 ? index : null);
  }

  function startTour() {
    if (tourOrder.length === 0) return;
    focusAndPlay(tourOrder[0], 0);
  }

  function stepStage(direction: 1 | -1) {
    if (!selectedNode) return;
    const current = tourOrder.findIndex((item) => item.id === selectedNode.id);
    const next = current + direction;
    if (next < 0 || next >= tourOrder.length) return;
    focusAndPlay(tourOrder[next], tourIndex !== null ? next : null);
  }

  function handlePlaybackComplete() {
    if (tourIndex === null) return;
    const next = tourIndex + 1;
    if (next < tourOrder.length) {
      focusAndPlay(tourOrder[next], next);
    } else {
      closeNodePopup(); // tour finished
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (popupOpen) {
        setPopupOpen(false);
        if (!playing3d) closeNodePopup();
      } else {
        closeNodePopup();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popupOpen, playing3d]);

  // The paper-specific animation for the focused node, when one was composed.
  const processScene = useMemo(() => {
    if (!expansion || !selectedNode || expansion.node_id !== selectedNode.id) {
      return null;
    }
    return expansion.content.scene ?? null;
  }, [expansion, selectedNode]);

  // The fully dynamic tier: a parametric scene graph, preferred over the
  // actor scene by the renderer when present.
  const processGraph = useMemo(() => {
    if (!expansion || !selectedNode || expansion.node_id !== selectedNode.id) {
      return null;
    }
    return expansion.content.scene_graph ?? null;
  }, [expansion, selectedNode]);

  // Storyboard for the focused node; falls back to narrated substeps.
  const processSteps = useMemo(() => {
    if (!expansion || !selectedNode || expansion.node_id !== selectedNode.id) {
      return null;
    }
    const steps = expansion.content.process_steps ?? [];
    if (steps.length > 0) return steps;
    return expansion.content.substeps.map((substep) => ({
      primitive: "note",
      caption: `${substep.label}: ${substep.detail}`,
      items: [],
      values: [],
      count: 0,
      label_in: "",
      label_out: "",
      detail: "",
    }));
  }, [expansion, selectedNode]);

  // The SVG is unmounted while in 3D mode, so re-fit it when switching back.
  useEffect(() => {
    if (viewMode === "2d" && viz) {
      requestAnimationFrame(() => fitView());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  async function handleGenerate(force: boolean) {
    if (!selectedArticle || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const response = await generateVisualization({
        articleId: selectedArticle.article_id,
        diagramKind: kind,
        force,
      });
      showVisualization(response.visualization);
      loadSaved(selectedArticle);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function handleDelete(record: PaperVisualization) {
    const forArticle = selectionRef.current;
    try {
      await deleteVisualization(record.viz_id);
      if (selectionRef.current !== forArticle) return;
      setSaved((current) =>
        current.filter((item) => item.viz_id !== record.viz_id),
      );
      if (viz?.viz_id === record.viz_id) {
        setViz(null);
        closeNodePopup();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const pointX = event.clientX - rect.left;
    const pointY = event.clientY - rect.top;
    setViewport((current) => {
      const nextScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, current.scale * (event.deltaY > 0 ? 0.9 : 1.1)),
      );
      const ratio = nextScale / current.scale;
      return {
        x: pointX - (pointX - current.x) * ratio,
        y: pointY - (pointY - current.y) * ratio,
        scale: nextScale,
      };
    });
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setViewport((current) => ({
      ...current,
      x: drag.startX + (event.clientX - drag.startClientX),
      y: drag.startY + (event.clientY - drag.startClientY),
    }));
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }

  function edgePath(
    source: DiagramNode,
    target: DiagramNode,
    back: boolean,
  ): string {
    if (back) {
      // Route feedback edges around the side.
      const startX = source.x + NODE_W / 2;
      const startY = source.y;
      const endX = target.x + NODE_W / 2;
      const endY = target.y;
      const bulge = Math.max(startX, endX) + 90;
      return `M ${startX} ${startY} C ${bulge} ${startY}, ${bulge} ${endY}, ${endX} ${endY}`;
    }
    const startX = source.x;
    const startY = source.y + NODE_H / 2;
    const endX = target.x;
    const endY = target.y - NODE_H / 2;
    const bend = Math.max(24, (endY - startY) / 2);
    return `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`;
  }

  function exportSvg() {
    const svg = svgRef.current;
    if (!svg || !viz) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    clone.setAttribute("width", String(Math.round(rect.width)));
    clone.setAttribute("height", String(Math.round(rect.height)));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const markup = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
    triggerDownload(URL.createObjectURL(blob), `${exportName()}.svg`);
  }

  function exportPng() {
    if (!viz) return;
    if (viewMode === "3d") {
      const canvas = canvas3dRef.current;
      if (!canvas) return;
      canvas.toBlob((blob) => {
        if (blob) triggerDownload(URL.createObjectURL(blob), `${exportName()}.png`);
      }, "image/png");
      return;
    }
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    clone.setAttribute("width", String(Math.round(rect.width)));
    clone.setAttribute("height", String(Math.round(rect.height)));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const markup = new XMLSerializer().serializeToString(clone);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(rect.width * 2);
      canvas.height = Math.round(rect.height * 2);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#191919";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) triggerDownload(URL.createObjectURL(blob), `${exportName()}.png`);
      }, "image/png");
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  }

  function exportName(): string {
    return (viz?.algorithm_name || viz?.title || "diagram")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  function triggerDownload(url: string, filename: string) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }


  return (
    <div className="flex h-full min-h-0 flex-col bg-[#191919] text-zinc-200">
      {staleRoutes.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-800/70 bg-amber-950/60 px-4 py-2">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            Backend is running older code
          </span>
          <span className="text-xs text-amber-100/90">
            {staleRoutes.length} endpoint
            {staleRoutes.length === 1 ? "" : "s"} this view needs
            {staleRoutes.length === 1 ? " is" : " are"} missing, so those
            actions fail with <span className="font-mono">Not Found</span>.
          </span>
          <code className="rounded bg-black/50 px-2 py-0.5 font-mono text-[10px] text-amber-200">
            .\restart-backend.ps1
          </code>
          <span
            className="font-mono text-[9px] text-amber-200/50"
            title={staleRoutes.join("\n")}
          >
            {staleRoutes.join("  ")}
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      {/* Left rail: paper picker + controls */}
      <div className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Workflow className="h-4 w-4 text-teal-300" />
          <span className="text-sm font-medium">Algorithm Visualizer</span>
        </div>

        <div className="border-b border-zinc-800 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              value={articleQuery}
              onChange={(event) => setArticleQuery(event.target.value)}
              placeholder="Search papers…"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 py-1.5 pl-8 pr-2 text-xs text-zinc-200 placeholder:text-zinc-500 focus:border-teal-500/60 focus:outline-none"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {articlesLoading ? (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading papers…
            </div>
          ) : filteredArticles.length === 0 ? (
            <div className="px-4 py-3 text-xs text-zinc-500">
              No indexed papers found.
            </div>
          ) : (
            filteredArticles.map((article) => (
              <button
                key={article.article_id}
                onClick={() => selectArticle(article)}
                className={`block w-full border-b border-zinc-800/60 px-4 py-2.5 text-left text-xs leading-snug transition-colors ${
                  selectedArticle?.article_id === article.article_id
                    ? "bg-teal-500/10 text-teal-100"
                    : "text-zinc-300 hover:bg-zinc-800/60"
                }`}
              >
                <span className="line-clamp-2">{article.title}</span>
                <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-zinc-500">
                  {article.domain}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="border-t border-zinc-800 p-3">
          <label className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">
            Diagram kind
          </label>
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as "auto" | DiagramKind)
            }
            className="mb-2 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 focus:border-teal-500/60 focus:outline-none"
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              onClick={() => handleGenerate(false)}
              disabled={!selectedArticle || generating}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Workflow className="h-3.5 w-3.5" />
              )}
              Generate
            </button>
            <button
              onClick={() => handleGenerate(true)}
              disabled={!selectedArticle || generating || !viz}
              title="Regenerate (discard saved diagram)"
              className="flex items-center justify-center rounded-md border border-zinc-700 px-2.5 py-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          {saved.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                Saved diagrams
              </div>
              {saved.map((record) => (
                <div
                  key={record.viz_id}
                  className={`mb-1 flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                    viz?.viz_id === record.viz_id
                      ? "border-teal-500/50 bg-teal-500/10"
                      : "border-zinc-800 hover:bg-zinc-800/60"
                  }`}
                >
                  <button
                    onClick={() => showVisualization(record)}
                    className="flex-1 truncate text-left capitalize text-zinc-300"
                  >
                    {formatKind(record.diagram_kind)}
                  </button>
                  <button
                    onClick={() => handleDelete(record)}
                    title="Delete"
                    className="text-zinc-500 transition-colors hover:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div className="relative min-w-0 flex-1">
        {viz && diagram && viewMode === "3d" ? (
          <div className="absolute inset-0">
            <Visualizer3D
              key={`${activeDiagramId}-${viz.updated_at}-${fit3dCounter}-${overlayMode}`}
              diagram={diagram}
              selectedNodeId={selectedNode?.id ?? null}
              focusNodeId={playing3d ? selectedNode?.id ?? null : null}
              processSteps={playing3d ? processSteps : null}
              processScene={playing3d ? processScene : null}
              processGraph={playing3d ? processGraph : null}
              storyboards={storyboards}
              diffStates={showDiff ? (diff?.nodeState as Record<string, DiffState>) : undefined}
              edgeDiffStates={showDiff ? (diff?.edgeState as Record<string, DiffState>) : undefined}
              highlightNodeIds={highlightNodeIds}
              dimUnchanged={showDiff && dimUnchanged}
              loopPlayback={tourIndex === null}
              theaterControl={theaterControlRef}
              onNodeClick={handle3dNodeClick}
              onCanvasReady={(canvas) => {
                canvas3dRef.current = canvas;
              }}
              onPointerMissed={() => {
                if (playing3d && !popupOpen) closeNodePopup();
              }}
              onStepChange={setStepIndex}
              onPlaybackComplete={handlePlaybackComplete}
            />
          </div>
        ) : (
        <svg
          ref={svgRef}
          className={`h-full w-full touch-none ${
            dragRef.current ? "cursor-grabbing" : "cursor-grab"
          }`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <rect width="100%" height="100%" fill="#191919" />
          <defs>
            {(
              [
                ["viz-arrow", "#8b8b93"],
                ["viz-arrow-added", "#34d399"],
                ["viz-arrow-removed", "#fb7185"],
                ["viz-arrow-changed", "#fbbf24"],
              ] as const
            ).map(([id, fill]) => (
              <marker
                key={id}
                id={id}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={fill} />
              </marker>
            ))}
          </defs>
          <g
            transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}
          >
            {diagram?.groups.map((group) => (
              <g key={group.id}>
                <rect
                  x={group.x}
                  y={group.y}
                  width={group.w}
                  height={group.h}
                  rx={12}
                  fill="#27272a"
                  fillOpacity={0.45}
                  stroke="#3f3f46"
                  strokeDasharray="6 4"
                />
                <text
                  x={group.x + 12}
                  y={group.y + 19}
                  fontSize={12}
                  fill="#a1a1aa"
                  fontWeight={600}
                >
                  {group.label}
                  {group.repeat ? `  ·  ${group.repeat}` : ""}
                </text>
              </g>
            ))}

            {diagram?.edges.map((edge, index) => {
              const source = nodeById.get(edge.source);
              const target = nodeById.get(edge.target);
              if (!source || !target) return null;
              const edgeDiff = showDiff
                ? diff?.edgeState[edgeKey(edge)]
                : undefined;
              const stroke = diffTint(edgeDiff) ?? edgeStroke(edge.kind);
              const dashed =
                edge.kind === "feedback" ||
                edge.kind === "reference" ||
                edge.back ||
                edgeDiff === "removed";
              const path = edgePath(source, target, edge.back);
              const midX = (source.x + target.x) / 2;
              const midY = (source.y + target.y) / 2;
              return (
                <g key={`${edge.source}-${edge.target}-${index}`}>
                  <path
                    d={path}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={1.6}
                    strokeDasharray={dashed ? "6 4" : undefined}
                    markerEnd={`url(#viz-arrow${
                      edgeDiff && edgeDiff !== "unchanged" ? `-${edgeDiff}` : ""
                    })`}
                    opacity={
                      edgeDiff === "removed"
                        ? 0.32
                        : showDiff && edgeDiff === "unchanged" && dimUnchanged
                          ? 0.4
                          : 0.85
                    }
                  />
                  {edge.label && (
                    <text
                      x={edge.back ? Math.max(source.x, target.x) + NODE_W / 2 + 96 : midX + 8}
                      y={midY}
                      fontSize={10.5}
                      fill="#a1a1aa"
                    >
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}

            {diagram?.nodes.map((node) => {
              const nodeDiff = showDiff ? diff?.nodeState[node.id] : undefined;
              const tint = diffTint(nodeDiff);
              const ghost = nodeDiff === "removed";
              const stroke = tint ?? nodeStroke(node.kind);
              const isSelected = selectedNode?.id === node.id;
              const highlighted = highlightNodeIds.includes(node.id);
              const lines = wrapLabel(node.label);
              const pill = node.kind === "input" || node.kind === "output";
              const faded =
                showDiff && nodeDiff === "unchanged" && dimUnchanged ? 0.45 : 1;
              return (
                <g
                  key={node.id}
                  className="cursor-pointer"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => openNodePopup(node)}
                  opacity={faded}
                >
                  {(tint || highlighted) && (
                    <rect
                      x={node.x - NODE_W / 2 - 4}
                      y={node.y - NODE_H / 2 - 4}
                      width={NODE_W + 8}
                      height={NODE_H + 8}
                      rx={pill ? NODE_H / 2 + 4 : 12}
                      fill="none"
                      stroke={highlighted ? "#fbbf24" : (tint as string)}
                      strokeWidth={highlighted ? 2.4 : 2}
                      strokeDasharray={ghost ? "5 4" : undefined}
                    />
                  )}
                  <rect
                    x={node.x - NODE_W / 2}
                    y={node.y - NODE_H / 2}
                    width={NODE_W}
                    height={NODE_H}
                    rx={pill ? NODE_H / 2 : 8}
                    fill={ghost ? "#1f1f22" : isSelected ? "#134e4a" : "#27272a"}
                    stroke={stroke}
                    strokeWidth={isSelected ? 2.2 : 1.4}
                    strokeDasharray={ghost ? "5 4" : undefined}
                  />
                  {tint && (
                    <>
                      <circle
                        cx={node.x + NODE_W / 2 + 4}
                        cy={node.y - NODE_H / 2 - 4}
                        r={7}
                        fill="#18181b"
                        stroke={tint as string}
                        strokeWidth={1.2}
                      />
                      <text
                        x={node.x + NODE_W / 2 + 4}
                        y={node.y - NODE_H / 2 - 0.5}
                        fontSize={10}
                        textAnchor="middle"
                        fill={tint as string}
                      >
                        {nodeDiff === "added"
                          ? "+"
                          : nodeDiff === "removed"
                            ? "\u2212"
                            : "~"}
                      </text>
                    </>
                  )}
                  {lines.map((line, lineIndex) => (
                    <text
                      key={lineIndex}
                      x={node.x}
                      y={
                        node.y +
                        (lineIndex - (lines.length - 1) / 2) * 14 +
                        4
                      }
                      fontSize={12}
                      textAnchor="middle"
                      fill={ghost ? "#a1a1aa" : "#e4e4e7"}
                      textDecoration={ghost ? "line-through" : undefined}
                    >
                      {line}
                    </text>
                  ))}
                </g>
              );
            })}
          </g>
        </svg>
        )}

        {/* Canvas toolbar */}
        {viz && (
          <div className="absolute right-3 top-3 flex gap-1.5">
            {viewMode === "3d" && !playing3d && (
              <>
                {prepareDone !== null ? (
                  <div className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900/90 px-2.5 py-1.5 text-xs text-zinc-300">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-300" />
                    <span>
                      Preparing {prepareDone}/{prepareTotal}
                    </span>
                    <span className="h-1 w-16 overflow-hidden rounded-full bg-zinc-700">
                      <span
                        className="block h-full rounded-full bg-teal-400 transition-all"
                        style={{
                          width: `${prepareTotal ? (prepareDone / prepareTotal) * 100 : 0}%`,
                        }}
                      />
                    </span>
                  </div>
                ) : (
                  unpreparedCount > 0 && (
                    <button
                      onClick={() => void prepareAllStages()}
                      title="Generate every stage's storyboard now so the walkthrough never stalls"
                      className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900/90 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-teal-200"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Prepare all
                      <span className="text-[10px] text-zinc-500">
                        {viz.diagram.nodes.length - unpreparedCount}/
                        {viz.diagram.nodes.length}
                      </span>
                    </button>
                  )
                )}
                <button
                  onClick={startTour}
                  title="Play a guided walkthrough of every stage"
                  className="flex items-center gap-1.5 rounded-md border border-teal-700 bg-teal-600/20 px-2.5 py-1.5 text-xs font-medium text-teal-200 transition-colors hover:bg-teal-600/40"
                >
                  <Play className="h-3.5 w-3.5" />
                  Walkthrough
                </button>
              </>
            )}
            {diff && (
              <button
                onClick={() =>
                  setOverlayMode((current) => (current === "diff" ? "none" : "diff"))
                }
                title="Highlight what this variant changed"
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  showDiff
                    ? "border-teal-700 bg-teal-600/20 text-teal-200"
                    : "border-zinc-700 bg-zinc-900/90 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                Diff
              </button>
            )}
            <div className="flex overflow-hidden rounded-md border border-zinc-700 bg-zinc-900/90">
              {(["2d", "3d"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    if (mode !== viewMode) {
                      setViewMode(mode);
                      closeNodePopup();
                    }
                  }}
                  className={`px-2.5 py-1.5 text-xs font-medium uppercase transition-colors ${
                    viewMode === mode
                      ? "bg-teal-600 text-white"
                      : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <button
              onClick={() =>
                viewMode === "3d"
                  ? setFit3dCounter((count) => count + 1)
                  : fitView()
              }
              title={viewMode === "3d" ? "Reset camera" : "Fit to view"}
              className="rounded-md border border-zinc-700 bg-zinc-900/90 p-1.5 text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
            {viewMode === "2d" && (
              <button
                onClick={exportSvg}
                title="Download SVG"
                className="rounded-md border border-zinc-700 bg-zinc-900/90 p-1.5 text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                <Download className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={exportPng}
              title="Download PNG"
              className="rounded-md border border-zinc-700 bg-zinc-900/90 p-1.5 text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              <ImageIcon className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Status overlays */}
        {generating && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#191919]/70">
            <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-300">
              <Loader2 className="h-4 w-4 animate-spin text-teal-300" />
              Extracting algorithm structure…
            </div>
          </div>
        )}
        {!viz && !generating && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="max-w-sm text-center text-sm text-zinc-500">
              {selectedArticle
                ? "No diagram yet — click Generate to extract this paper's algorithm."
                : "Select a paper from the library to visualize its algorithm or architecture."}
            </div>
          </div>
        )}
        {error && (
          <div className="absolute bottom-3 left-3 right-3 rounded-md border border-red-900/60 bg-red-950/80 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        {/* Which diagram am I looking at, and what changed in it */}
        {viz && (activeVariant || tree.length > 0) && (
          <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/85 px-2 py-1 text-[11px] backdrop-blur-sm">
            <GitBranch className="h-3 w-3 text-zinc-500" />
            <button
              onClick={() => handleSelectVariant(null)}
              className={activeVariant ? "text-zinc-400 hover:text-zinc-200" : "text-teal-200"}
            >
              Original
            </button>
            {activeVariant && (
              <>
                <span className="text-zinc-600">/</span>
                <span className="max-w-[16rem] truncate text-teal-200">
                  {activeVariant.variant_title}
                </span>
              </>
            )}
            {showDiff && diff && (
              <>
                <span className="text-zinc-600">|</span>
                <span className="font-mono text-emerald-300">+{diff.counts.added}</span>
                <span className="font-mono text-amber-300">~{diff.counts.changed}</span>
                <span className="font-mono text-rose-300">-{diff.counts.removed}</span>
                <button
                  onClick={() => setDimUnchanged((value) => !value)}
                  title="Dim the stages this variant did not touch"
                  className={`ml-1 rounded px-1 font-mono text-[9px] ${
                    dimUnchanged ? "bg-teal-600/30 text-teal-200" : "text-zinc-500"
                  }`}
                >
                  dim
                </button>
              </>
            )}
          </div>
        )}

        {/* Key for the machinery colours, limited to what this paper uses */}
        {viewMode === "3d" && viz && !playing3d && activePrimitives.length > 0 && (
          <div className="pointer-events-none absolute bottom-4 left-4 max-w-[15rem] rounded-lg border border-zinc-800 bg-zinc-900/80 p-2.5 backdrop-blur-sm">
            <div className="mb-1.5 text-[9px] uppercase tracking-wide text-zinc-500">
              Machinery in this paper
            </div>
            <div className="flex flex-wrap gap-x-2.5 gap-y-1">
              {activePrimitives.map((primitive) => (
                <span
                  key={primitive}
                  className="flex items-center gap-1 text-[10px] text-zinc-400"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ backgroundColor: primitiveColor(primitive) }}
                  />
                  {formatKind(primitive)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Process playback caption bar */}
        {playing3d && selectedNode && viewMode === "3d" && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 w-full max-w-2xl -translate-x-1/2 px-4">
            <div className="pointer-events-auto rounded-xl border border-zinc-700 bg-zinc-900/95 px-4 py-3 shadow-2xl">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: nodeStroke(selectedNode.kind) }}
                  />
                  <span className="truncate text-xs font-semibold text-zinc-100">
                    {selectedNode.label}
                  </span>
                  {tourIndex !== null && (
                    <span className="shrink-0 text-[10px] text-zinc-500">
                      stage {tourIndex + 1}/{tourOrder.length}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => stepStage(-1)}
                    title="Previous stage"
                    className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setPaused((current) => !current)}
                    title={paused ? "Resume" : "Pause"}
                    className="rounded p-1 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-teal-300"
                  >
                    {paused ? (
                      <Play className="h-3.5 w-3.5" />
                    ) : (
                      <Pause className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => {
                      theaterControlRef.current.seekStep = 0;
                      setStepIndex(0);
                      setPaused(false);
                    }}
                    title="Replay this stage"
                    className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => stepStage(1)}
                    title="Next stage"
                    className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setPopupOpen(true)}
                    title="Read the full deep dive"
                    className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-teal-300"
                  >
                    <BookOpen className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={closeNodePopup}
                    title="Exit playback"
                    className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {expansionLoading ? (
                <div className="flex items-center gap-2 py-1 text-xs text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-300" />
                  Reading the paper to storyboard this stage…
                </div>
              ) : expansionError ? (
                <div className="py-1 text-xs text-red-300">{expansionError}</div>
              ) : processSteps && processSteps.length > 0 ? (
                <>
                  <p className="text-xs leading-relaxed text-zinc-300">
                    {processSteps[Math.min(stepIndex, processSteps.length - 1)]
                      ?.caption ?? ""}
                  </p>
                  {processSteps[Math.min(stepIndex, processSteps.length - 1)]
                    ?.detail && (
                    <p className="mt-0.5 font-mono text-[11px] text-amber-200/80">
                      {
                        processSteps[
                          Math.min(stepIndex, processSteps.length - 1)
                        ].detail
                      }
                    </p>
                  )}
                  {viz.worked_example?.input_text && (
                    <p className="mt-1 truncate text-[10px] text-zinc-500">
                      following:{" "}
                      <span className="font-mono text-zinc-400">
                        {viz.worked_example.input_text}
                      </span>
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-1">
                    {processSteps.map((step, index) => (
                      <button
                        key={index}
                        onClick={() => {
                          theaterControlRef.current.seekStep = index;
                          setStepIndex(index);
                        }}
                        title={step.caption}
                        className={`h-1.5 rounded-full transition-all hover:bg-teal-300 ${
                          index === stepIndex
                            ? "w-5 bg-teal-400"
                            : "w-2.5 bg-zinc-700"
                        }`}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        )}

        {/* Node deep-dive popup */}
        {selectedNode && popupOpen && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6"
            onClick={() => {
              setPopupOpen(false);
              if (!playing3d) closeNodePopup();
            }}
          >
            <div
              className="flex max-h-full w-full max-w-xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: nodeStroke(selectedNode.kind) }}
                    />
                    <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                      {formatKind(selectedNode.kind)}
                      {selectedNode.group ? ` · ${selectedNode.group}` : ""}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-zinc-100">
                    {selectedNode.label}
                  </h3>
                </div>
                <button
                  onClick={() => {
                    setPopupOpen(false);
                    if (!playing3d) closeNodePopup();
                  }}
                  title="Close"
                  className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {selectedNode.detail && (
                  <p className="mb-4 text-xs italic leading-relaxed text-zinc-400">
                    {selectedNode.detail}
                  </p>
                )}

                {diff?.ghostNodeIds.has(selectedNode.id) && (
                  <div className="mb-3 rounded-md border border-rose-900/60 bg-rose-950/30 p-2.5">
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-rose-300">
                      Removed by this variant
                    </div>
                    <p className="text-xs leading-relaxed text-zinc-400">
                      {activeVariant?.patch.ops.find(
                        (op) => op.node_id === selectedNode.id,
                      )?.intent ??
                        "This stage is not part of the variant. It is shown here so you can see what the modification took out."}
                    </p>
                  </div>
                )}

                {expansionLoading ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-zinc-400">
                    <Loader2 className="h-4 w-4 animate-spin text-teal-300" />
                    Reading the paper for a deep dive…
                  </div>
                ) : expansionError ? (
                  <div className="rounded-md border border-red-900/60 bg-red-950/60 px-3 py-2 text-xs text-red-300">
                    {expansionError}
                  </div>
                ) : expansion ? (
                  <div className="space-y-4">
                    <ExpansionSection title="What it is">
                      {expansion.content.overview}
                    </ExpansionSection>
                    <ExpansionSection title="How it works">
                      {expansion.content.mechanism}
                    </ExpansionSection>
                    <ExpansionSection title="Role in the pipeline">
                      {expansion.content.role}
                    </ExpansionSection>

                    {expansion.content.substeps.length > 0 && (
                      <div>
                        <div className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">
                          Inside this step
                        </div>
                        <div className="ml-2 space-y-3 border-l border-zinc-700 pl-5">
                          {expansion.content.substeps.map((step, index) => (
                            <div key={index} className="relative">
                              <span className="absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full border border-teal-500/60 bg-zinc-900 text-[10px] font-medium text-teal-300">
                                {index + 1}
                              </span>
                              <div className="text-xs font-medium text-zinc-200">
                                {step.label}
                              </div>
                              <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
                                {step.detail}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {expansion.content.example && (
                      <div className="rounded-md border border-teal-900/60 bg-teal-950/40 p-3">
                        <div className="mb-1 text-[10px] uppercase tracking-wide text-teal-400">
                          Intuition
                        </div>
                        <p className="text-xs leading-relaxed text-teal-100/90">
                          {expansion.content.example}
                        </p>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right dock: paper summary, modification, findings */}
      <div
        className={`flex shrink-0 flex-col border-l border-zinc-800 ${
          dockTab === "findings" || dockTab === "discuss" || dockTab === "scene"
            ? "w-[26rem]"
            : "w-80"
        }`}
      >
        <div className="flex shrink-0 border-b border-zinc-800">
          {(
            [
              ["paper", "Paper"],
              ["scene", "Scene"],
              ["modify", "Modify"],
              ["findings", "Findings"],
              ["discuss", "Discuss"],
            ] as const
          ).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setDockTab(tab)}
              disabled={!viz}
              className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors disabled:opacity-40 ${
                dockTab === tab
                  ? "border-b-2 border-teal-500 text-teal-200"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab === "modify" ? <GitBranch className="h-3.5 w-3.5" /> : null}
              {tab === "findings" ? <ShieldCheck className="h-3.5 w-3.5" /> : null}
              {tab === "discuss" ? (
                <MessagesSquare className="h-3.5 w-3.5" />
              ) : null}
              {label}
              {tab === "findings" &&
                report &&
                report.findings.filter((f) => !f.inherited).length > 0 && (
                  <span className="rounded bg-zinc-800 px-1 font-mono text-[9px] text-zinc-300">
                    {report.findings.filter((f) => !f.inherited).length}
                  </span>
                )}
              {tab === "discuss" && discussion.length > 0 && (
                <span className="rounded bg-zinc-800 px-1 font-mono text-[9px] text-zinc-300">
                  {discussion.filter((m) => m.role === "user").length}
                </span>
              )}
            </button>
          ))}
        </div>

        {dockTab === "scene" && viz && (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                  algorithm scene
                </div>
                <div className="truncate text-sm font-medium text-zinc-200">
                  {sceneRecord?.scene.algorithm_name || "Not generated yet"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => requestScene(Boolean(sceneRecord))}
                disabled={sceneLoading}
                className="ml-auto shrink-0 rounded border border-teal-600 bg-teal-600/20 px-2 py-1 text-xs text-teal-200 disabled:opacity-50"
              >
                {sceneLoading
                  ? "Working..."
                  : sceneRecord
                    ? "Regenerate"
                    : "Generate scene"}
              </button>
            </div>

            {sceneRecord ? (
              <p className="font-mono text-[10px] text-zinc-500">
                {sceneRecord.provider || "unknown"} / {sceneRecord.model || "unknown"}
                {sceneRecord.extraction_strategy
                  ? ` · ${sceneRecord.extraction_strategy}`
                  : ""}
              </p>
            ) : null}

            {sceneError ? (
              <p className="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-[11px] leading-snug text-red-200">
                {sceneError}
              </p>
            ) : null}

            {sceneRecord ? (
              <ScenePlayer
                sceneInput={sceneRecord.scene}
                verification={sceneRecord.verification}
                className="min-h-[26rem] flex-1"
              />
            ) : (
              <p className="text-[11px] leading-snug text-zinc-500">
                Generate an evidence-grounded scene to step through this
                method&apos;s mechanism. Every entity and step is traced back to a
                passage in the paper, or marked uncertain.
              </p>
            )}
          </div>
        )}

        {dockTab === "modify" && viz && (
          <VariantPanel
            baseLabel={
              (baseVariantId
                ? variants.find((v) => v.variant_id === baseVariantId)?.variant_title
                : activeVariant?.variant_title) ?? "the original"
            }
            intent={intent}
            onIntentChange={setIntent}
            proposing={proposing}
            proposeElapsed={proposeElapsed}
            proposeError={proposeError}
            proposal={proposal}
            applying={applying}
            variants={variants}
            tree={tree}
            activeVariantId={activeVariantId}
            onPropose={() => void handlePropose()}
            onCancelPropose={() => proposeAbortRef.current?.abort()}
            onApply={() => void handleApply()}
            onDiscard={() => setProposal(null)}
            onSelectVariant={handleSelectVariant}
            onBranchFrom={(id) => {
              setBaseVariantId(id);
              setProposal(null);
              setDockTab("modify");
            }}
            onDeleteVariant={(id) => void handleDeleteVariant(id)}
            onHoverOpTarget={setHoverOpTarget}
          />
        )}

        {dockTab === "discuss" && viz && (
          <VariantChat
            targetLabel={
              activeVariant?.variant_title ?? viz.algorithm_name ?? viz.title
            }
            isVariant={activeVariant !== null}
            history={discussion}
            loading={discussing}
            error={discussError}
            onSend={(message) => void handleDiscuss(message)}
            onClear={() => void handleClearDiscussion()}
            onFocusNodes={(nodeIds) => {
              setFindingNodeIds(nodeIds);
              setDimUnchanged(false);
            }}
          />
        )}

        {dockTab === "findings" && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <VerificationReport
              report={report}
              loading={verifying}
              error={verifyError}
              onReverify={() =>
                activeDiagramId ? void handleVerify(activeDiagramId) : undefined
              }
              onFocusNodes={(nodeIds) => {
                setFindingNodeIds(nodeIds);
                setDimUnchanged(false);
              }}
            />
          </div>
        )}

        <div
          className={`min-h-0 flex-1 overflow-y-auto p-4 ${
            dockTab === "paper" ? "" : "hidden"
          }`}
        >
        {viz ? (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
              {formatKind(viz.diagram_kind)}
            </div>
            <h3 className="mb-1 text-sm font-semibold text-zinc-100">
              {viz.algorithm_name || viz.title}
            </h3>
            <p className="mb-3 text-xs leading-relaxed text-zinc-400">
              {viz.summary}
            </p>
            {viz.key_insight && (
              <div className="mb-3 rounded-md border border-teal-900/60 bg-teal-950/40 p-2.5">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-teal-400">
                  Key insight
                </div>
                <p className="text-xs leading-relaxed text-teal-100/90">
                  {viz.key_insight}
                </p>
              </div>
            )}
            {viz.worked_example?.input_text && (
              <div className="mb-3 rounded-md border border-zinc-700 bg-zinc-800/40 p-2.5">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                  Worked example
                </div>
                <p className="font-mono text-xs text-zinc-200">
                  {viz.worked_example.input_text}
                </p>
                {viz.worked_example.tokens.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {viz.worked_example.tokens.map((token, index) => (
                      <span
                        key={index}
                        className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-teal-200/90"
                      >
                        {token}
                      </span>
                    ))}
                  </div>
                )}
                {viz.worked_example.output_text && (
                  <p className="mt-1.5 text-[11px] text-zinc-400">
                    → {viz.worked_example.output_text}
                  </p>
                )}
                {viz.worked_example.dimension && (
                  <p className="mt-1 font-mono text-[10px] text-amber-200/70">
                    {viz.worked_example.dimension}
                  </p>
                )}
              </div>
            )}
            <div className="text-[10px] text-zinc-600">
              {viz.diagram.nodes.length} nodes · {viz.diagram.edges.length} edges
              {viz.model ? ` · ${viz.model}` : ""}
              <br />
              Generated {new Date(viz.updated_at).toLocaleString()}
            </div>
            <div className="mt-3 text-[11px] text-zinc-500">
              Click a node to see how it works.
            </div>
          </div>
        ) : (
          <div className="text-xs text-zinc-500">
            The visualizer identifies the paper's core algorithm or
            architecture, extracts it into a structured graph, and renders it
            as an interactive diagram.
          </div>
        )}
        </div>
      </div>
      </div>
    </div>
  );
}

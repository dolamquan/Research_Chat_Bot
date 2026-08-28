export type ChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type Source = {
  id?: string | number;
  text?: string;
  source?: string;
  article_id?: string;
  title?: string;
  url?: string;
  domain?: string;
  category?: string;
  tags?: string[];
  score?: number;
  rerank_score?: number;
  topic?: string;
  document_type?: string;
  section_type?: string;
  keywords?: string[];
  summary?: string;
  page?: number;
  selection?: boolean;
  asset_id?: string;
  image_url?: string;
  image_path?: string;
  [key: string]: unknown;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  pinnedSources?: Source[];
  toolTrace?: AgentToolTrace[];
  timestamp: Date;
};

export type Cluster = {
  cluster_id: number;
  cluster_label: string;
  document_count: number;
};

export type ClusterDocument = {
  document_id?: string;
  article_id?: string;
  title?: string;
  url?: string;
  domain?: string;
  category?: string;
  tags?: string[];
  source: string;
  chunk_count: number;
  cluster_id: number;
  cluster_label: string;
  x: number;
  y: number;
};

export type ClusterGraph = {
  clusters: Cluster[];
  documents: ClusterDocument[];
  scope?: {
    domain?: string | null;
    category?: string | null;
    article_ids?: string[];
  };
  stale?: boolean;
};

export type GraphRagNode = {
  id: string;
  type: "paper" | "concept" | "domain" | "category" | string;
  label: string;
  weight?: number;
  x: number;
  y: number;
  article_id?: string;
  source?: string;
  url?: string;
  domain?: string;
  category?: string;
  tags?: string[];
  abstract?: string;
};

export type GraphRagEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight?: number;
};

export type GraphRagGraph = {
  nodes: GraphRagNode[];
  edges: GraphRagEdge[];
  scope?: {
    domain?: string | null;
    category?: string | null;
  };
  stats?: {
    paper_count: number;
    concept_count: number;
    edge_count: number;
  };
  stale?: boolean;
};

export type GraphRagQueryResponse = {
  answer: string;
  nodes: GraphRagNode[];
  edges: GraphRagEdge[];
  papers: GraphRagNode[];
  concepts: GraphRagNode[];
};

export type GraphRagNeighborsResponse = GraphRagQueryResponse & {
  node?: GraphRagNode | null;
};

export type GraphRagPathResponse = GraphRagQueryResponse & {
  path: string[];
  shared_concepts: GraphRagNode[];
};

export type EvaluationMetrics = Record<string, number | null | undefined>;

export type EvaluationCase = {
  id: string;
  question: string;
  answer: string;
  expected_answer: string;
  latency_seconds: number;
  source_count: number;
  metrics: EvaluationMetrics;
  overall?: number | null;
  feedback?: string;
};

export type EvaluationRun = {
  run_id: string;
  filename: string;
  kind: "ragas" | "llm_judge" | string;
  created_at: string;
  case_count: number;
  average_latency_seconds: number;
  average_source_count?: number | null;
  metrics: EvaluationMetrics;
  overall?: number | null;
  cases?: EvaluationCase[];
};

export type EvaluationRunsResponse = {
  runs: EvaluationRun[];
  latest?: EvaluationRun | null;
};

export type EvaluationRunPayload = {
  retrieval_limit?: number;
  context_limit?: number;
  use_reranking?: boolean;
  parallel_reranking?: boolean;
  rerank_workers?: number;
};

export type DocumentDetail = ClusterDocument & {
  preview_chunks?: Source[];
};

export type Article = {
  article_id: string;
  title: string;
  source: string;
  url?: string;
  pdf_url?: string;
  domain: string;
  category: string;
  tags: string[];
  abstract?: string;
  authors?: string[];
  published_at?: string;
  updated_at_source?: string;
  status: "indexed" | "failed" | string;
  error?: string | null;
  created_at: string;
  updated_at: string;
};

export type IngestUrlPayload = {
  url: string;
  title?: string;
  domain?: string;
  category?: string;
  tags?: string[];
};

export type IngestUrlResponse = {
  status: string;
  job: IngestionJob;
  article?: Article;
  pdf_path?: string;
  pdf_url?: string;
};

export type IngestionJob = {
  job_id: string;
  url: string;
  title?: string;
  domain: string;
  category: string;
  tags: string[];
  status: "queued" | "running" | "indexed" | "failed" | string;
  stage: string;
  message: string;
  article_id?: string | null;
  article_title?: string | null;
  source?: string | null;
  pdf_url?: string | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

export type Annotation = {
  annotation_id: string;
  source: string;
  article_id?: string | null;
  title?: string | null;
  page: number;
  selected_text: string;
  note: string;
  created_at: string;
  updated_at: string;
};

export type AnnotationPayload = {
  source: string;
  page: number;
  selected_text: string;
  note?: string;
  article_id?: string;
  title?: string;
};

export type PaperSearchPaper = {
  paper_id?: string;
  arxiv_id: string;
  source_provider?: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  published_at: string;
  updated_at: string;
  url: string;
  pdf_url?: string;
  doi?: string;
  venue?: string;
};

export type ArxivPaper = PaperSearchPaper;

export type PaperSearchPayload = {
  description: string;
  max_results?: number;
  category?: string;
  sources?: string[];
  sort_by?: "relevance" | "newest" | "last_updated";
};

export type PaperSearchResponse = {
  provider?: string;
  query: string;
  sources?: string[];
  warning?: string;
  papers: PaperSearchPaper[];
};

export type ArxivSearchPayload = PaperSearchPayload;
export type ArxivSearchResponse = PaperSearchResponse;

export type VisualAsset = {
  asset_id: string;
  source: string;
  article_id?: string | null;
  title?: string | null;
  page?: number | null;
  image_path: string;
  image_url: string;
  caption: string;
  asset_type: "pdf_image" | "uploaded_image" | string;
  created_at: string;
  updated_at: string;
};

export type ArticleDomain = {
  domain: string;
  category: string;
  article_count: number;
};

export type ChatResponse = {
  session_id: string;
  answer: string;
  sources: Source[];
  intent?: string;
  topology?: ClusterGraph | null;
  tool_trace?: AgentToolTrace[];
  retrieval_strategy?: RetrievalStrategy | "whole_document" | "formula_extraction" | "formula_visual";
};

export type AgentToolTrace = {
  tool: string;
  status: "success" | "error" | "skipped" | string;
  message: string;
  timestamp: string;
};

export type McpTool = {
  server: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type McpToolsResponse = {
  server: string;
  tools: McpTool[];
};

export type McpCallResponse = {
  status: string;
  server: string;
  tool_name: string;
  result: Record<string, unknown>;
};

export type ContextMode = "retrieval" | "whole_document";
export type RetrievalStrategy = "vector" | "graph" | "hybrid";

export type ChatSession = {
  id: string;
  title: string;
  cluster_id?: number | null;
  document_source?: string | null;
  context_mode: ContextMode;
  created_at: string;
  updated_at: string;
};

export type StoredChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  pinned_sources?: Source[];
  pinnedSources?: Source[];
  created_at: string;
};

export type ChatSessionDetail = {
  session: ChatSession;
  messages: StoredChatMessage[];
};

export type AgentSession = ChatSession;

export type StoredAgentMessage = StoredChatMessage & {
  intent?: string | null;
  tool_trace?: AgentToolTrace[];
};

export type AgentSessionDetail = {
  session: AgentSession;
  messages: StoredAgentMessage[];
};

export type DiagramKind = "architecture" | "method_flow" | "pipeline";

export type DiagramNodeKind =
  | "input"
  | "output"
  | "operation"
  | "component"
  | "data"
  | "decision"
  | "loop"
  | "state";

export type DiagramEdgeKind =
  | "flow"
  | "data"
  | "residual"
  | "attention"
  | "feedback"
  | "reference";

export type DiagramNode = {
  id: string;
  label: string;
  kind: DiagramNodeKind | string;
  detail: string;
  group: string | null;
  x: number;
  y: number;
  layer: number;
};

export type DiagramEdge = {
  source: string;
  target: string;
  label: string;
  kind: DiagramEdgeKind | string;
  back: boolean;
};

export type DiagramGroup = {
  id: string;
  label: string;
  repeat: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Diagram = {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
};

export type PaperVisualization = {
  viz_id: string;
  article_id: string;
  document_source: string;
  diagram_kind: DiagramKind | string;
  title: string;
  algorithm_name: string;
  diagram: Diagram;
  summary: string;
  key_insight: string;
  worked_example?: WorkedExample | null;
  model: string;
  source_count: number;
  created_at: string;
  updated_at: string;
};

export type ExpansionStep = {
  label: string;
  detail: string;
};

export type NodeExpansion = {
  expansion_id: string;
  viz_id: string;
  node_id: string;
  node_label: string;
  content: {
    overview: string;
    mechanism: string;
    role: string;
    substeps: ExpansionStep[];
    example: string;
    process_steps?: ProcessStep[];
    /** Absent on expansions generated before the scene composer existed. */
    scene?: MechanismScene | null;
    /** Absent on expansions generated before the scene-graph tier existed. */
    scene_graph?: MechanismGraph | null;
  };
  model: string;
  created_at: string;
  updated_at: string;
};

export type ProcessPrimitive =
  | "token_stream"
  | "vector_array"
  | "matrix_transform"
  | "attention_links"
  | "split_parallel"
  | "merge_parallel"
  | "elementwise_combine"
  | "nonlinearity"
  | "normalize"
  | "distribution"
  | "filter_select"
  | "compare"
  | "loop_repeat"
  | "note";

export type ProcessStep = {
  primitive: ProcessPrimitive | string;
  caption: string;
  items: string[];
  values?: number[];
  count: number;
  label_in: string;
  label_out: string;
  detail: string;
};

/**
 * A stage animation described as data. The backend composes one of these per
 * paper stage; `SceneStage` interprets any of them without knowing the domain.
 */
export type ActorForm =
  | "particles"
  | "strand"
  | "array"
  | "lattice"
  | "blob"
  | "field"
  | "vessel"
  | "beam"
  | "marker";

export type ActorTone =
  | "primary"
  | "secondary"
  | "signal"
  | "inhibitor"
  | "substrate"
  | "product"
  | "neutral";

export type BehaviorKind =
  | "enter"
  | "travel"
  | "bind"
  | "correspond"
  | "split"
  | "merge"
  | "spread_along"
  | "accumulate"
  | "deplete"
  | "oscillate"
  | "transform"
  | "amplify"
  | "threshold"
  | "scatter"
  | "exit";

export type SceneSlot =
  | "left"
  | "center"
  | "right"
  | "upper"
  | "lower"
  | "front"
  | "back"
  | "offstage"
  | "same";

export type SceneActor = {
  actor_id: string;
  label: string;
  form: ActorForm | string;
  tone: ActorTone | string;
  count: number;
  at: SceneSlot | string;
  note: string;
  /** Absent on scenes stored before actors carried unit names. */
  items?: string[];
  /** Absent on scenes stored before actors carried real magnitudes. */
  values?: number[];
};

export type SceneBeat = {
  start: number;
  duration: number;
  kind: BehaviorKind | string;
  actor_id: string;
  target_id: string;
  to: SceneSlot | string;
  magnitude: number;
  caption: string;
  /** Absent on scenes stored before `correspond`; [] means uniform. */
  weights?: number[];
};

export type MechanismScene = {
  title: string;
  summary: string;
  actors: SceneActor[];
  beats: SceneBeat[];
  evidence: string;
  described: boolean;
};

/**
 * The fully dynamic tier: a parametric scene graph composed freely by the
 * model from geometry primitives and keyframe tracks. `SceneGraphStage`
 * interprets any of these; nothing in it is executable.
 */
export type GraphGeometry =
  | "box"
  | "sphere"
  | "cylinder"
  | "cone"
  | "torus"
  | "plane"
  | "ring"
  | "capsule";

export type GraphLayout =
  | "single"
  | "row"
  | "column"
  | "ring"
  | "grid"
  | "arc";

export type GraphTrackProp =
  | "position_x"
  | "position_y"
  | "position_z"
  | "rotation_y"
  | "rotation_z"
  | "scale"
  | "opacity"
  | "emissive"
  | "progress";

export type GraphEasing = "linear" | "ease_in_out" | "pulse";

export type SceneGraphNode = {
  node_id: string;
  parent_id: string;
  label: string;
  geometry: GraphGeometry | string;
  size?: number[];
  tone: ActorTone | string;
  opacity: number;
  emissive: number;
  position?: number[];
  rotation_deg?: number[];
  count: number;
  layout: GraphLayout | string;
  spacing: number;
  values?: number[];
  items?: string[];
};

export type SceneGraphTrack = {
  node_id: string;
  prop: GraphTrackProp | string;
  times?: number[];
  keys?: number[];
  easing: GraphEasing | string;
};

export type MechanismGraph = {
  title: string;
  summary: string;
  caption: string;
  nodes: SceneGraphNode[];
  tracks: SceneGraphTrack[];
  evidence: string;
  described: boolean;
  graph_schema_version?: number;
};

export type WorkedExample = {
  input_text: string;
  tokens: string[];
  dimension: string;
  output_text: string;
  note: string;
};

// ---------------------------------------------------------------- variants

export type PatchOpKind =
  | "add_node"
  | "remove_node"
  | "update_node"
  | "add_edge"
  | "remove_edge"
  | "rewire_edge"
  | "update_group"
  | "update_meta";

export type RawOp = {
  op: PatchOpKind;
  intent: string;
  node_id: string;
  label: string;
  kind: string;
  detail: string;
  group: string;
  source: string;
  target: string;
  edge_label: string;
  edge_kind: string;
  new_source: string;
  new_target: string;
  reconnect: string;
  group_label: string;
  repeat: string;
  create_group: boolean;
  title: string;
  algorithm_name: string;
  summary: string;
  key_insight: string;
};

export type ModificationPatch = {
  variant_title: string;
  rationale: string;
  expected_effect: string;
  risks: string;
  ops: RawOp[];
};

export type AppliedOp = {
  index: number;
  op: RawOp;
  summary: string;
  node_ids: string[];
  edge_keys: string[];
  derived_edges: string[];
  reversible: boolean;
  inverse_ops: RawOp[];
};

export type RejectedOp = {
  index: number;
  op: RawOp;
  reason: string;
  redundant: boolean;
};

export type FindingSeverity = "blocking" | "major" | "minor" | "speculative";
export type FindingBasis =
  | "deterministic"
  | "model_judgment"
  | "external_evidence";
export type VerificationVerdict =
  | "structurally_sound"
  | "concerns"
  | "likely_broken";

export type VerificationFinding = {
  finding_id: string;
  layer: "L0" | "L1" | "L2" | "L3";
  basis: FindingBasis;
  category: string;
  severity: FindingSeverity;
  confidence: "low" | "medium" | "high";
  title: string;
  failure_scenario: string;
  node_ids: string[];
  edge_keys: string[];
  invariant_id?: string | null;
  critic?: string | null;
  evidence?: string | null;
  suggested_probe?: string | null;
  /** The parent diagram already had this; the modification did not cause it. */
  inherited: boolean;
};

export type StructuralDelta = {
  nodes: { before: number; after: number };
  edges: { before: number; after: number };
  groups: { before: number; after: number };
  depth: { before: number; after: number };
  max_fan_in: { before: number; after: number };
  max_fan_out: { before: number; after: number };
  edge_kinds_removed: string[];
  edge_kinds_added: string[];
};

export type VerificationReportData = {
  target_id: string;
  target_kind: "variant" | "visualization";
  verdict: VerificationVerdict;
  headline: string;
  findings: VerificationFinding[];
  structural_delta: StructuralDelta;
  layers: {
    layer: string;
    status: string;
    detail: string;
    seconds: number;
    llm_calls: number;
  }[];
  model: string;
  total_seconds: number;
};

export type PatchResultData = {
  applied: AppliedOp[];
  rejected: RejectedOp[];
  repairs: { code: string; message: string; node_ids: string[]; edge_keys: string[] }[];
  changed_node_ids: string[];
  removed_node_ids: string[];
  structurally_touched_node_ids: string[];
  storyboards_reused?: number;
};

export type AlgorithmVariant = {
  variant_id: string;
  root_viz_id: string;
  parent_variant_id: string | null;
  article_id: string;
  document_source: string;
  diagram_kind: string;
  title: string;
  algorithm_name: string;
  variant_title: string;
  diagram: Diagram;
  summary: string;
  key_insight: string;
  worked_example?: WorkedExample | null;
  intent: string;
  patch: ModificationPatch;
  patch_result: PatchResultData;
  changed_node_ids: string[];
  depth: number;
  model: string;
  created_at: string;
  updated_at: string;
  record_kind: "variant";
};

export type VariantProposal = {
  base: {
    id: string;
    record_kind: string;
    title: string;
    algorithm_name: string;
  };
  intent: string;
  patch: ModificationPatch;
  applied: AppliedOp[];
  rejected: RejectedOp[];
  preview: {
    diagram: Diagram;
    changed_node_ids: string[];
    removed_node_ids: string[];
  };
  report: VerificationReportData;
};

export type VariantTreeRow = {
  variant_id: string;
  parent_variant_id: string | null;
  depth: number;
  variant_title: string;
  intent: string;
  verdict: string;
  blocking_count: number;
  finding_count: number;
  changed_node_ids: string[];
  created_at: string;
};

export type VerificationRun = {
  run_id: string;
  target_id: string;
  target_kind: string;
  status: string;
  stage: string;
  message: string;
  report: VerificationReportData | null;
  verdict: string;
  finding_count: number;
  blocking_count: number;
  model: string;
  error?: string | null;
  created_at: string;
  updated_at: string;
};

export type DiffState = "added" | "removed" | "changed" | "unchanged";

export type DiscussionMessage = {
  message_id: string;
  target_id: string;
  role: "user" | "assistant";
  content: string;
  node_ids: string[];
  suggestions: string[];
  model: string;
  created_at: string;
};

/** Extra primitives added when the vocabulary became domain-aware. */
export type MechanismDomain = "computational" | "biological" | "general";

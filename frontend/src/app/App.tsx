import { Component, useEffect, useMemo, useRef, useState } from "react";
import type {
  ErrorInfo,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  History,
  Link,
  Map as MapIcon,
  Menu,
  MessageSquare,
  Network,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  Send,
  User,
  X,
} from "lucide-react";

import {
  buildClusters,
  deleteChatSession,
  getArticleDomains,
  getArticles,
  getChatSession,
  getChatSessions,
  getClusters,
  getDocumentDetail,
  getHealth,
  getIngestionJobs,
  getVisualImageUrl,
  ingestUrlPaper,
  searchPapers,
  sendAgentChat,
  sendChat,
} from "./api";
import { AgentConsoleView } from "./components/AgentConsoleView";
import { CrawlerView } from "./components/CrawlerView";
import { DocumentReader } from "./components/DocumentReader";
import { EvaluationDashboard } from "./components/EvaluationDashboard";
import { GraphRagView } from "./components/GraphRagView";
import { NotesView } from "./components/NotesView";
import { PaperLibraryView } from "./components/PaperLibraryView";
import { RedditView } from "./components/RedditView";
import { ResearchPanel } from "./components/ResearchPanel";
import { TopologyExplorer } from "./components/TopologyExplorer";
import { WorkspaceNotesPane } from "./components/WorkspaceNotesPane";
import type {
  Cluster,
  ClusterDocument,
  ClusterGraph,
  Article,
  Annotation,
  ArticleDomain,
  ArxivPaper,
  ChatHistoryItem,
  ChatSession,
  DocumentDetail,
  IngestionJob,
  Message,
  Source,
  ContextMode,
  RetrievalStrategy,
} from "./types";

const EMPTY_GRAPH: ClusterGraph = { clusters: [], documents: [] };

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error?: Error; info?: ErrorInfo }
> {
  state: { error?: Error; info?: ErrorInfo } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ResearchMind render error", error, info);
    this.setState({ error, info });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0b0d10",
          color: "#f8fafc",
          padding: 32,
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 920,
            border: "1px solid #7f1d1d",
            background: "#1f1212",
            borderRadius: 12,
            padding: 24,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 24 }}>ResearchMind crashed while rendering</h1>
          <p style={{ color: "#a09c92", lineHeight: 1.6 }}>
            The app is loaded, but a frontend runtime error stopped React from drawing the UI.
            This message is here so we can see the real issue instead of a black screen.
          </p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              color: "#fca5a5",
              background: "#0b0d10",
              border: "1px solid #3f1b1b",
              borderRadius: 8,
              padding: 16,
              overflow: "auto",
            }}
          >
            {this.state.error.message}
            {this.state.info?.componentStack ? `\n${this.state.info.componentStack}` : ""}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 12,
              border: "1px solid #d7d3c7",
              background: "#d7d3c7",
              color: "#181916",
              borderRadius: 8,
              padding: "10px 14px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

function initialMessage(cluster?: Cluster): Message {
  return {
    id: `welcome-${cluster?.cluster_id ?? "all"}`,
    role: "assistant",
    content: cluster
      ? `You are now exploring **${cluster.cluster_label}**. I will retrieve answers only from this cluster. Select an article on the right to read it, or ask a question across the cluster.`
      : "Welcome to **ResearchMind**. Explore the paper topology to focus on a research cluster, or ask a question across all indexed papers. Every response is grounded in retrieved passages from your collection.",
    timestamp: new Date(),
  };
}

function articleInitialMessage(article: Article): Message {
  const title = articleTitle(article);
  return {
    id: `welcome-article-${article.article_id}-${Date.now()}`,
    role: "assistant",
    content: `You are now chatting with **${title}**. The PDF is open on the side, and questions will retrieve from this paper first.`,
    timestamp: new Date(),
  };
}

function titleFromSource(source: string): string {
  return source
    .replace(/\.pdf$/i, "")
    .replace(/^\d{4}\.\d+(?:v\d+)?_/i, "")
    .replace(/[_-]+/g, " ");
}

function articleTitle(article: Article): string {
  return article.title || titleFromSource(article.source);
}

function sourceKey(source: Source): string {
  const text = sourceTextValue(source?.text);
  return [
    source?.id,
    sourceTextValue(source?.source),
    typeof source?.page === "number" ? source.page : "",
    text.slice(0, 100),
  ].join(":");
}

function scopeLabelFor(domain: string, category: string): string {
  if (domain && category) return `${domain} / ${category}`;
  if (domain) return domain;
  if (category) return category;
  return "all papers";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function jobStatusLabel(job: IngestionJob): string {
  if (job.status === "queued") return "Queued";
  if (job.status === "running") return job.stage === "downloading" ? "Downloading" : "Indexing";
  if (job.status === "indexed") return "Indexed";
  if (job.status === "failed") return "Failed";
  return job.status;
}

function jobTitle(job: IngestionJob): string {
  return job.article_title || job.title || titleFromSource(job.url);
}

function documentFromArticle(article: Article): ClusterDocument {
  return {
    article_id: article.article_id,
    title: article.title,
    url: article.url,
    domain: article.domain,
    category: article.category,
    tags: article.tags,
    source: article.source,
    chunk_count: 0,
    cluster_id: -1,
    cluster_label: article.category || article.domain || "Library",
    x: 0,
    y: 0,
  };
}

function FormattedText({ content }: { content: string }) {
  return (
    <div className="space-y-2">
      {content.split("\n").map((line, index) => {
        if (!line.trim()) return <div key={index} className="h-1" />;

        const parts = line.split(/(\*\*.*?\*\*)/g);
        return (
          <p key={index} className="leading-relaxed">
            {parts.map((part, partIndex) =>
              part.startsWith("**") && part.endsWith("**") ? (
                <strong key={partIndex} className="font-semibold text-foreground">
                  {part.slice(2, -2)}
                </strong>
              ) : (
                <span key={partIndex}>{part}</span>
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}

function contextLabel(source: Source, index: number): string {
  if (source.document_type === "visual_asset" || source.image_url) {
    return typeof source.page === "number" ? `Figure/image - p.${source.page}` : "Figure/image";
  }
  if (source.selection) {
    return typeof source.page === "number" ? `PDF selection - p.${source.page}` : "PDF selection";
  }
  return sourceTextValue(source.title) || sourceTextValue(source.source) || `Context ${index + 1}`;
}

function MessageContextCard({ source, index }: { source: Source; index: number }) {
  const imageUrl =
    typeof source.image_url === "string" ? getVisualImageUrl(source.image_url) : "";
  const text = typeof source.text === "string" ? source.text : "";

  return (
    <div className="w-full rounded border border-primary/25 bg-primary/10 overflow-hidden">
      {imageUrl && (
        <div className="border-b border-primary/20 bg-background/60">
          <img
            src={imageUrl}
            alt={sourceTextValue(source.title) || "Pinned visual context"}
            className="max-h-36 w-full object-contain"
          />
        </div>
      )}
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-primary">
            Referencing
          </span>
          <span className="min-w-0 truncate text-[11px] font-medium text-foreground">
            {contextLabel(source, index)}
          </span>
        </div>
        {text && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-3">
            {text}
          </p>
        )}
      </div>
    </div>
  );
}

function sourceCitationLabel(source: Source, index: number): string {
  if (typeof source.page === "number") return `[p.${source.page}]`;
  return `[${index + 1}]`;
}

function citationTitle(source: Source): string {
  return sourceTextValue(source.title) || sourceTextValue(source.source) || "Open source";
}

function sourceTextValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function paperSourceKey(source: Source): string {
  return String(source?.article_id || source?.source || source?.id || "");
}

function isPaperSource(source: Source): boolean {
  if (!source || typeof source !== "object") return false;
  return Boolean(
    typeof source.source === "string" &&
      source.source &&
      !source.selection &&
      source.document_type !== "visual_asset" &&
      !source.image_url,
  );
}

function paperTitle(source: Source): string {
  const title = sourceTextValue(source.title);
  const file = sourceTextValue(source.source);
  return title || (file ? titleFromSource(file) : "Indexed paper");
}

function paperSubtitle(source: Source): string {
  return [sourceTextValue(source.category), sourceTextValue(source.domain)]
    .filter(Boolean)
    .join(" - ");
}

function MessagePaperCards({
  sources,
  onOpenSource,
}: {
  sources: Source[];
  onOpenSource: (source: Source) => void;
}) {
  const safeSources = Array.isArray(sources) ? sources : [];
  const paperSources = Array.from(
    safeSources
      .filter(isPaperSource)
      .reduce((papers, source) => {
        const key = paperSourceKey(source);
        if (key && !papers.has(key)) papers.set(key, source);
        return papers;
      }, new Map<string, Source>())
      .values(),
  ).slice(0, 5);

  if (paperSources.length === 0) return null;

  return (
    <div className="mt-2 w-full space-y-2">
      <p className="px-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Retrieved papers
      </p>
      <div className="grid gap-2">
        {paperSources.map((source) => (
          <article
            key={paperSourceKey(source)}
            className="rounded border border-border bg-card px-3 py-2"
          >
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-primary/25 bg-primary/10 text-primary">
                <FileText size={13} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words text-xs font-semibold text-foreground">
                  {paperTitle(source)}
                </p>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                  {paperSubtitle(source) || sourceTextValue(source.source)}
                </p>
                {(sourceTextValue(source.summary) || sourceTextValue(source.text)) && (
                  <p className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
                    {sourceTextValue(source.summary) || sourceTextValue(source.text)}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onOpenSource(source)}
                className="shrink-0 rounded border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/20"
              >
                Read PDF
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onOpenSource,
}: {
  message: Message;
  onOpenSource: (source: Source) => void;
}) {
  const isUser = message.role === "user";
  const pinnedSources = Array.isArray(message.pinnedSources) ? message.pinnedSources : [];
  const messageSources = Array.isArray(message.sources) ? message.sources : [];
  const citationSources = messageSources.filter(
    (source) => typeof source?.source === "string" && typeof source?.page === "number",
  );

  return (
    <div
      className={`w-full min-w-0 flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <div
        className={`w-8 h-8 shrink-0 rounded border flex items-center justify-center ${
          isUser
            ? "border-border bg-secondary text-foreground"
            : "bg-background border-border text-muted-foreground"
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div
        className={`min-w-0 max-w-[calc(100vw_-_5.5rem)] md:max-w-[78%] flex flex-col gap-2 ${
          isUser ? "items-end" : "items-start"
        }`}
      >
        {isUser && pinnedSources.length > 0 && (
          <div className="w-full space-y-2">
            {pinnedSources.map((source, index) => (
              <MessageContextCard
                key={`${sourceKey(source)}:${index}`}
                source={source}
                index={index}
              />
            ))}
          </div>
        )}
        <div
          className={`rounded px-4 py-3 text-sm ${
            isUser
              ? "rm-message-user text-foreground"
              : "rm-message-assistant border text-secondary-foreground"
          }`}
        >
          <div className="break-words overflow-hidden">
            <FormattedText content={message.content} />
          </div>
        </div>
        {!isUser && messageSources.length > 0 && (
          <MessagePaperCards sources={messageSources} onOpenSource={onOpenSource} />
        )}
        {messageSources.length > 0 && (
          <div className="px-1 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">
              {messageSources.length} grounded source
              {messageSources.length === 1 ? "" : "s"}
            </span>
            {citationSources.slice(0, 8).map((source, index) => (
              <button
                key={`${sourceKey(source)}:${index}`}
                type="button"
                title={citationTitle(source)}
                onClick={() => onOpenSource(source)}
                className="h-5 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                {sourceCitationLabel(source, index)}
              </button>
            ))}
          </div>
        )}
        {!isUser && message.toolTrace && message.toolTrace.length > 0 && (
          <div className="px-1 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">
              Agent tools:
            </span>
            {message.toolTrace.map((step) => (
              <span
                key={`${step.tool}:${step.timestamp}`}
                title={step.message}
                className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {step.tool}
              </span>
            ))}
          </div>
        )}
        <span className="font-mono text-[10px] text-muted-foreground px-1">
          {message.timestamp.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
    </div>
  );
}

function AppContent() {
  const [graph, setGraph] = useState<ClusterGraph>(EMPTY_GRAPH);
  const [selectedCluster, setSelectedCluster] = useState<Cluster>();
  const [selectedDocument, setSelectedDocument] = useState<ClusterDocument>();
  const [documentDetail, setDocumentDetail] = useState<DocumentDetail>();
  const [readerDocument, setReaderDocument] = useState<ClusterDocument>();
  const [readerInitialPage, setReaderInitialPage] = useState<number>();
  const [messages, setMessages] = useState<Message[]>([initialMessage()]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [sources, setSources] = useState<Source[]>([]);
  const [pinnedSources, setPinnedSources] = useState<Source[]>([]);
  const [contextMode, setContextMode] = useState<ContextMode>("retrieval");
  const [retrievalStrategy, setRetrievalStrategy] = useState<RetrievalStrategy>("hybrid");
  const [input, setInput] = useState("");
  const [activeView, setActiveView] = useState<"chat" | "library" | "crawler" | "reddit" | "notes" | "agent" | "graph" | "evaluation">("chat");
  const [librarySearch, setLibrarySearch] = useState("");
  const [crawlerDescription, setCrawlerDescription] = useState("");
  const [crawlerCategory, setCrawlerCategory] = useState("");
  const [crawlerSources, setCrawlerSources] = useState<string[]>([
    "arxiv",
    "pubmed",
    "biorxiv",
    "medrxiv",
    "semantic_scholar",
  ]);
  const [crawlerSortBy, setCrawlerSortBy] = useState<"relevance" | "newest" | "last_updated">("relevance");
  const [crawlerMaxResults, setCrawlerMaxResults] = useState(10);
  const [crawlerResults, setCrawlerResults] = useState<ArxivPaper[]>([]);
  const [crawlerQuery, setCrawlerQuery] = useState("");
  const [crawlerStatus, setCrawlerStatus] = useState("");
  const [isCrawlerSearching, setIsCrawlerSearching] = useState(false);
  const [addingCrawlerPaperId, setAddingCrawlerPaperId] = useState<string>();
  const [isTyping, setIsTyping] = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth >= 768,
  );
  const [sidebarWidth, setSidebarWidth] = useState(380);
  const [workspaceNotesOpen, setWorkspaceNotesOpen] = useState(
    () => window.innerWidth >= 1100,
  );
  const [workspaceNotesWidth, setWorkspaceNotesWidth] = useState(320);
  const [loadError, setLoadError] = useState("");
  const [paperUrl, setPaperUrl] = useState("");
  const [paperTitle, setPaperTitle] = useState("");
  const [paperDomain, setPaperDomain] = useState("research");
  const [paperCategory, setPaperCategory] = useState("");
  const [paperTags, setPaperTags] = useState("");
  const [isIngestingPaper, setIsIngestingPaper] = useState(false);
  const [ingestStatus, setIngestStatus] = useState("");
  const [addPaperOpen, setAddPaperOpen] = useState(false);
  const [ingestionJobsOpen, setIngestionJobsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [topologyScopeOpen, setTopologyScopeOpen] = useState(false);
  const [topologyExplorerOpen, setTopologyExplorerOpen] = useState(false);
  const [articleDomains, setArticleDomains] = useState<ArticleDomain[]>([]);
  const [recentArticles, setRecentArticles] = useState<Article[]>([]);
  const [libraryArticles, setLibraryArticles] = useState<Article[]>([]);
  const [ingestionJobs, setIngestionJobs] = useState<IngestionJob[]>([]);
  const [selectedDomain, setSelectedDomain] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [isBuildingTopology, setIsBuildingTopology] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const activeScope = useMemo(
    () => ({
      domain: selectedDomain || undefined,
      category: selectedCategory || undefined,
    }),
    [selectedDomain, selectedCategory],
  );

  const domainOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...articleDomains.map((item) => item.domain),
            ...graph.documents.map((document) => document.domain || ""),
          ]
            .filter((value): value is string => Boolean(value))
            .sort((a, b) => a.localeCompare(b)),
        ),
      ),
    [articleDomains, graph.documents],
  );

  const categoryOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...articleDomains
              .filter((item) => !selectedDomain || item.domain === selectedDomain)
              .map((item) => item.category),
            ...graph.documents
              .filter(
                (document) =>
                  !selectedDomain || document.domain === selectedDomain,
              )
              .map((document) => document.category || ""),
          ]
            .filter((value): value is string => Boolean(value))
            .sort((a, b) => a.localeCompare(b)),
        ),
      ),
    [articleDomains, selectedDomain],
  );

  const clusterDocuments = useMemo(() => {
    if (!selectedCluster) return [];
    return graph.documents
      .filter(
        (document) => document.cluster_id === selectedCluster.cluster_id,
      )
      .sort((a, b) => a.source.localeCompare(b.source));
  }, [graph.documents, selectedCluster]);

  useEffect(() => {
    let active = true;

    const refreshArticles = () => {
      Promise.all([
        getArticleDomains(),
        getArticles({ limit: 5 }),
        getArticles({ limit: 500 }),
        getIngestionJobs(8),
      ])
      .then(([domainsResult, articlesResult, libraryResult, jobsResult]) => {
        if (!active) return;
        setArticleDomains(domainsResult.domains);
        setRecentArticles(articlesResult.articles);
        setLibraryArticles(libraryResult.articles);
        setIngestionJobs(jobsResult.jobs);
      })
      .catch(() => {
        if (!active) return;
        setArticleDomains([]);
        setRecentArticles([]);
        setLibraryArticles([]);
        setIngestionJobs([]);
      });
    };

    refreshArticles();
    const intervalId = window.setInterval(refreshArticles, 6000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let active = true;

    Promise.all([getHealth(), getClusters(activeScope)])
      .then(([, clusterGraph]) => {
        if (!active) return;
        setBackendOnline(true);
        setGraph(clusterGraph);
        setLoadError("");
        setSelectedCluster(undefined);
        setSelectedDocument(undefined);
        setDocumentDetail(undefined);
        setReaderDocument(undefined);
        setSources([]);
      })
      .catch((error: Error) => {
        if (!active) return;
        setBackendOnline(false);
        setLoadError(error.message);
      });

    return () => {
      active = false;
    };
  }, [activeScope]);

  useEffect(() => {
    let active = true;

    const checkBackend = () => {
      getHealth()
        .then(() => {
          if (active) setBackendOnline(true);
        })
        .catch(() => {
          if (active) setBackendOnline(false);
        });
    };

    checkBackend();
    const intervalId = window.setInterval(checkBackend, 5000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let active = true;

    getChatSessions()
      .then((result) => {
        if (active) setChatSessions(result.sessions);
      })
      .catch(() => {
        if (active) setChatSessions([]);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  useEffect(() => {
    if (!selectedDocument) {
      setDocumentDetail(undefined);
      return;
    }

    let active = true;
    getDocumentDetail(selectedDocument.source)
      .then((detail) => {
        if (active) setDocumentDetail(detail);
      })
      .catch(() => {
        if (active) setDocumentDetail(undefined);
      });

    return () => {
      active = false;
    };
  }, [selectedDocument]);

  function chooseCluster(cluster: Cluster) {
    setSelectedCluster(cluster);
    setSelectedDocument(undefined);
    setDocumentDetail(undefined);
    setReaderDocument(undefined);
    setContextMode("retrieval");
    setSources([]);
    setPinnedSources([]);
    setActiveSessionId(undefined);
    setMessages([initialMessage(cluster)]);
    setInput("");
  }

  function clearCluster() {
    setSelectedCluster(undefined);
    setSelectedDocument(undefined);
    setDocumentDetail(undefined);
    setReaderDocument(undefined);
    setContextMode("retrieval");
    setSources([]);
    setPinnedSources([]);
    setActiveSessionId(undefined);
    setMessages([initialMessage()]);
    setInput("");
  }

  function startNewChat() {
    setSelectedCluster(undefined);
    setSelectedDocument(undefined);
    setDocumentDetail(undefined);
    setReaderDocument(undefined);
    setContextMode("retrieval");
    setSources([]);
    setPinnedSources([]);
    setActiveSessionId(undefined);
    setMessages([initialMessage()]);
    setInput("");
  }

  async function refreshChatSessions() {
    try {
      const result = await getChatSessions();
      setChatSessions(result.sessions);
    } catch {
      // Keep the current list if history refresh fails.
    }
  }

  async function loadChatSession(sessionId: string) {
    try {
      const detail = await getChatSession(sessionId);
      const session = detail.session;
      const cluster = graph.clusters.find(
        (item) => item.cluster_id === session.cluster_id,
      );
      const document = graph.documents.find(
        (item) => item.source === session.document_source,
      );

      setSelectedCluster(cluster);
      setSelectedDocument(document);
      setReaderDocument(undefined);
      setContextMode(session.context_mode || "retrieval");
      setActiveSessionId(session.id);
      setPinnedSources([]);
      setSources(
        [...detail.messages]
          .reverse()
          .find((message) => message.sources && message.sources.length > 0)
          ?.sources || [],
      );
      setMessages(
        detail.messages.length
          ? detail.messages.map((message, index) => ({
              id: `${session.id}-${index}`,
              role: message.role,
              content: message.content,
              sources: message.sources,
              pinnedSources: message.pinnedSources || message.pinned_sources || [],
              timestamp: new Date(message.created_at),
            }))
          : [initialMessage(cluster)],
      );
      setInput("");
      setBackendOnline(true);
    } catch {
      setBackendOnline(false);
    }
  }

  async function removeChatSession(sessionId: string) {
    try {
      await deleteChatSession(sessionId);
      setChatSessions((current) =>
        current.filter((session) => session.id !== sessionId),
      );
      if (activeSessionId === sessionId) {
        startNewChat();
      }
    } catch {
      // Ignore delete failures in the compact history control.
    }
  }

  function pinSource(source: Source) {
    setPinnedSources((current) => {
      const key = sourceKey(source);
      if (current.some((item) => sourceKey(item) === key)) return current;
      return [...current, source];
    });
  }

  function removePinnedSource(source: Source) {
    const key = sourceKey(source);
    setPinnedSources((current) =>
      current.filter((item) => sourceKey(item) !== key),
    );
  }

  async function submitPaperUrl() {
    const url = paperUrl.trim();
    if (!url || isIngestingPaper) return;

    setIsIngestingPaper(true);
    setIngestStatus("Indexing paper...");

    try {
      const result = await ingestUrlPaper({
        url,
        title: paperTitle.trim() || undefined,
        domain: paperDomain.trim() || "research",
        category: paperCategory.trim() || "uncategorized",
        tags: paperTags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });

      setPaperUrl("");
      setPaperTitle("");
      setPaperCategory("");
      setPaperTags("");
      setBackendOnline(true);
      setIngestStatus(
        `Queued ${jobTitle(result.job)} for indexing. Watch the ingestion jobs dashboard for progress.`,
      );
      setIngestionJobs((current) => [result.job, ...current].slice(0, 8));

      try {
        const [domainsResult, articlesResult, libraryResult, jobsResult, clusterGraph] = await Promise.all([
          getArticleDomains(),
          getArticles({ limit: 5 }),
          getArticles({ limit: 500 }),
          getIngestionJobs(8),
          getClusters(activeScope),
        ]);
        setArticleDomains(domainsResult.domains);
        setRecentArticles(articlesResult.articles);
        setLibraryArticles(libraryResult.articles);
        setIngestionJobs(jobsResult.jobs);
        setGraph(clusterGraph);
        setLoadError("");
      } catch {
        // The vector index is updated even when the saved topology has not been rebuilt yet.
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "The paper could not be indexed.";
      setIngestStatus(`Could not index paper: ${detail}`);
    } finally {
      setIsIngestingPaper(false);
    }
  }

  async function searchCrawler() {
    const description = crawlerDescription.trim();
    if (!description || isCrawlerSearching) return;

    setIsCrawlerSearching(true);
    setCrawlerStatus("Searching academic sources...");
    setCrawlerQuery("");

    try {
      const result = await searchPapers({
        description,
        category: crawlerCategory.trim() || undefined,
        sources: crawlerSources,
        sort_by: crawlerSortBy,
        max_results: crawlerMaxResults,
      });
      setCrawlerResults(result.papers);
      setCrawlerQuery(result.query);
      setCrawlerStatus(
        result.warning
          ? `${result.warning} Found ${result.papers.length} papers.`
          : result.papers.length
            ? `Found ${result.papers.length} related papers from ${result.provider || "paper search"}.`
            : "No papers matched that description.",
      );
      setBackendOnline(true);
    } catch (error) {
      setCrawlerStatus(
        error instanceof Error
          ? `Could not search papers: ${error.message}`
          : "Could not search academic sources.",
      );
      setBackendOnline(false);
    } finally {
      setIsCrawlerSearching(false);
    }
  }

  async function addCrawlerPaper(
    paper: ArxivPaper,
    metadata: { domain?: string; category?: string; tags?: string[] } = {},
  ) {
    if (addingCrawlerPaperId) return;

    setAddingCrawlerPaperId(paper.arxiv_id || paper.paper_id || paper.pdf_url || paper.url || paper.title);
    setCrawlerStatus(`Queuing ${paper.title} for indexing...`);

    try {
      const result = await ingestUrlPaper({
        url: paper.pdf_url || paper.url,
        title: paper.title,
        domain: metadata.domain?.trim() || paperDomain.trim() || "research",
        category:
          metadata.category?.trim() ||
          paper.categories[0] ||
          paperCategory.trim() ||
          "uncategorized",
        tags: metadata.tags?.length ? metadata.tags : paper.categories,
      });

      setIngestionJobs((current) => [result.job, ...current].slice(0, 8));
      setCrawlerStatus(`Queued ${paper.title}. Track progress in ingestion jobs.`);
      setBackendOnline(true);

      try {
        const [domainsResult, articlesResult, libraryResult, jobsResult] = await Promise.all([
          getArticleDomains(),
          getArticles({ limit: 5 }),
          getArticles({ limit: 500 }),
          getIngestionJobs(8),
        ]);
        setArticleDomains(domainsResult.domains);
        setRecentArticles(articlesResult.articles);
        setLibraryArticles(libraryResult.articles);
        setIngestionJobs(jobsResult.jobs);
      } catch {
        // The ingestion job is still queued even if the sidebar refresh fails.
      }
    } catch (error) {
      setCrawlerStatus(
        error instanceof Error
          ? `Could not add paper: ${error.message}`
          : "Could not add paper.",
      );
    } finally {
      setAddingCrawlerPaperId(undefined);
    }
  }

  async function rebuildCurrentTopology() {
    if (isBuildingTopology) return;

    setIsBuildingTopology(true);
    setLoadError("");

    try {
      const clusterGraph = await buildClusters(activeScope);
      setGraph(clusterGraph);
      setSelectedCluster(undefined);
      setSelectedDocument(undefined);
      setDocumentDetail(undefined);
      setReaderDocument(undefined);
      setSources([]);
      setBackendOnline(true);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Topology rebuild failed.";
      setLoadError(detail);
    } finally {
      setIsBuildingTopology(false);
    }
  }

  async function submitQuestion() {
    const question = input.trim();
    if (!question || isTyping) return;

    const history = messages.map(({ role, content }) => ({ role, content }));
    const pinnedSourcesForMessage = [...pinnedSources];
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question,
      pinnedSources: pinnedSourcesForMessage,
      timestamp: new Date(),
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setIsTyping(true);

    try {
      const chatRequest: {
        sessionId?: string;
        question: string;
        chatHistory: ChatHistoryItem[];
        pinnedSources: Source[];
        clusterId?: number;
        documentSource?: string;
        domain?: string;
        category?: string;
        contextMode: ContextMode;
        retrievalStrategy: RetrievalStrategy;
      } = {
        sessionId: activeSessionId,
        question,
        chatHistory: history,
        pinnedSources: pinnedSourcesForMessage,
        clusterId: selectedCluster?.cluster_id,
        documentSource: selectedDocument?.source,
        domain: selectedDomain || undefined,
        category: selectedCategory || undefined,
        contextMode: selectedDocument ? contextMode : "retrieval",
        retrievalStrategy,
      };
      const result = await sendChat(chatRequest);

      setActiveSessionId(result.session_id);
      void refreshChatSessions();
      setSources(result.sources || []);
      if (result.topology) {
        setGraph(result.topology);
        setTopologyExplorerOpen(true);
      }
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: result.answer,
          sources: result.sources,
          toolTrace: result.tool_trace || [],
          timestamp: new Date(),
        },
      ]);
      setBackendOnline(true);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "The request failed.";
      const networkFailure =
        detail.toLowerCase().includes("failed to fetch") ||
        detail.toLowerCase().includes("network") ||
        detail.toLowerCase().includes("load failed");
      setBackendOnline(!networkFailure);
      setMessages((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: networkFailure
            ? `I could not reach the research backend. ${detail}`
            : `The research backend could not generate an answer. ${detail}`,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsTyping(false);
    }
  }

  async function runAgentCommand(
    command: string,
    options?: { sessionId?: string; chatHistory?: ChatHistoryItem[] },
  ) {
    const result = await sendAgentChat({
      sessionId: options?.sessionId,
      question: command,
      chatHistory: options?.chatHistory || [],
      pinnedSources,
      clusterId: selectedCluster?.cluster_id,
      documentSource: selectedDocument?.source,
      domain: selectedDomain || undefined,
      category: selectedCategory || undefined,
      contextMode: selectedDocument ? contextMode : "retrieval",
    });

    setSources(result.sources || []);
    if (result.topology) {
      setGraph(result.topology);
      setTopologyExplorerOpen(true);
    }
    setBackendOnline(true);
    return result;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitQuestion();
    }
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (window.innerWidth < 768) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    const resize = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      setSidebarWidth(clamp(nextWidth, 300, 560));
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize);
  }

  function startWorkspaceNotesResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (window.innerWidth < 768) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = workspaceNotesWidth;

    const resize = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      setWorkspaceNotesWidth(clamp(nextWidth, 240, 460));
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize);
  }

  function openLibraryArticle(article: Article) {
    const document = documentFromArticle(article);
    setSelectedCluster(undefined);
    setSelectedDocument(document);
    setReaderDocument(document);
    setReaderInitialPage(undefined);
    setContextMode("retrieval");
    setActiveView("chat");
    setSidebarOpen(false);
  }

  function documentFromSourceReference(source: Source): ClusterDocument | undefined {
    const sourceName = sourceTextValue(source.source);
    if (!sourceName) return undefined;
    return (
      graph.documents.find((document) => document.source === sourceName) ||
      documentFromArticle({
        article_id: String(source.article_id || sourceName),
        title: sourceTextValue(source.title) || titleFromSource(sourceName),
        source: sourceName,
        url: typeof source.url === "string" ? source.url : undefined,
        pdf_url: undefined,
        domain: typeof source.domain === "string" ? source.domain : "research",
        category: typeof source.category === "string" ? source.category : "uncategorized",
        tags: Array.isArray(source.tags) ? source.tags : [],
        status: "indexed",
        created_at: "",
        updated_at: "",
      })
    );
  }

  function openSourceCitation(source: Source) {
    const document = documentFromSourceReference(source);
    if (!document) return;

    setSelectedCluster(undefined);
    setSelectedDocument(document);
    setReaderDocument(document);
    setReaderInitialPage(typeof source.page === "number" ? source.page : undefined);
    setContextMode("retrieval");
    setActiveView("chat");
    setSidebarOpen(false);
  }

  function openAnnotation(annotation: Annotation) {
    openSourceCitation({
      source: annotation.source,
      page: annotation.page,
      title: annotation.title || titleFromSource(annotation.source),
      article_id: annotation.article_id || undefined,
      text: annotation.selected_text,
      selection: true,
    });
  }

  function chatWithLibraryArticle(article: Article) {
    const document = documentFromArticle(article);
    setSelectedCluster(undefined);
    setSelectedDocument(document);
    setReaderDocument(document);
    setReaderInitialPage(undefined);
    setDocumentDetail(undefined);
    setContextMode("retrieval");
    setMessages([articleInitialMessage(article)]);
    setActiveSessionId(undefined);
    setSources([]);
    setPinnedSources([]);
    setActiveView("chat");
    setSidebarOpen(false);
  }

  const scopeLabel = selectedDocument
    ? titleFromSource(selectedDocument.source)
    : selectedCluster?.cluster_label || "All indexed papers";
  const activeScopeLabel = scopeLabelFor(selectedDomain, selectedCategory);
  const scopeIsFiltered = Boolean(selectedDomain || selectedCategory);
  const headerTitle =
    activeView === "crawler"
      ? "Crawler"
      : activeView === "reddit"
        ? "Reddit"
      : activeView === "agent"
        ? "Agent Console"
      : activeView === "graph"
        ? "Graph RAG"
      : activeView === "evaluation"
        ? "Evaluation"
      : activeView === "library"
        ? "Paper Library"
        : activeView === "notes"
          ? "Research Notes"
          : scopeLabel;
  const headerSubtitle =
    activeView === "crawler"
      ? "arXiv paper discovery"
      : activeView === "reddit"
        ? "Community research signals"
      : activeView === "agent"
        ? "Internal research tool calling"
      : activeView === "graph"
        ? "Concept and relationship retrieval"
      : activeView === "evaluation"
        ? "RAG quality and latency tracking"
      : activeView === "library"
        ? "Search and read indexed papers"
        : activeView === "notes"
          ? "Search saved highlights"
          : selectedDocument
            ? contextMode === "whole_document"
              ? "Whole-paper context"
              : "Article-only retrieval"
            : selectedCluster
              ? "Cluster retrieval"
              : scopeIsFiltered
                ? `${activeScopeLabel} retrieval`
                : "Full collection retrieval";
  const workspaceNoteScopeId =
    selectedDocument?.source ||
    activeSessionId ||
    selectedCluster?.cluster_label ||
    activeScopeLabel ||
    "all-papers";
  const workspaceNoteScopeTitle =
    selectedDocument?.title ||
    (selectedDocument ? titleFromSource(selectedDocument.source) : "") ||
    selectedCluster?.cluster_label ||
    activeScopeLabel ||
    "All indexed papers";

  return (
    <div
      className="rm-app-shell h-screen w-screen bg-background text-foreground flex overflow-hidden"
      style={{ fontFamily: "'Inter', sans-serif" }}
    >
      <aside
        className="rm-sidebar fixed md:relative inset-y-0 left-0 z-40 shrink-0 border-r border-border flex flex-col overflow-hidden transition-[width] duration-200"
        style={{ width: sidebarOpen ? sidebarWidth : 0 }}
      >
        <div className="h-20 px-5 border-b border-border/80 flex items-center gap-3 shrink-0">
          <div className="w-10 h-10 rounded border border-border bg-background flex items-center justify-center text-muted-foreground">
            <Search size={15} />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight">
              ResearchMind
            </h1>
            <p className="text-xs text-muted-foreground">
              Research topology chatbot
            </p>
          </div>
        </div>

        <div className="p-4 shrink-0 border-b border-border/80">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-2">
            Workspace
          </p>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveView("chat")}
              className={`rm-nav-button w-full flex items-center gap-2.5 px-2.5 py-2 border text-left ${
                activeView === "chat"
                  ? "rm-active-surface text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground"
              }`}
            >
              <MessageSquare size={14} />
              <span className="text-xs font-medium">Chat</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveView("agent")}
              className={`rm-nav-button w-full flex items-center gap-2.5 px-2.5 py-2 border text-left ${
                activeView === "agent"
                  ? "rm-active-surface text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground"
              }`}
            >
              <BrainCircuit size={14} />
              <span className="text-xs font-medium">Agent</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveView("graph")}
              className={`rm-nav-button w-full flex items-center gap-2.5 px-2.5 py-2 border text-left ${
                activeView === "graph"
                  ? "rm-active-surface text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Network size={14} />
              <span className="text-xs font-medium">Graph RAG</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveView("library")}
              className={`rm-nav-button w-full flex items-center gap-2.5 px-2.5 py-2 border text-left ${
                activeView === "library"
                  ? "rm-active-surface text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground"
              }`}
            >
              <FileText size={14} />
              <span className="text-xs font-medium">Paper Library</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveView("notes")}
              className={`rm-nav-button w-full flex items-center gap-2.5 px-2.5 py-2 border text-left ${
                activeView === "notes"
                  ? "rm-active-surface text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground"
              }`}
            >
              <NotebookPen size={14} />
              <span className="text-xs font-medium">Notes</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveView("crawler")}
              className={`rm-nav-button w-full flex items-center gap-2.5 px-2.5 py-2 border text-left ${
                activeView === "crawler"
                  ? "rm-active-surface text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Search size={14} />
              <span className="text-xs font-medium">Crawler</span>
            </button>
          </div>
        </div>

        {activeView === "chat" && (
          <div className="px-4 pb-4 shrink-0 border-b border-border/80">
            <div className="h-8 px-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setHistoryOpen((value) => !value)}
                className="min-w-0 flex-1 flex items-center gap-2 text-left"
              >
                <History size={12} className="text-primary" />
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Past chats
                </span>
                <span className="ml-auto text-muted-foreground">
                  {historyOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </span>
              </button>
              <button
                type="button"
                title="Start new chat"
                onClick={startNewChat}
                className="w-6 h-6 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-secondary"
              >
                <Plus size={12} />
              </button>
            </div>

            {historyOpen && (
              <div className="max-h-52 overflow-y-auto space-y-1">
                {chatSessions.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-muted-foreground">
                    No saved chats yet.
                  </p>
                ) : (
                  chatSessions.slice(0, 10).map((session) => {
                    const active = activeSessionId === session.id;

                    return (
                      <div
                        key={session.id}
                        className={`group flex items-center gap-1 rounded-lg border ${
                          active
                            ? "rm-active-surface"
                            : "border-transparent hover:border-border hover:bg-secondary"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => void loadChatSession(session.id)}
                          className="min-w-0 flex-1 px-2 py-2 text-left flex items-center gap-2"
                        >
                          <MessageSquare
                            size={12}
                            className={active ? "text-primary" : "text-muted-foreground"}
                          />
                          <span
                            className={`min-w-0 truncate text-[11px] ${
                              active ? "text-primary" : "text-foreground"
                            }`}
                          >
                            {session.title}
                          </span>
                        </button>
                        <button
                          type="button"
                          title="Delete chat"
                          onClick={() => void removeChatSession(session.id)}
                          className="mr-1 w-6 h-6 rounded flex items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {activeView === "chat" && (
        <div className="p-4 shrink-0">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-2">
            Scope
          </p>
          <button
            type="button"
            onClick={clearCluster}
            className={`rm-nav-button w-full flex items-center gap-2.5 px-2.5 py-2 border text-left ${
              !selectedCluster
                ? "rm-active-surface"
                : "border-transparent hover:border-border hover:bg-secondary"
            }`}
          >
            <FileText
              size={14}
              className={!selectedCluster ? "text-primary" : "text-muted-foreground"}
            />
            <div className="min-w-0">
              <p
                className={`text-xs font-medium ${
                  !selectedCluster ? "text-primary" : "text-foreground"
                }`}
              >
                All Papers
              </p>
            </div>
          </button>

          <div className="rm-panel-soft mt-3 rounded-lg bg-background p-2 space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTopologyScopeOpen((value) => !value)}
                className="min-w-0 flex-1 flex items-center gap-2 text-left"
              >
                <Network size={12} className="text-primary" />
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Topology scope
                </span>
                <span className="ml-auto text-muted-foreground">
                  {topologyScopeOpen ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedDomain("");
                  setSelectedCategory("");
                }}
                className="h-6 px-2 rounded border border-border text-[10px] text-muted-foreground hover:text-primary hover:bg-secondary"
              >
                Reset
              </button>
            </div>

            {topologyScopeOpen && (
              <>
                <select
                  value={selectedDomain}
                  onChange={(event) => {
                    setSelectedDomain(event.target.value);
                    setSelectedCategory("");
                  }}
                  className="w-full h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-primary/60"
                >
                  <option value="">All domains</option>
                  {domainOptions.map((domain) => (
                    <option key={domain} value={domain}>
                      {domain}
                    </option>
                  ))}
                </select>
                <select
                  value={selectedCategory}
                  onChange={(event) => setSelectedCategory(event.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-primary/60"
                >
                  <option value="">All categories</option>
                  {categoryOptions.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void rebuildCurrentTopology()}
                  disabled={isBuildingTopology}
                  className="w-full h-8 rounded-md border border-primary/30 bg-primary/10 text-primary text-xs font-medium flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-primary/15"
                >
                  <RefreshCw
                    size={12}
                    className={isBuildingTopology ? "animate-spin" : ""}
                  />
                  {isBuildingTopology ? "Rebuilding..." : "Rebuild scope"}
                </button>
              </>
            )}

            <p className="font-mono text-[10px] text-muted-foreground truncate">
              Viewing {scopeLabelFor(selectedDomain, selectedCategory)}
              {graph.stale ? " - not built yet" : ""}
            </p>
          </div>

        </div>
        )}

        {false && activeView === "library" && (
        <form
          className="px-3 pb-3 shrink-0 border-b border-border/80 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitPaperUrl();
          }}
        >
          <button
            type="button"
            onClick={() => setAddPaperOpen((value) => !value)}
            className="w-full h-8 px-1 flex items-center gap-2 text-left"
          >
            <Link size={12} className="text-primary" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Add paper
            </span>
            <span className="ml-auto text-muted-foreground">
              {addPaperOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </button>

          {addPaperOpen ? (
            <>
              <input
                value={paperUrl}
                onChange={(event) => setPaperUrl(event.target.value)}
                placeholder="arXiv or PDF URL"
                className="w-full h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
              />
              <input
                value={paperTitle}
                onChange={(event) => setPaperTitle(event.target.value)}
                placeholder="Title override"
                className="w-full h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={paperDomain}
                  onChange={(event) => setPaperDomain(event.target.value)}
                  placeholder="Domain"
                  className="h-9 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
                />
                <input
                  value={paperCategory}
                  onChange={(event) => setPaperCategory(event.target.value)}
                  placeholder="Category"
                  className="h-9 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
                />
              </div>
              <input
                value={paperTags}
                onChange={(event) => setPaperTags(event.target.value)}
                placeholder="tags, comma-separated"
                className="w-full h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
              />
              <button
                type="submit"
                disabled={!paperUrl.trim() || isIngestingPaper}
                className="w-full h-9 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40 hover:bg-primary/90"
              >
                {isIngestingPaper ? "Indexing..." : "Add to database"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setAddPaperOpen(true)}
              className="w-full h-9 rounded-md border border-border bg-background px-2 text-left text-xs text-muted-foreground hover:bg-secondary"
            >
              Capture arXiv or PDF URL
            </button>
          )}

          {ingestStatus && (
            <p
              className={`px-1 text-[11px] leading-relaxed ${
                ingestStatus.startsWith("Could not")
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {ingestStatus}
            </p>
          )}
        </form>
        )}

        {activeView === "crawler" && (
        <div className="px-3 pb-3 shrink-0 border-b border-border/80">
          <div className="h-8 px-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIngestionJobsOpen((value) => !value)}
              className="min-w-0 flex-1 flex items-center gap-2 text-left"
            >
              <CheckCircle2 size={12} className="text-primary" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Ingestion jobs
              </span>
              {ingestionJobs.some((job) => job.status === "queued" || job.status === "running") && (
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                  Active
                </span>
              )}
              <span className="ml-auto text-muted-foreground">
                {ingestionJobsOpen ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </span>
            </button>
          </div>

          {ingestionJobsOpen && (
            <div className="space-y-1.5">
              {ingestionJobs.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  Added papers will appear here.
                </p>
              ) : (
                ingestionJobs.slice(0, 5).map((job) => {
                  const active = job.status === "queued" || job.status === "running";
                  const failed = job.status === "failed";

                  return (
                    <div
                      key={job.job_id}
                      className="rounded-lg border border-border bg-background px-2 py-2"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-1.5 w-1.5 h-1.5 shrink-0 rounded-full ${
                            failed
                              ? "bg-destructive"
                              : active
                                ? "bg-primary animate-pulse"
                                : "bg-green-500"
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-foreground truncate">
                            {jobTitle(job)}
                          </p>
                          <p
                            className={`mt-0.5 font-mono text-[10px] ${
                              failed ? "text-destructive" : "text-muted-foreground"
                            }`}
                          >
                            {jobStatusLabel(job)}
                          </p>
                          <p className="mt-1 text-[11px] leading-snug text-muted-foreground line-clamp-2">
                            {failed ? job.error || job.message : job.message}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
        )}

        <div className="hidden">
          <div className="h-8 px-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              className="min-w-0 flex-1 flex items-center gap-2 text-left"
            >
              <History size={12} className="text-primary" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Past chats
              </span>
              <span className="ml-auto text-muted-foreground">
                {historyOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
            </button>
            <button
              type="button"
              title="Start new chat"
              onClick={startNewChat}
              className="w-6 h-6 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-secondary"
            >
              <Plus size={12} />
            </button>
          </div>

          {historyOpen && (
            <div className="max-h-36 overflow-y-auto space-y-1">
              {chatSessions.length === 0 ? (
                <p className="px-1 py-2 text-[11px] text-muted-foreground">
                  No saved chats yet.
                </p>
              ) : (
                chatSessions.slice(0, 8).map((session) => {
                  const active = activeSessionId === session.id;

                  return (
                    <div
                      key={session.id}
                      className={`group flex items-center gap-1 rounded border ${
                        active
                          ? "border-primary/35 bg-primary/10"
                          : "border-transparent hover:border-border hover:bg-secondary"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void loadChatSession(session.id)}
                        className="min-w-0 flex-1 px-2 py-2 text-left flex items-center gap-2"
                      >
                        <MessageSquare
                          size={12}
                          className={active ? "text-primary" : "text-muted-foreground"}
                        />
                        <span
                          className={`min-w-0 truncate text-[11px] ${
                            active ? "text-primary" : "text-foreground"
                          }`}
                        >
                          {session.title}
                        </span>
                      </button>
                      <button
                        type="button"
                        title="Delete chat"
                        onClick={() => void removeChatSession(session.id)}
                        className="mr-1 w-6 h-6 rounded flex items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          title="Resize sidebar"
          aria-label="Resize sidebar"
          onPointerDown={startSidebarResize}
          className="hidden md:block absolute top-0 right-0 h-full w-2 cursor-col-resize bg-transparent hover:bg-primary/20 active:bg-primary/30"
        />
      </aside>

      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close topology navigation"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
        />
      )}

      {activeView === "chat" && (
        <WorkspaceNotesPane
          open={workspaceNotesOpen}
          width={workspaceNotesWidth}
          scopeId={workspaceNoteScopeId}
          scopeTitle={workspaceNoteScopeTitle}
          onToggle={() => setWorkspaceNotesOpen((value) => !value)}
          onResizeStart={startWorkspaceNotesResize}
          onPinNote={pinSource}
        />
      )}

      <main className="w-full min-w-0 min-h-0 flex-1 flex flex-col overflow-x-hidden">
        <header className="rm-topbar h-12 px-4 border-b border-border bg-card flex items-center gap-3 shrink-0 overflow-x-auto">
          <button
            type="button"
            title={sidebarOpen ? "Collapse topology" : "Open topology"}
            onClick={() => setSidebarOpen((value) => !value)}
            className="w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <Menu size={15} />
          </button>
          <div className="w-px h-4 bg-border" />
          <Network size={14} className="text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {headerTitle}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {headerSubtitle}
            </p>
          </div>
          {activeView === "chat" && (
            <button
              type="button"
              onClick={() => setTopologyExplorerOpen((value) => !value)}
              className={`h-8 px-3 rounded-md border text-xs flex items-center gap-2 ${
                topologyExplorerOpen
                  ? "rm-active-surface text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}
            >
              <MapIcon size={13} />
              {topologyExplorerOpen ? "Chat" : "Topology"}
            </button>
          )}
          <div className="ml-auto hidden sm:flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                backendOnline ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <span className="font-mono text-[10px] text-muted-foreground">
              {backendOnline ? "Backend online" : "Backend offline"}
            </span>
          </div>
        </header>

        <div
          className={`flex-1 min-h-0 ${
            activeView === "library" ||
            activeView === "crawler" ||
            activeView === "reddit" ||
            activeView === "notes" ||
            activeView === "agent" ||
            activeView === "graph" ||
            activeView === "evaluation"
              ? "overflow-hidden p-0 flex flex-col"
              : topologyExplorerOpen
                ? "overflow-hidden px-5 md:px-8 py-6"
                : "overflow-y-auto space-y-6 px-5 md:px-8 py-6"
          }`}
        >
          {activeView === "library" ? (
            <PaperLibraryView
              articles={libraryArticles}
              ingestionJobs={ingestionJobs}
              domainOptions={domainOptions}
              categoryOptions={categoryOptions}
              selectedDomain={selectedDomain}
              selectedCategory={selectedCategory}
              search={librarySearch}
              isBuildingTopology={isBuildingTopology}
              onSearchChange={setLibrarySearch}
              onDomainChange={(domain) => {
                setSelectedDomain(domain);
                setSelectedCategory("");
              }}
              onCategoryChange={setSelectedCategory}
              onOpenArticle={openLibraryArticle}
              onChatWithArticle={chatWithLibraryArticle}
              onRebuildTopology={() => void rebuildCurrentTopology()}
            />
          ) : activeView === "agent" ? (
            <AgentConsoleView onRun={runAgentCommand} />
          ) : activeView === "graph" ? (
            <GraphRagView
              domain={selectedDomain || undefined}
              category={selectedCategory || undefined}
            />
          ) : activeView === "evaluation" ? (
            <EvaluationDashboard />
          ) : activeView === "notes" ? (
            <NotesView
              onOpenNote={openAnnotation}
              onPinNote={(source) => {
                pinSource(source);
                setActiveView("chat");
              }}
            />
          ) : activeView === "crawler" ? (
            <CrawlerView
              description={crawlerDescription}
              category={crawlerCategory}
              sortBy={crawlerSortBy}
              maxResults={crawlerMaxResults}
              sources={crawlerSources}
              results={crawlerResults}
              query={crawlerQuery}
              status={crawlerStatus}
              isSearching={isCrawlerSearching}
              addingPaperId={addingCrawlerPaperId}
              ingestionJobs={ingestionJobs}
              onDescriptionChange={setCrawlerDescription}
              onCategoryChange={setCrawlerCategory}
              onSortByChange={setCrawlerSortBy}
              onMaxResultsChange={setCrawlerMaxResults}
              onSourcesChange={setCrawlerSources}
              onSearch={() => void searchCrawler()}
              onAddPaper={(paper) => void addCrawlerPaper(paper)}
            />
          ) : activeView === "reddit" ? (
            <RedditView />
          ) : topologyExplorerOpen ? (
            <TopologyExplorer
              graph={graph}
              selectedCluster={selectedCluster}
              onSelectCluster={chooseCluster}
              onClear={clearCluster}
              onClose={() => setTopologyExplorerOpen(false)}
            />
          ) : (
            <>
              {loadError && (
                <div className="max-w-3xl mx-auto border border-destructive/40 bg-destructive/10 rounded px-4 py-3 text-xs text-destructive">
                  Topology could not be loaded: {loadError}
                </div>
              )}
              <div className="max-w-3xl mx-auto space-y-6">
                {messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    onOpenSource={openSourceCitation}
                  />
                ))}
                {isTyping && (
                  <div className="flex gap-3">
                    <div className="w-8 h-8 rounded bg-background border border-border flex items-center justify-center text-muted-foreground">
                      <Bot size={14} />
                    </div>
                    <div className="bg-card border border-border rounded px-4 py-3 flex items-center gap-1.5">
                      {[0, 150, 300].map((delay) => (
                        <span
                          key={delay}
                          className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
                          style={{ animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            </>
          )}
        </div>

        {activeView === "chat" && (
        <div className="border-t border-border bg-background p-4 shrink-0">
          <div className="w-full min-w-0 max-w-[calc(100vw_-_2rem)] md:max-w-3xl mx-auto">
            {pinnedSources.length > 0 && (
              <div className="mb-2 flex items-center gap-2 overflow-x-auto pb-1">
                <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                  Using
                </span>
                {pinnedSources.map((source, index) => (
                  <button
                    type="button"
                    key={sourceKey(source)}
                    onClick={() => removePinnedSource(source)}
                    title="Remove selected context"
                    className="h-7 max-w-52 px-2 rounded border border-border bg-card text-muted-foreground hover:text-foreground flex items-center gap-1.5 shrink-0"
                  >
                    <span className="text-[10px] truncate">
                      {source.selection
                        ? `PDF selection · ${typeof source.page === "number" ? `p.${source.page}` : "selected text"}`
                        : sourceTextValue(source.source) || `Source ${index + 1}`}
                    </span>
                    <X size={10} />
                  </button>
                ))}
              </div>
            )}
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-1 rounded border border-border bg-background p-1">
                {(["vector", "graph", "hybrid"] as RetrievalStrategy[]).map((strategy) => {
                  const isActive = retrievalStrategy === strategy;
                  return (
                    <button
                      key={strategy}
                      type="button"
                      onClick={() => setRetrievalStrategy(strategy)}
                      className={`h-7 rounded px-2.5 text-[11px] font-medium capitalize transition-colors ${
                        isActive
                          ? "bg-secondary text-foreground border border-border"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                    >
                      {strategy}
                    </button>
                  );
                })}
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                {retrievalStrategy === "hybrid"
                    ? "Vector + graph-guided retrieval"
                    : retrievalStrategy === "graph"
                      ? "Graph-guided paper retrieval"
                      : "Vector similarity retrieval"}
              </span>
            </div>
            <div className="rm-chat-input relative rounded border border-border bg-background focus-within:border-ring">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                rows={3}
                placeholder={
                  selectedDocument
                    ? "Ask about this article…"
                    : selectedCluster
                      ? "Ask a question across this paper cluster…"
                      : "Ask a research question across all papers…"
                }
                className="block w-full min-w-0 bg-transparent px-4 pt-3 pb-11 resize-none outline-none text-sm text-foreground placeholder:text-muted-foreground leading-relaxed"
              />
              <div className="absolute bottom-2.5 right-2.5 flex items-center gap-2">
                <span className="hidden md:inline font-mono text-[10px] text-muted-foreground">
                  Enter to send · Shift+Enter for newline
                </span>
                <button
                  type="button"
                  title="Send message"
                  disabled={!input.trim() || isTyping}
                  onClick={() => void submitQuestion()}
                  className="w-8 h-8 rounded bg-secondary border border-border text-foreground flex items-center justify-center disabled:opacity-35 hover:bg-accent"
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
            <div className="mt-2 px-1 flex items-center gap-2">
              <CheckCircle2 size={11} className="text-muted-foreground" />
              <p className="font-mono text-[10px] text-muted-foreground truncate">
                {selectedDocument ? "Grounded retrieval" : `${retrievalStrategy} retrieval`} - {scopeLabel}
              </p>
            </div>
          </div>
        </div>
        )}
      </main>

      {activeView === "chat" && readerDocument ? (
        <DocumentReader
          document={readerDocument}
          initialPage={readerInitialPage}
          onClose={() => {
            setReaderDocument(undefined);
            setReaderInitialPage(undefined);
          }}
          onPinSelection={(source) => {
            pinSource(source);
          }}
        />
      ) : activeView === "chat" ? (
        <ResearchPanel
          selectedCluster={selectedCluster}
          documents={clusterDocuments}
          selectedDocument={selectedDocument}
          detail={documentDetail}
          sources={sources}
          pinnedSources={pinnedSources}
          onSelectDocument={setSelectedDocument}
          contextMode={contextMode}
          onContextModeChange={setContextMode}
          onOpenDocument={(document) => {
            setSelectedDocument(document);
            setReaderDocument(document);
            setReaderInitialPage(undefined);
            setSidebarOpen(false);
          }}
          onPinSource={pinSource}
        />
      ) : null}
    </div>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AppContent />
    </AppErrorBoundary>
  );
}

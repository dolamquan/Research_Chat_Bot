import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  Bot,
  CheckCircle2,
  FileText,
  History,
  Menu,
  MessageSquare,
  Network,
  Plus,
  Search,
  Send,
  User,
  X,
} from "lucide-react";

import {
  deleteChatSession,
  getChatSession,
  getChatSessions,
  getClusters,
  getDocumentDetail,
  getHealth,
  sendChat,
} from "./api";
import { DocumentReader } from "./components/DocumentReader";
import { ResearchPanel } from "./components/ResearchPanel";
import { TopologyPanel } from "./components/TopologyPanel";
import type {
  Cluster,
  ClusterDocument,
  ClusterGraph,
  ChatSession,
  DocumentDetail,
  Message,
  Source,
  ContextMode,
} from "./types";

const EMPTY_GRAPH: ClusterGraph = { clusters: [], documents: [] };

function initialMessage(cluster?: Cluster): Message {
  return {
    id: `welcome-${cluster?.cluster_id ?? "all"}`,
    role: "assistant",
    content: cluster
      ? `You are now exploring **${cluster.cluster_label}**. I will retrieve answers only from the ${cluster.document_count} papers in this cluster. Select an article on the right to read it, or ask a question across the cluster.`
      : "Welcome to **ResearchMind**. Explore the paper topology to focus on a research cluster, or ask a question across all indexed papers. Every response is grounded in retrieved passages from your collection.",
    timestamp: new Date(),
  };
}

function titleFromSource(source: string): string {
  return source
    .replace(/\.pdf$/i, "")
    .replace(/^\d{4}\.\d+(?:v\d+)?_/i, "")
    .replace(/[_-]+/g, " ");
}

function sourceKey(source: Source): string {
  return [
    source.id,
    source.source,
    source.page,
    source.text?.slice(0, 100),
  ].join(":");
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

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div
      className={`w-full min-w-0 flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <div
        className={`w-8 h-8 shrink-0 rounded flex items-center justify-center ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-secondary border border-border text-primary"
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div
        className={`min-w-0 max-w-[calc(100vw_-_5.5rem)] md:max-w-[78%] flex flex-col gap-1.5 ${
          isUser ? "items-end" : "items-start"
        }`}
      >
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-card border border-border text-secondary-foreground"
          }`}
        >
          <div className="break-words overflow-hidden">
            <FormattedText content={message.content} />
          </div>
        </div>
        {message.sources && message.sources.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground px-1">
            {message.sources.length} grounded source
            {message.sources.length === 1 ? "" : "s"}
          </span>
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

export default function App() {
  const [graph, setGraph] = useState<ClusterGraph>(EMPTY_GRAPH);
  const [selectedCluster, setSelectedCluster] = useState<Cluster>();
  const [selectedDocument, setSelectedDocument] = useState<ClusterDocument>();
  const [documentDetail, setDocumentDetail] = useState<DocumentDetail>();
  const [readerDocument, setReaderDocument] = useState<ClusterDocument>();
  const [messages, setMessages] = useState<Message[]>([initialMessage()]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [sources, setSources] = useState<Source[]>([]);
  const [pinnedSources, setPinnedSources] = useState<Source[]>([]);
  const [contextMode, setContextMode] = useState<ContextMode>("retrieval");
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth >= 768,
  );
  const [loadError, setLoadError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

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

    Promise.all([getHealth(), getClusters()])
      .then(([, clusterGraph]) => {
        if (!active) return;
        setBackendOnline(true);
        setGraph(clusterGraph);
        setLoadError("");
      })
      .catch((error: Error) => {
        if (!active) return;
        setBackendOnline(false);
        setLoadError(error.message);
      });

    return () => {
      active = false;
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

  async function submitQuestion() {
    const question = input.trim();
    if (!question || isTyping) return;

    const history = messages.map(({ role, content }) => ({ role, content }));
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question,
      timestamp: new Date(),
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setIsTyping(true);

    try {
      const result = await sendChat({
        sessionId: activeSessionId,
        question,
        chatHistory: history,
        pinnedSources,
        clusterId: selectedCluster?.cluster_id,
        documentSource: selectedDocument?.source,
        contextMode: selectedDocument ? contextMode : "retrieval",
      });

      setActiveSessionId(result.session_id);
      void refreshChatSessions();
      setSources(result.sources || []);
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: result.answer,
          sources: result.sources,
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

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitQuestion();
    }
  }

  const scopeLabel = selectedDocument
    ? titleFromSource(selectedDocument.source)
    : selectedCluster?.cluster_label || "All indexed papers";

  return (
    <div
      className="h-screen w-screen bg-background text-foreground flex overflow-hidden"
      style={{ fontFamily: "'Inter', sans-serif" }}
    >
      <aside
        className={`${
          sidebarOpen ? "w-80" : "w-0"
        } fixed md:relative inset-y-0 left-0 z-40 shrink-0 bg-card border-r border-border flex flex-col overflow-hidden transition-[width] duration-200`}
      >
        <div className="h-16 px-4 border-b border-border flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 bg-primary rounded flex items-center justify-center">
            <Search size={15} className="text-primary-foreground" />
          </div>
          <div className="min-w-0">
            <h1
              className="text-sm font-semibold tracking-tight"
              style={{ fontFamily: "'Epilogue', sans-serif" }}
            >
              ResearchMind
            </h1>
            <p className="text-xs text-muted-foreground">
              Research topology chatbot
            </p>
          </div>
        </div>

        <div className="p-3 shrink-0">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground px-1 mb-2">
            Scope
          </p>
          <button
            type="button"
            onClick={clearCluster}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded border text-left ${
              !selectedCluster
                ? "border-primary/25 bg-primary/10"
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
              <p className="font-mono text-[10px] text-muted-foreground">
                {graph.documents.length} research PDFs
              </p>
            </div>
          </button>
        </div>

        <div className="px-3 pb-3 shrink-0 border-b border-border">
          <div className="flex items-center gap-2 px-1 mb-2">
            <History size={12} className="text-primary" />
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Past chats
            </p>
            <button
              type="button"
              title="Start new chat"
              onClick={startNewChat}
              className="ml-auto w-6 h-6 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-secondary"
            >
              <Plus size={12} />
            </button>
          </div>

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
        </div>

        <TopologyPanel
          graph={graph}
          selectedCluster={selectedCluster}
          onSelectCluster={chooseCluster}
          onClear={clearCluster}
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

      <main className="w-full min-w-0 flex-1 flex flex-col overflow-x-hidden">
        <header className="h-12 px-4 border-b border-border bg-card flex items-center gap-3 shrink-0">
          <button
            type="button"
            title={sidebarOpen ? "Collapse topology" : "Open topology"}
            onClick={() => setSidebarOpen((value) => !value)}
            className="w-8 h-8 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <Menu size={15} />
          </button>
          <div className="w-px h-4 bg-border" />
          <Network size={14} className="text-primary" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {scopeLabel}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {selectedDocument
                ? contextMode === "whole_document"
                  ? "Whole-paper context"
                  : "Article-only retrieval"
                : selectedCluster
                  ? `${selectedCluster.document_count} paper cluster`
                  : "Full collection retrieval"}
            </p>
          </div>
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

        <div className="flex-1 min-h-0 overflow-y-auto px-5 md:px-8 py-6 space-y-6">
          {loadError && (
            <div className="max-w-3xl mx-auto border border-destructive/40 bg-destructive/10 rounded px-4 py-3 text-xs text-destructive">
              Topology could not be loaded: {loadError}
            </div>
          )}
          <div className="max-w-3xl mx-auto space-y-6">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {isTyping && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded bg-secondary border border-border flex items-center justify-center text-primary">
                  <Bot size={14} />
                </div>
                <div className="bg-card border border-border rounded-lg px-4 py-3 flex items-center gap-1.5">
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-border bg-card p-4 shrink-0">
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
                    className="h-7 max-w-52 px-2 rounded border border-primary/25 bg-primary/10 text-primary flex items-center gap-1.5 shrink-0"
                  >
                    <span className="text-[10px] truncate">
                      {source.selection
                        ? `PDF selection · p.${source.page}`
                        : source.source || `Source ${index + 1}`}
                    </span>
                    <X size={10} />
                  </button>
                ))}
              </div>
            )}
            <div className="relative rounded-lg border border-border bg-background focus-within:border-primary/50">
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
                  className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-35"
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
            <div className="mt-2 px-1 flex items-center gap-2">
              <CheckCircle2 size={11} className="text-primary" />
              <p className="font-mono text-[10px] text-muted-foreground truncate">
                Grounded retrieval · {scopeLabel}
              </p>
            </div>
          </div>
        </div>
      </main>

      {readerDocument ? (
        <DocumentReader
          document={readerDocument}
          onClose={() => setReaderDocument(undefined)}
          onPinSelection={(source) => {
            pinSource(source);
          }}
        />
      ) : (
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
            setSidebarOpen(false);
          }}
          onPinSource={pinSource}
        />
      )}
    </div>
  );
}

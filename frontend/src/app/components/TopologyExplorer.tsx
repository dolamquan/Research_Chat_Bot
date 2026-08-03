import { RotateCcw, Search, X } from "lucide-react";

import type { Cluster, ClusterDocument, ClusterGraph } from "../types";

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

function clusterColor(clusterId: number): string {
  return CLUSTER_COLORS[Math.abs(clusterId) % CLUSTER_COLORS.length];
}

function graphPosition(value: number, size: number, padding: number): number {
  const normalized = (Math.max(-1, Math.min(1, value)) + 1) / 2;
  return padding + normalized * (size - padding * 2);
}

function titleFromSource(source: string): string {
  return source
    .replace(/\.pdf$/i, "")
    .replace(/^\d{4}\.\d+(?:v\d+)?_/i, "")
    .replace(/[_-]+/g, " ");
}

export function TopologyExplorer({
  graph,
  selectedCluster,
  onSelectCluster,
  onClear,
  onClose,
}: {
  graph: ClusterGraph;
  selectedCluster?: Cluster;
  onSelectCluster: (cluster: Cluster) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const width = 980;
  const height = 620;
  const padding = 48;
  return (
    <div className="h-full min-h-0 max-w-7xl mx-auto flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
          <Search size={15} />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">
            Paper topology
          </h2>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {selectedCluster && (
            <button
              type="button"
              onClick={onClear}
              className="h-8 px-3 rounded border border-border text-xs text-foreground hover:bg-secondary flex items-center gap-2"
            >
              <RotateCcw size={13} />
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Return to chat"
            className="w-8 h-8 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary flex items-center justify-center"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 grid grid-cols-[minmax(0,1fr)_280px] gap-4">
        <div className="min-h-0 rounded border border-border bg-[#08090b] overflow-hidden">
          {graph.documents.length > 0 ? (
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="block w-full h-full"
              role="img"
              aria-label="Large paper cluster topology"
            >
              <rect width={width} height={height} fill="#08090b" />
              {graph.documents.map((document: ClusterDocument) => {
                const active =
                  selectedCluster?.cluster_id === document.cluster_id;
                const color = clusterColor(document.cluster_id);

                return (
                  <circle
                    key={document.source}
                    cx={graphPosition(document.x, width, padding)}
                    cy={graphPosition(-document.y, height, padding)}
                    r={active ? 9 : 6}
                    fill={color}
                    fillOpacity={selectedCluster && !active ? 0.16 : 0.86}
                    stroke={active ? "#ffffff" : color}
                    strokeOpacity={active ? 0.95 : 0.35}
                    strokeWidth={active ? 2.2 : 1}
                    filter={active ? "url(#activeClusterGlow)" : undefined}
                    className="cursor-pointer transition-opacity"
                    onClick={() => {
                      const cluster = graph.clusters.find(
                        (item) => item.cluster_id === document.cluster_id,
                      );
                      if (cluster) onSelectCluster(cluster);
                    }}
                  >
                    <title>{titleFromSource(document.source)}</title>
                  </circle>
                );
              })}
              <defs>
                <filter id="activeClusterGlow" x="-80%" y="-80%" width="260%" height="260%">
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
            </svg>
          ) : (
            <div className="h-full flex items-center justify-center text-center px-8">
              <p className="text-xs text-muted-foreground">
                Start the backend to load the saved research topology.
              </p>
            </div>
          )}
        </div>

        <aside className="min-h-0 rounded border border-border bg-card flex flex-col">
          <div className="p-3 border-b border-border shrink-0">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Clusters
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
            {graph.clusters.map((cluster) => {
              const active = selectedCluster?.cluster_id === cluster.cluster_id;
              const color = clusterColor(cluster.cluster_id);

              return (
                <button
                  type="button"
                  key={cluster.cluster_id}
                  onClick={() => onSelectCluster(cluster)}
                  className={`w-full rounded border px-2.5 py-2 text-left ${
                    active
                      ? "border-primary/35 bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-secondary"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        backgroundColor: color,
                        boxShadow: active ? `0 0 0 3px ${color}22` : undefined,
                      }}
                    />
                    <span
                      className={`min-w-0 truncate text-xs ${
                        active ? "text-primary" : "text-foreground"
                      }`}
                    >
                      {cluster.cluster_label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="p-3 border-t border-border shrink-0">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Selection
            </p>
            <p className="mt-1 text-xs text-foreground leading-snug">
              {selectedCluster?.cluster_label || "All indexed papers"}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

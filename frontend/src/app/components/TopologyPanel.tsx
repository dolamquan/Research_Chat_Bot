import { ChevronRight, Maximize2, Network, RotateCcw } from "lucide-react";

import type { Cluster, ClusterDocument, ClusterGraph } from "../types";

const CLUSTER_COLORS = [
  "#d4a843",
  "#55a89b",
  "#a76ab6",
  "#c45a73",
  "#7191d0",
  "#8ca54f",
  "#d18d36",
  "#5fa3a9",
  "#b678a9",
  "#d06e55",
  "#7f7ac7",
  "#a9a34e",
];

function graphPosition(value: number, size: number, padding: number): number {
  const normalized = (Math.max(-1, Math.min(1, value)) + 1) / 2;
  return padding + normalized * (size - padding * 2);
}

export function TopologyPanel({
  graph,
  selectedCluster,
  onSelectCluster,
  onClear,
  onExpand,
}: {
  graph: ClusterGraph;
  selectedCluster?: Cluster;
  onSelectCluster: (cluster: Cluster) => void;
  onClear: () => void;
  onExpand: () => void;
}) {
  const size = 280;
  const padding = 18;

  return (
    <section className="min-h-0 flex-1 border-t border-border flex flex-col">
      <div className="px-4 py-3 flex items-center gap-2">
        <Network size={14} className="text-primary" />
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-foreground">Paper Topology</h2>
        </div>
        <button
          type="button"
          title="Open large topology view"
          onClick={onExpand}
          className="ml-auto w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary"
        >
          <Maximize2 size={13} />
        </button>
        {selectedCluster && (
          <button
            type="button"
            title="Clear cluster selection"
            onClick={onClear}
            className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>

      <div className="mx-3 border border-border rounded bg-[#0b0c0e] overflow-hidden shrink-0">
        {graph.documents.length > 0 ? (
          <svg
            viewBox={`0 0 ${size} ${size}`}
            className="block w-full aspect-square"
            role="img"
            aria-label="Interactive paper cluster topology"
          >
            {graph.documents.map((document: ClusterDocument) => {
              const active = selectedCluster?.cluster_id === document.cluster_id;
              const color =
                CLUSTER_COLORS[document.cluster_id % CLUSTER_COLORS.length];

              return (
                <circle
                  key={document.source}
                  cx={graphPosition(document.x, size, padding)}
                  cy={graphPosition(-document.y, size, padding)}
                  r={active ? 5 : 3.5}
                  fill={color}
                  fillOpacity={selectedCluster && !active ? 0.25 : 0.82}
                  stroke={active ? "#ffffff" : "transparent"}
                  strokeWidth={active ? 1.5 : 0}
                  className="cursor-pointer transition-opacity"
                  onClick={() => {
                    const cluster = graph.clusters.find(
                      (item) => item.cluster_id === document.cluster_id,
                    );
                    if (cluster) onSelectCluster(cluster);
                  }}
                />
              );
            })}
          </svg>
        ) : (
          <div className="aspect-square flex items-center justify-center px-8 text-center">
            <p className="text-xs text-muted-foreground">
              Start the backend to load the saved research topology.
            </p>
          </div>
        )}
      </div>

      <div className="mt-3 px-3 pb-3 space-y-1 overflow-y-auto">
        {graph.clusters.map((cluster, index) => {
          const active = selectedCluster?.cluster_id === cluster.cluster_id;

          return (
            <button
              type="button"
              key={cluster.cluster_id}
              onClick={() => onSelectCluster(cluster)}
              className={`w-full flex items-center gap-2 px-2.5 py-2 rounded border text-left transition-colors ${
                active
                  ? "bg-primary/10 border-primary/30"
                  : "border-transparent hover:border-border hover:bg-secondary"
              }`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: CLUSTER_COLORS[index % CLUSTER_COLORS.length] }}
              />
              <span
                className={`text-xs truncate ${active ? "text-primary" : "text-foreground"}`}
              >
                {cluster.cluster_label}
              </span>
              <ChevronRight size={11} className="text-muted-foreground" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

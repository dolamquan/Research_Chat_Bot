import argparse

from app.rag.clusterer import build_cluster_graph


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build article clusters and topology coordinates from Qdrant vectors."
    )
    parser.add_argument("--cluster-count", type=int, default=None)
    args = parser.parse_args()

    graph = build_cluster_graph(cluster_count=args.cluster_count)

    print("Cluster build complete.")
    print(f"Clusters: {len(graph['clusters'])}")
    print(f"Documents: {len(graph['documents'])}")


if __name__ == "__main__":
    main()

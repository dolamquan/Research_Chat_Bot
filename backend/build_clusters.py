import argparse

from app.rag.clusterer import build_cluster_graph


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build article clusters and topology coordinates from Qdrant vectors."
    )
    parser.add_argument("--cluster-count", type=int, default=None)
    parser.add_argument("--domain", default=None)
    parser.add_argument("--category", default=None)
    args = parser.parse_args()

    graph = build_cluster_graph(
        cluster_count=args.cluster_count,
        domain=args.domain,
        category=args.category,
    )

    print("Cluster build complete.")
    print(f"Domain: {args.domain or 'all'}")
    print(f"Category: {args.category or 'all'}")
    print(f"Clusters: {len(graph['clusters'])}")
    print(f"Documents: {len(graph['documents'])}")


if __name__ == "__main__":
    main()

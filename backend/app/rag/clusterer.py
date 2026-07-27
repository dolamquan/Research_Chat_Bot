import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
from qdrant_client.models import FieldCondition, Filter, MatchValue

from app.rag.vector_store import COLLECTION_NAME, DATA_DIR, get_client


CLUSTERS_PATH = DATA_DIR / "clusters.json"
TITLE_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "based",
    "for",
    "from",
    "in",
    "into",
    "is",
    "of",
    "on",
    "or",
    "rag",
    "retrieval",
    "retrievals",
    "augmented",
    "augmentation",
    "generation",
    "generative",
    "large",
    "language",
    "llm",
    "llms",
    "model",
    "models",
    "paper",
    "study",
    "the",
    "to",
    "towards",
    "using",
    "via",
    "with",
    "v1",
    "v2",
    "v3",
    "v4",
    "v5",
}


def _as_vector(vector: Any) -> np.ndarray | None:
    if vector is None:
        return None

    if isinstance(vector, dict):
        vector = next(iter(vector.values()), None)

    if vector is None:
        return None

    array = np.asarray(vector, dtype=np.float32)

    if array.ndim != 1 or array.size == 0:
        return None

    return array


def _document_key(payload: Dict[str, Any]) -> str:
    return str(payload.get("source") or payload.get("document_id") or "unknown")


def _label_from_sources(sources: List[str]) -> str:
    words: List[str] = []

    for source in sources:
        stem = Path(source).stem.lower()
        stem = re.sub(r"^\d{4}\.\d+(?:v\d+)?_", "", stem)
        stem = stem.replace("_", " ").replace("-", " ")
        words.extend(re.findall(r"[a-z][a-z0-9]{2,}", stem))

    counts = Counter(
        word
        for word in words
        if word not in TITLE_STOPWORDS and not word.isdigit()
    )
    top_words = [word for word, _ in counts.most_common(4)]

    if top_words:
        return " ".join(word.title() for word in top_words)

    return "Research Cluster"


def _normalize_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return matrix / norms


def _choose_cluster_count(document_count: int) -> int:
    if document_count <= 2:
        return max(1, document_count)

    return min(12, max(3, round(math.sqrt(document_count / 2))))


def _kmeans(vectors: np.ndarray, cluster_count: int, iterations: int = 40) -> np.ndarray:
    rng = np.random.default_rng(42)
    document_count = vectors.shape[0]
    cluster_count = min(cluster_count, document_count)

    centroid_indexes = rng.choice(document_count, size=cluster_count, replace=False)
    centroids = vectors[centroid_indexes].copy()

    labels = np.zeros(document_count, dtype=np.int32)

    for _ in range(iterations):
        distances = np.linalg.norm(vectors[:, None, :] - centroids[None, :, :], axis=2)
        next_labels = np.argmin(distances, axis=1)

        if np.array_equal(labels, next_labels):
            break

        labels = next_labels

        for cluster_id in range(cluster_count):
            members = vectors[labels == cluster_id]

            if len(members) == 0:
                centroids[cluster_id] = vectors[rng.integers(0, document_count)]
            else:
                centroids[cluster_id] = members.mean(axis=0)

    return labels


def _pca_2d(vectors: np.ndarray) -> np.ndarray:
    if vectors.shape[0] == 1:
        return np.zeros((1, 2), dtype=np.float32)

    centered = vectors - vectors.mean(axis=0, keepdims=True)
    _, _, vh = np.linalg.svd(centered, full_matrices=False)
    coordinates = centered @ vh[:2].T

    if coordinates.shape[1] == 1:
        coordinates = np.column_stack([coordinates[:, 0], np.zeros(vectors.shape[0])])

    max_abs = float(np.abs(coordinates).max())

    if max_abs > 0:
        coordinates = coordinates / max_abs

    return coordinates.astype(np.float32)


def collect_document_vectors() -> List[Dict[str, Any]]:
    client = get_client()
    offset: Any = None
    vectors_by_document: Dict[str, List[np.ndarray]] = defaultdict(list)
    payloads_by_document: Dict[str, Dict[str, Any]] = {}
    chunk_counts: Counter[str] = Counter()

    while True:
        points, offset = client.scroll(
            collection_name=COLLECTION_NAME,
            limit=512,
            offset=offset,
            with_payload=True,
            with_vectors=True,
        )

        if not points:
            break

        for point in points:
            payload = point.payload or {}
            vector = _as_vector(point.vector)

            if vector is None:
                continue

            key = _document_key(payload)
            vectors_by_document[key].append(vector)
            payloads_by_document.setdefault(key, payload)
            chunk_counts[key] += 1

        if offset is None:
            break

    documents = []

    for key, vectors in vectors_by_document.items():
        vector_matrix = np.vstack(vectors)
        averaged_vector = vector_matrix.mean(axis=0)
        payload = payloads_by_document.get(key, {})

        documents.append(
            {
                "document_id": payload.get("document_id"),
                "source": key,
                "chunk_count": chunk_counts[key],
                "vector": averaged_vector,
            }
        )

    documents.sort(key=lambda item: item["source"])
    return documents


def save_clusters(graph: Dict[str, Any]) -> None:
    CLUSTERS_PATH.write_text(json.dumps(graph, indent=2), encoding="utf-8")


def load_clusters() -> Dict[str, Any]:
    if not CLUSTERS_PATH.exists():
        return {"clusters": [], "documents": []}

    return json.loads(CLUSTERS_PATH.read_text(encoding="utf-8"))


def get_cluster_documents(cluster_id: int) -> List[Dict[str, Any]]:
    graph = load_clusters()
    documents = graph.get("documents", [])

    return sorted(
        [
            document
            for document in documents
            if document.get("cluster_id") == cluster_id
        ],
        key=lambda document: document.get("source", ""),
    )


def get_document_detail(source: str, chunk_limit: int = 5) -> Dict[str, Any]:
    graph = load_clusters()
    document = next(
        (
            item
            for item in graph.get("documents", [])
            if item.get("source") == source
        ),
        None,
    )

    if document is None:
        raise ValueError(f"Document not found in cluster graph: {source}")

    client = get_client()
    points, _ = client.scroll(
        collection_name=COLLECTION_NAME,
        limit=chunk_limit,
        with_payload=True,
        with_vectors=False,
        scroll_filter=Filter(
            must=[
                FieldCondition(
                    key="source",
                    match=MatchValue(value=source),
                )
            ]
        ),
    )

    chunks = []

    for point in points:
        payload = point.payload or {}
        chunks.append(
            {
                "id": point.id,
                "text": payload.get("text", ""),
                "parent_id": payload.get("parent_id"),
                "document_id": payload.get("document_id"),
                "parent_index": payload.get("parent_index"),
                "child_index": payload.get("child_index"),
                "source": payload.get("source"),
                "topic": payload.get("topic", "unknown"),
                "document_type": payload.get("document_type", "unknown"),
                "section_type": payload.get("section_type", "unknown"),
                "keywords": payload.get("keywords", []),
                "summary": payload.get("summary", ""),
                "cluster_id": payload.get("cluster_id"),
                "cluster_label": payload.get("cluster_label"),
            }
        )

    return {
        **document,
        "preview_chunks": chunks,
    }


def write_cluster_payloads(documents: List[Dict[str, Any]]) -> None:
    client = get_client()

    for document in documents:
        source = document["source"]
        cluster_id = document["cluster_id"]
        cluster_label = document["cluster_label"]

        client.set_payload(
            collection_name=COLLECTION_NAME,
            payload={
                "cluster_id": cluster_id,
                "cluster_label": cluster_label,
            },
            wait=False,
            points=Filter(
                must=[
                    FieldCondition(
                        key="source",
                        match=MatchValue(value=source),
                    )
                ]
            ),
        )


def build_cluster_graph(cluster_count: int | None = None) -> Dict[str, Any]:
    documents = collect_document_vectors()

    if not documents:
        graph = {"clusters": [], "documents": []}
        save_clusters(graph)
        return graph

    vectors = np.vstack([document["vector"] for document in documents])
    vectors = _normalize_rows(vectors)

    if cluster_count is None:
        cluster_count = _choose_cluster_count(len(documents))

    labels = _kmeans(vectors, cluster_count=cluster_count)
    coordinates = _pca_2d(vectors)

    sources_by_cluster: Dict[int, List[str]] = defaultdict(list)
    counts_by_cluster: Counter[int] = Counter()

    for label, document in zip(labels, documents):
        cluster_id = int(label)
        sources_by_cluster[cluster_id].append(document["source"])
        counts_by_cluster[cluster_id] += 1

    cluster_labels = {
        cluster_id: _label_from_sources(sources)
        for cluster_id, sources in sources_by_cluster.items()
    }

    graph_documents = []

    for index, document in enumerate(documents):
        cluster_id = int(labels[index])
        x, y = coordinates[index]

        graph_document = {
            "document_id": document["document_id"],
            "source": document["source"],
            "chunk_count": int(document["chunk_count"]),
            "cluster_id": cluster_id,
            "cluster_label": cluster_labels[cluster_id],
            "x": float(x),
            "y": float(y),
        }
        graph_documents.append(graph_document)

    graph_clusters = [
        {
            "cluster_id": cluster_id,
            "cluster_label": cluster_labels[cluster_id],
            "document_count": counts_by_cluster[cluster_id],
        }
        for cluster_id in sorted(counts_by_cluster)
    ]

    graph = {
        "clusters": graph_clusters,
        "documents": graph_documents,
    }

    save_clusters(graph)
    write_cluster_payloads(graph_documents)
    return graph

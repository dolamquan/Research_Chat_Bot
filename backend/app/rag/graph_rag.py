import json
import math
import re
import hashlib
from collections import Counter, defaultdict, deque
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from app.rag.vector_store import DATA_DIR
from app.storage.article_store import list_articles


GRAPH_DIR = DATA_DIR / "graph_rag"

STOPWORDS = {
    "about",
    "across",
    "after",
    "against",
    "also",
    "among",
    "analysis",
    "and",
    "approach",
    "are",
    "based",
    "been",
    "between",
    "can",
    "data",
    "dataset",
    "datasets",
    "deep",
    "different",
    "document",
    "documents",
    "during",
    "each",
    "embedding",
    "embeddings",
    "evaluation",
    "from",
    "generation",
    "graph",
    "have",
    "how",
    "into",
    "language",
    "large",
    "learning",
    "llm",
    "llms",
    "method",
    "model",
    "models",
    "multi",
    "paper",
    "papers",
    "retrieval",
    "retrieval-augmented",
    "rag",
    "results",
    "show",
    "study",
    "system",
    "systems",
    "that",
    "the",
    "their",
    "this",
    "through",
    "using",
    "with",
}


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "unknown"


def _normalize_article_ids(article_ids: List[str] | None = None) -> List[str]:
    return sorted({str(article_id).strip() for article_id in article_ids or [] if str(article_id).strip()})


def _scope_name(
    domain: str | None = None,
    category: str | None = None,
    article_ids: List[str] | None = None,
) -> str:
    parts = [
        _slug(domain) if domain else "all-domains",
        _slug(category) if category else "all-categories",
    ]
    selected_ids = _normalize_article_ids(article_ids)
    if selected_ids:
        digest = hashlib.sha1("|".join(selected_ids).encode("utf-8")).hexdigest()[:12]
        parts.append(f"papers-{digest}")
    return "__".join(parts)


def _graph_path(
    domain: str | None = None,
    category: str | None = None,
    article_ids: List[str] | None = None,
) -> Path:
    return GRAPH_DIR / f"{_scope_name(domain, category, article_ids)}.json"


def _terms(text: str) -> List[str]:
    return [
        term
        for term in re.findall(r"[a-z][a-z0-9-]{2,}", text.lower())
        if term not in STOPWORDS and not term.isdigit()
    ]


def _concept_label(value: str) -> str:
    return value.replace("-", " ").title()


def extract_concepts(article: Dict[str, Any], limit: int = 12) -> List[str]:
    tags = [str(tag).strip().lower() for tag in article.get("tags", []) if str(tag).strip()]
    category = str(article.get("category") or "").strip().lower()
    domain = str(article.get("domain") or "").strip().lower()
    text = " ".join(
        [
            str(article.get("title") or ""),
            str(article.get("abstract") or ""),
            " ".join(tags),
            category,
            domain,
        ]
    )

    counter = Counter(_terms(text))
    for tag in tags:
        for term in _terms(tag):
            counter[term] += 4
    for term in _terms(category):
        counter[term] += 2

    return [term for term, _ in counter.most_common(limit)]


def _layout_nodes(nodes: List[Dict[str, Any]]) -> None:
    by_type: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for node in nodes:
        by_type[node["type"]].append(node)

    rings = {
        "domain": 0.1,
        "category": 0.25,
        "concept": 0.52,
        "paper": 0.88,
    }
    offsets = {
        "domain": -math.pi / 2,
        "category": -math.pi / 4,
        "concept": 0,
        "paper": math.pi / 8,
    }

    for node_type, group in by_type.items():
        radius = rings.get(node_type, 0.7)
        offset = offsets.get(node_type, 0)
        count = max(len(group), 1)
        for index, node in enumerate(group):
            angle = offset + (2 * math.pi * index / count)
            jitter = 0.05 * ((index % 5) - 2)
            node["x"] = round(math.cos(angle) * (radius + jitter), 4)
            node["y"] = round(math.sin(angle) * (radius + jitter), 4)


def _edge_id(source: str, target: str, relation: str) -> str:
    return f"{relation}:{source}->{target}"


def _add_edge(
    edges: Dict[str, Dict[str, Any]],
    source: str,
    target: str,
    relation: str,
    weight: float = 1.0,
) -> None:
    edge_id = _edge_id(source, target, relation)
    edges[edge_id] = {
        "id": edge_id,
        "source": source,
        "target": target,
        "relation": relation,
        "weight": weight,
    }


def _paper_text(article: Dict[str, Any], concepts: Iterable[str]) -> str:
    return " ".join(
        [
            str(article.get("title") or ""),
            str(article.get("abstract") or ""),
            str(article.get("domain") or ""),
            str(article.get("category") or ""),
            " ".join(article.get("tags", [])),
            " ".join(concepts),
        ]
    ).lower()


def build_graph_rag(
    domain: str | None = None,
    category: str | None = None,
    article_ids: List[str] | None = None,
    concept_limit: int = 12,
    similarity_threshold: int = 2,
) -> Dict[str, Any]:
    selected_ids = _normalize_article_ids(article_ids)
    selected_set = set(selected_ids)
    articles = [
        article
        for article in list_articles(domain=domain, category=category, limit=5000)
        if article.get("status") == "indexed"
        and (
            not selected_set
            or str(article.get("article_id")) in selected_set
            or str(article.get("source")) in selected_set
        )
    ]

    nodes_by_id: Dict[str, Dict[str, Any]] = {}
    edges_by_id: Dict[str, Dict[str, Any]] = {}
    paper_concepts: Dict[str, List[str]] = {}

    for article in articles:
        article_id = str(article.get("article_id") or article.get("source"))
        paper_id = f"paper:{article_id}"
        concepts = extract_concepts(article, limit=concept_limit)
        paper_concepts[paper_id] = concepts

        nodes_by_id[paper_id] = {
            "id": paper_id,
            "type": "paper",
            "label": article.get("title") or article.get("source") or article_id,
            "article_id": article_id,
            "source": article.get("source"),
            "url": article.get("url") or article.get("pdf_url"),
            "domain": article.get("domain"),
            "category": article.get("category"),
            "tags": article.get("tags", []),
            "abstract": article.get("abstract") or "",
            "weight": 1,
        }

        if article.get("domain"):
            domain_id = f"domain:{_slug(str(article['domain']))}"
            nodes_by_id.setdefault(
                domain_id,
                {
                    "id": domain_id,
                    "type": "domain",
                    "label": str(article["domain"]),
                    "weight": 0,
                },
            )
            nodes_by_id[domain_id]["weight"] += 1
            _add_edge(edges_by_id, paper_id, domain_id, "IN_DOMAIN", 1)

        if article.get("category"):
            category_id = f"category:{_slug(str(article['category']))}"
            nodes_by_id.setdefault(
                category_id,
                {
                    "id": category_id,
                    "type": "category",
                    "label": str(article["category"]),
                    "weight": 0,
                },
            )
            nodes_by_id[category_id]["weight"] += 1
            _add_edge(edges_by_id, paper_id, category_id, "IN_CATEGORY", 1)

        for concept in concepts:
            concept_id = f"concept:{_slug(concept)}"
            nodes_by_id.setdefault(
                concept_id,
                {
                    "id": concept_id,
                    "type": "concept",
                    "label": _concept_label(concept),
                    "weight": 0,
                },
            )
            nodes_by_id[concept_id]["weight"] += 1
            _add_edge(edges_by_id, paper_id, concept_id, "MENTIONS", 1)

    paper_items = list(paper_concepts.items())
    for index, (paper_id, concepts) in enumerate(paper_items):
        concept_set = set(concepts)
        candidates: List[Tuple[int, str]] = []
        for other_id, other_concepts in paper_items[index + 1 :]:
            shared_count = len(concept_set.intersection(other_concepts))
            if shared_count >= similarity_threshold:
                candidates.append((shared_count, other_id))
        for shared_count, other_id in sorted(candidates, reverse=True)[:6]:
            _add_edge(edges_by_id, paper_id, other_id, "SIMILAR_TO", shared_count)

    nodes = list(nodes_by_id.values())
    _layout_nodes(nodes)

    graph = {
        "nodes": nodes,
        "edges": list(edges_by_id.values()),
        "scope": {
            "domain": domain,
            "category": category,
            "article_ids": selected_ids,
        },
        "stats": {
            "paper_count": sum(1 for node in nodes if node["type"] == "paper"),
            "concept_count": sum(1 for node in nodes if node["type"] == "concept"),
            "edge_count": len(edges_by_id),
        },
        "stale": False,
    }

    GRAPH_DIR.mkdir(parents=True, exist_ok=True)
    _graph_path(domain, category, selected_ids).write_text(
        json.dumps(graph, indent=2),
        encoding="utf-8",
    )
    return graph


def load_graph_rag(
    domain: str | None = None,
    category: str | None = None,
    article_ids: List[str] | None = None,
) -> Dict[str, Any]:
    selected_ids = _normalize_article_ids(article_ids)
    path = _graph_path(domain, category, selected_ids)
    if not path.exists():
        return {
            "nodes": [],
            "edges": [],
            "scope": {
                "domain": domain,
                "category": category,
                "article_ids": selected_ids,
            },
            "stats": {"paper_count": 0, "concept_count": 0, "edge_count": 0},
            "stale": True,
        }
    return json.loads(path.read_text(encoding="utf-8"))


def query_graph_rag(
    query: str,
    domain: str | None = None,
    category: str | None = None,
    article_ids: List[str] | None = None,
    limit: int = 8,
) -> Dict[str, Any]:
    selected_ids = _normalize_article_ids(article_ids)
    graph = load_graph_rag(domain, category, selected_ids)
    if graph.get("stale"):
        graph = build_graph_rag(domain, category, selected_ids)

    query_terms = set(_terms(query))
    node_by_id = {node["id"]: node for node in graph.get("nodes", [])}
    edges = graph.get("edges", [])

    concept_matches = [
        node
        for node in node_by_id.values()
        if node.get("type") == "concept"
        and query_terms.intersection(_terms(str(node.get("label", ""))))
    ]

    scored_papers: List[Tuple[int, Dict[str, Any]]] = []
    for node in node_by_id.values():
        if node.get("type") != "paper":
            continue
        text = _paper_text(node, [])
        score = sum(3 for term in query_terms if term in text)
        for edge in edges:
            if edge.get("source") == node["id"] and edge.get("relation") == "MENTIONS":
                concept = node_by_id.get(edge.get("target", ""))
                if concept and query_terms.intersection(_terms(str(concept.get("label", "")))):
                    score += 4
        if score:
            scored_papers.append((score, node))

    scored_papers.sort(key=lambda item: item[0], reverse=True)
    papers = [paper for _, paper in scored_papers[:limit]]
    paper_ids = {paper["id"] for paper in papers}
    concept_ids = {concept["id"] for concept in concept_matches[:limit]}
    related_edges = [
        edge
        for edge in edges
        if edge.get("source") in paper_ids
        or edge.get("target") in paper_ids
        or edge.get("source") in concept_ids
        or edge.get("target") in concept_ids
    ]
    related_node_ids = paper_ids.union(concept_ids)
    for edge in related_edges:
        related_node_ids.add(edge["source"])
        related_node_ids.add(edge["target"])
    related_nodes = [node_by_id[node_id] for node_id in related_node_ids if node_id in node_by_id]

    concept_labels = [str(node.get("label")) for node in concept_matches[:5]]
    paper_labels = [str(node.get("label")) for node in papers[:5]]
    if paper_labels:
        answer = (
            "Graph RAG found papers connected through "
            f"{', '.join(concept_labels) if concept_labels else 'nearby concepts'}. "
            f"The strongest matches are: {'; '.join(paper_labels)}."
        )
    else:
        answer = "Graph RAG did not find a strong graph match for that query in the current scope."

    return {
        "answer": answer,
        "nodes": related_nodes,
        "edges": related_edges,
        "papers": papers,
        "concepts": concept_matches[:limit],
    }


def _load_ready_graph(
    domain: str | None = None,
    category: str | None = None,
    article_ids: List[str] | None = None,
) -> Dict[str, Any]:
    selected_ids = _normalize_article_ids(article_ids)
    graph = load_graph_rag(domain, category, selected_ids)
    if graph.get("stale"):
        graph = build_graph_rag(domain, category, selected_ids)
    return graph


def get_node_neighborhood(
    node_id: str,
    domain: str | None = None,
    category: str | None = None,
    article_ids: List[str] | None = None,
    limit: int = 30,
) -> Dict[str, Any]:
    graph = _load_ready_graph(domain, category, article_ids)
    node_by_id = {node["id"]: node for node in graph.get("nodes", [])}
    if node_id not in node_by_id:
        return {
            "node": None,
            "nodes": [],
            "edges": [],
            "papers": [],
            "concepts": [],
            "answer": "That graph node was not found in the current scope.",
        }

    related_edges = [
        edge
        for edge in graph.get("edges", [])
        if edge.get("source") == node_id or edge.get("target") == node_id
    ][:limit]
    related_ids = {node_id}
    for edge in related_edges:
        related_ids.add(edge["source"])
        related_ids.add(edge["target"])

    related_nodes = [node_by_id[node_id] for node_id in related_ids if node_id in node_by_id]
    papers = [node for node in related_nodes if node.get("type") == "paper"]
    concepts = [node for node in related_nodes if node.get("type") == "concept"]
    selected = node_by_id[node_id]
    relation_count = len(related_edges)

    if selected.get("type") == "concept":
        answer = (
            f"{selected.get('label')} connects {len(papers)} paper"
            f"{'' if len(papers) == 1 else 's'} in this graph."
        )
    elif selected.get("type") == "paper":
        answer = (
            f"{selected.get('label')} is connected to {len(concepts)} concept"
            f"{'' if len(concepts) == 1 else 's'} and {relation_count} graph relationship"
            f"{'' if relation_count == 1 else 's'}."
        )
    else:
        answer = (
            f"{selected.get('label')} has {relation_count} graph relationship"
            f"{'' if relation_count == 1 else 's'} in this scope."
        )

    return {
        "node": selected,
        "nodes": related_nodes,
        "edges": related_edges,
        "papers": papers[:limit],
        "concepts": concepts[:limit],
        "answer": answer,
    }


def _adjacency(edges: List[Dict[str, Any]]) -> Dict[str, List[Tuple[str, Dict[str, Any]]]]:
    graph: Dict[str, List[Tuple[str, Dict[str, Any]]]] = defaultdict(list)
    for edge in edges:
        source = str(edge.get("source"))
        target = str(edge.get("target"))
        graph[source].append((target, edge))
        graph[target].append((source, edge))
    return graph


def explain_graph_connection(
    source_id: str,
    target_id: str,
    domain: str | None = None,
    category: str | None = None,
    article_ids: List[str] | None = None,
    max_depth: int = 5,
) -> Dict[str, Any]:
    graph = _load_ready_graph(domain, category, article_ids)
    node_by_id = {node["id"]: node for node in graph.get("nodes", [])}
    edges = graph.get("edges", [])

    if source_id not in node_by_id or target_id not in node_by_id:
        return {
            "answer": "One of those nodes was not found in the current graph scope.",
            "nodes": [],
            "edges": [],
            "papers": [],
            "concepts": [],
            "path": [],
            "shared_concepts": [],
        }

    adjacency = _adjacency(edges)
    queue = deque([(source_id, [source_id], [])])
    visited = {source_id}
    path_nodes: List[str] = []
    path_edges: List[Dict[str, Any]] = []

    while queue:
        current, current_path, current_edges = queue.popleft()
        if current == target_id:
            path_nodes = current_path
            path_edges = current_edges
            break
        if len(current_path) > max_depth:
            continue

        for neighbor, edge in adjacency.get(current, []):
            if neighbor in visited:
                continue
            visited.add(neighbor)
            queue.append((neighbor, [*current_path, neighbor], [*current_edges, edge]))

    if not path_nodes:
        source = node_by_id[source_id]
        target = node_by_id[target_id]
        return {
            "answer": f"No short graph path was found between {source.get('label')} and {target.get('label')}.",
            "nodes": [source, target],
            "edges": [],
            "papers": [node for node in [source, target] if node.get("type") == "paper"],
            "concepts": [],
            "path": [],
            "shared_concepts": [],
        }

    nodes = [node_by_id[node_id] for node_id in path_nodes if node_id in node_by_id]
    concepts = [node for node in nodes if node.get("type") == "concept"]
    papers = [node for node in nodes if node.get("type") == "paper"]
    shared_concepts = [
        node
        for node in concepts
        if any(edge.get("relation") == "MENTIONS" for edge in path_edges)
    ]
    labels = [str(node.get("label")) for node in nodes]
    relation_labels = [str(edge.get("relation", "RELATED_TO")).replace("_", " ").lower() for edge in path_edges]

    steps = []
    for index, relation in enumerate(relation_labels):
        left = labels[index] if index < len(labels) else "Unknown"
        right = labels[index + 1] if index + 1 < len(labels) else "Unknown"
        steps.append(f"{left} -- {relation} -- {right}")

    source = node_by_id[source_id]
    target = node_by_id[target_id]
    if shared_concepts:
        concept_text = ", ".join(str(node.get("label")) for node in shared_concepts[:5])
        answer = (
            f"{source.get('label')} and {target.get('label')} are connected through "
            f"{concept_text}. Path: {'; '.join(steps)}."
        )
    else:
        answer = (
            f"{source.get('label')} and {target.get('label')} are connected by this graph path: "
            f"{'; '.join(steps)}."
        )

    return {
        "answer": answer,
        "nodes": nodes,
        "edges": path_edges,
        "papers": papers,
        "concepts": concepts,
        "path": path_nodes,
        "shared_concepts": shared_concepts,
    }

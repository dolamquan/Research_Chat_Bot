import os
from pathlib import Path
from typing import Any, Dict, List

from dotenv import load_dotenv
from langsmith import traceable
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, Filter, PointStruct, VectorParams

from app.rag.chunker import load_and_chunk_pdf
from app.rag.embedder import embed_texts, get_embedding_dimension
from app.rag.metadata import (
    attach_parent_metadata_to_children,
    build_qdrant_payload,
    tag_parent_records,
)


COLLECTION_NAME = "mini_chatbot_docs"
DATA_DIR = Path(__file__).resolve().parents[1] / "data"
QDRANT_DATA_DIR = DATA_DIR / "qdrant_data"

DATA_DIR.mkdir(parents=True, exist_ok=True)

_client = None


def get_client() -> QdrantClient:
    """
    Open the Qdrant client only when it is first needed.

    If QDRANT_URL is set, connect to a Qdrant server such as Docker Qdrant.
    Otherwise, fall back to local embedded Qdrant for small experiments.
    """
    global _client

    if _client is None:
        load_dotenv()

        qdrant_url = os.getenv("QDRANT_URL", "").strip()
        qdrant_api_key = os.getenv("QDRANT_API_KEY", "").strip() or None

        if qdrant_url:
            _client = QdrantClient(
                url=qdrant_url,
                api_key=qdrant_api_key,
                timeout=120,
            )
        else:
            _client = QdrantClient(path=str(QDRANT_DATA_DIR))

    return _client


def create_collection(recreate: bool = False) -> None:
    """
    Create the Qdrant collection used for document chunks.
    """
    client = get_client()

    if recreate:
        client.recreate_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(
                size=get_embedding_dimension(),
                distance=Distance.COSINE,
            ),
        )
        return

    collections = client.get_collections().collections
    collection_names = [collection.name for collection in collections]

    if COLLECTION_NAME not in collection_names:
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(
                size=get_embedding_dimension(),
                distance=Distance.COSINE,
            ),
        )


def build_points(
    child_records: List[Dict[str, Any]],
    vectors: List[List[float]],
) -> List[PointStruct]:
    """
    Convert child chunks + vectors into Qdrant points.
    """
    points = []

    for child, vector in zip(child_records, vectors):
        points.append(
            PointStruct(
                id=child["child_id"],
                vector=vector,
                payload=build_qdrant_payload(child),
            )
        )

    return points


def upsert_child_records(child_records: List[Dict[str, Any]]) -> None:
    """
    Embed child chunks and store them in Qdrant.
    """
    client = get_client()

    child_texts = [child["text"] for child in child_records]
    vectors = embed_texts(child_texts)

    points = build_points(child_records, vectors)

    client.upsert(
        collection_name=COLLECTION_NAME,
        points=points,
    )


def index_pdf(
    pdf_path: str,
    llm: Any = None,
    use_llm_metadata: bool = False,
    article_metadata: Dict[str, Any] | None = None,
    ensure_collection: bool = True,
) -> None:
    """
    Load one PDF, chunk it, attach metadata, embed children, and store in Qdrant.
    """
    if ensure_collection:
        create_collection(recreate=False)

    parent_records, child_records = load_and_chunk_pdf(pdf_path)

    parent_records = tag_parent_records(
        parent_records,
        llm=llm,
        use_llm_metadata=use_llm_metadata,
        article_metadata=article_metadata,
    )

    child_records = attach_parent_metadata_to_children(
        parent_records,
        child_records,
    )

    upsert_child_records(child_records)


def index_folder(
    folder_path: str,
    llm: Any = None,
    recreate: bool = False,
    use_llm_metadata: bool = False,
    domain: str = "research",
    category: str = "uncategorized",
    tags: List[str] | None = None,
) -> None:
    """
    Index every PDF in a folder.
    """
    create_collection(recreate=recreate)

    pdf_paths = Path(folder_path).glob("*.pdf")

    for pdf_path in pdf_paths:
        index_pdf(
            str(pdf_path),
            llm=llm,
            use_llm_metadata=use_llm_metadata,
            article_metadata={
                "domain": domain,
                "category": category,
                "tags": tags or [],
            },
            ensure_collection=False,
        )

@traceable(name="retrieve", run_type="retriever")
def search_vectors(
    query_vector: List[float],
    limit: int = 5,
    query_filter: Filter | None = None,
):
    """
    Search Qdrant using a query embedding vector.
    """
    client = get_client()

    results = client.query_points(
        collection_name=COLLECTION_NAME,
        query=query_vector,
        query_filter=query_filter,
        limit=limit,
    )

    return results.points

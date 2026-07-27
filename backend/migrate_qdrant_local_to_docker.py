import os
from pathlib import Path
from typing import Any, Iterable, List

from dotenv import load_dotenv
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

from app.rag.vector_store import COLLECTION_NAME


BASE_DIR = Path(__file__).resolve().parent
LOCAL_QDRANT_DIR = BASE_DIR / "app" / "data" / "qdrant_data"
DEFAULT_QDRANT_URL = "http://127.0.0.1:6333"
BATCH_SIZE = 256


def batched(items: List[PointStruct], batch_size: int) -> Iterable[List[PointStruct]]:
    for index in range(0, len(items), batch_size):
        yield items[index : index + batch_size]


def copy_collection_config(
    local_client: QdrantClient,
    docker_client: QdrantClient,
    recreate: bool = True,
) -> None:
    local_info = local_client.get_collection(COLLECTION_NAME)
    vector_config = local_info.config.params.vectors

    if recreate:
        docker_client.recreate_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=vector_config,
        )
        return

    collections = docker_client.get_collections().collections
    collection_names = [collection.name for collection in collections]

    if COLLECTION_NAME not in collection_names:
        docker_client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=vector_config,
        )


def migrate_points(local_client: QdrantClient, docker_client: QdrantClient) -> int:
    offset: Any = None
    migrated_count = 0

    while True:
        points, offset = local_client.scroll(
            collection_name=COLLECTION_NAME,
            limit=BATCH_SIZE,
            offset=offset,
            with_payload=True,
            with_vectors=True,
        )

        if not points:
            break

        docker_points = [
            PointStruct(
                id=point.id,
                vector=point.vector,
                payload=point.payload,
            )
            for point in points
        ]

        for batch in batched(docker_points, BATCH_SIZE):
            docker_client.upsert(
                collection_name=COLLECTION_NAME,
                points=batch,
            )

        migrated_count += len(points)
        print(f"Migrated {migrated_count} points...")

        if offset is None:
            break

    return migrated_count


def main() -> None:
    load_dotenv()

    qdrant_url = os.getenv("QDRANT_URL", DEFAULT_QDRANT_URL)
    qdrant_api_key = os.getenv("QDRANT_API_KEY", "").strip() or None

    if not LOCAL_QDRANT_DIR.exists():
        raise FileNotFoundError(f"Local Qdrant folder not found: {LOCAL_QDRANT_DIR}")

    local_client = QdrantClient(path=str(LOCAL_QDRANT_DIR))
    docker_client = QdrantClient(
        url=qdrant_url,
        api_key=qdrant_api_key,
        timeout=120,
    )

    copy_collection_config(
        local_client=local_client,
        docker_client=docker_client,
        recreate=True,
    )

    migrated_count = migrate_points(
        local_client=local_client,
        docker_client=docker_client,
    )

    docker_count = docker_client.count(
        collection_name=COLLECTION_NAME,
        exact=True,
    ).count

    print("Migration complete.")
    print(f"Local points migrated: {migrated_count}")
    print(f"Docker collection count: {docker_count}")


if __name__ == "__main__":
    main()

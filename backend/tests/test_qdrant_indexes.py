"""Payload indexes Qdrant Cloud requires for filtered queries, created idempotently."""

from __future__ import annotations

from types import SimpleNamespace

from qdrant_client.models import PayloadSchemaType

from app.rag import vector_store


class FakeQdrant:
    def __init__(self, collections, schemas=None):
        self._collections = list(collections)
        self._schemas = {name: dict(schema) for name, schema in (schemas or {}).items()}
        self.created = []

    def get_collections(self):
        return SimpleNamespace(collections=[SimpleNamespace(name=n) for n in self._collections])

    def get_collection(self, collection_name):
        return SimpleNamespace(payload_schema={k: SimpleNamespace(data_type=v) for k, v in self._schemas.get(collection_name, {}).items()})

    def create_payload_index(self, collection_name, field_name, field_schema):
        self.created.append((collection_name, field_name, field_schema))
        self._schemas.setdefault(collection_name, {})[field_name] = field_schema


def test_missing_indexes_are_created_for_every_filtered_field():
    client = FakeQdrant([vector_store.COLLECTION_NAME, vector_store.NOTES_COLLECTION_NAME])
    created = vector_store.ensure_payload_indexes(client)
    docs = {f for c, f, _ in client.created if c == vector_store.COLLECTION_NAME}
    assert docs == {"source", "article_id", "domain", "category", "tags", "owner_id", "cluster_id"}
    assert (vector_store.COLLECTION_NAME, "cluster_id", PayloadSchemaType.INTEGER) in client.created
    assert (vector_store.COLLECTION_NAME, "source", PayloadSchemaType.KEYWORD) in client.created
    assert (vector_store.NOTES_COLLECTION_NAME, "owner_id", PayloadSchemaType.KEYWORD) in client.created
    assert f"{vector_store.COLLECTION_NAME}.source" in created
    # Second call: everything is already indexed.
    assert vector_store.ensure_payload_indexes(client) == []


def test_existing_indexes_and_absent_collections_are_left_alone():
    client = FakeQdrant([vector_store.COLLECTION_NAME], schemas={vector_store.COLLECTION_NAME: {"source": PayloadSchemaType.KEYWORD}})
    created = vector_store.ensure_payload_indexes(client)
    fields = [f for _, f, _ in client.created]
    assert "source" not in fields and "domain" in fields
    assert not any(c == vector_store.NOTES_COLLECTION_NAME for c, _, _ in client.created)
    assert all(item.startswith(vector_store.COLLECTION_NAME) for item in created)


def test_first_use_check_is_best_effort(monkeypatch):
    class Broken:
        def get_collections(self):
            raise ConnectionError("cluster asleep")

    vector_store._indexes_checked.clear()
    broken = Broken()
    vector_store._ensure_indexes_once(broken)  # must not raise
    assert id(broken) not in vector_store._indexes_checked  # retried next time
    good = FakeQdrant([vector_store.COLLECTION_NAME])
    vector_store._ensure_indexes_once(good)
    vector_store._ensure_indexes_once(good)
    assert id(good) in vector_store._indexes_checked and len(good.created) == 7

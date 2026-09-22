"""Create the payload indexes Qdrant Cloud needs for the app's filters.

Run once after moving to Qdrant Cloud (the app also does this on its first
connection, so this is only for fixing a running deployment without a restart):

    cd backend
    python scripts/ensure_qdrant_indexes.py

Reads QDRANT_URL / QDRANT_API_KEY from backend/.env like the app does.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.rag.vector_store import PAYLOAD_INDEXES, ensure_payload_indexes, get_client  # noqa: E402


def main() -> int:
    client = get_client()
    created = ensure_payload_indexes(client)
    for name in PAYLOAD_INDEXES:
        try:
            info = client.get_collection(collection_name=name)
        except Exception as exc:  # collection missing on this cluster
            print(f"{name}: not present ({exc.__class__.__name__})")
            continue
        indexed = sorted((getattr(info, "payload_schema", None) or {}).keys())
        print(f"{name}: indexed fields -> {', '.join(indexed) or 'none'}")
    print(f"created now: {', '.join(created) or 'nothing (all present)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

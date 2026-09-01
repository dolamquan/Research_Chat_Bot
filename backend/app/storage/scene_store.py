"""Persistence for generated scene records (currently Three.js code documents).

Follows the conventions already used by `visualization_store`: the same
`DB_PATH`, a `_connect()` that runs an idempotent `init_db()`, `sqlite3.Row`
access, ISO-8601 UTC timestamps and `*_json` columns unpacked in the row
mapper. Scenes live in their own table rather than as another column on
`paper_visualizations` because a scene is regenerated on a different cadence
than the diagram it animates, and carries its own verification report.

One scene per (visualization, schema version): regenerating replaces the row
rather than accumulating history, matching how visualizations and expansions
already behave.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any, Dict, List

from app.storage.visualization_store import DATA_DIR, DB_PATH, _now


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    init_db(connection)
    return connection


def init_db(connection: sqlite3.Connection | None = None) -> None:
    owns_connection = connection is None
    conn = connection or sqlite3.connect(DB_PATH)

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS algorithm_scenes (
            scene_id TEXT PRIMARY KEY,
            viz_id TEXT NOT NULL,
            article_id TEXT NOT NULL DEFAULT '',
            schema_version TEXT NOT NULL DEFAULT '1.0',
            provider TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            extraction_strategy TEXT NOT NULL DEFAULT '',
            scene_json TEXT NOT NULL,
            verification_json TEXT NOT NULL DEFAULT '{}',
            valid INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(viz_id, schema_version)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_algorithm_scenes_viz
        ON algorithm_scenes(viz_id)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_algorithm_scenes_article
        ON algorithm_scenes(article_id)
        """
    )

    conn.commit()
    if owns_connection:
        conn.close()


def _row_to_scene_record(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "scene_id": row["scene_id"],
        "viz_id": row["viz_id"],
        "article_id": row["article_id"],
        "schema_version": row["schema_version"],
        "provider": row["provider"],
        "model": row["model"],
        "extraction_strategy": row["extraction_strategy"],
        "scene": json.loads(row["scene_json"]),
        "verification": json.loads(row["verification_json"] or "{}"),
        "valid": bool(row["valid"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def upsert_scene(
    *,
    viz_id: str,
    article_id: str,
    scene: Dict[str, Any],
    verification: Dict[str, Any],
    provider: str = "",
    model: str = "",
    extraction_strategy: str = "",
    schema_version: str = "1.0",
) -> Dict[str, Any]:
    """Insert or replace the scene for a visualization."""
    timestamp = _now()
    valid = 1 if verification.get("valid") else 0

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO algorithm_scenes (
                scene_id, viz_id, article_id, schema_version, provider, model,
                extraction_strategy, scene_json, verification_json, valid,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(viz_id, schema_version) DO UPDATE SET
                article_id = excluded.article_id,
                provider = excluded.provider,
                model = excluded.model,
                extraction_strategy = excluded.extraction_strategy,
                scene_json = excluded.scene_json,
                verification_json = excluded.verification_json,
                valid = excluded.valid,
                updated_at = excluded.updated_at
            """,
            (
                uuid.uuid4().hex,
                viz_id,
                article_id,
                schema_version,
                provider,
                model,
                extraction_strategy,
                json.dumps(scene, ensure_ascii=False),
                json.dumps(verification, ensure_ascii=False),
                valid,
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute(
            "SELECT * FROM algorithm_scenes WHERE viz_id = ? AND schema_version = ?",
            (viz_id, schema_version),
        ).fetchone()

    if row is None:
        raise ValueError("Failed to persist algorithm scene")
    return _row_to_scene_record(row)


def get_scene(viz_id: str, schema_version: str = "1.0") -> Dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM algorithm_scenes WHERE viz_id = ? AND schema_version = ?",
            (viz_id, schema_version),
        ).fetchone()
    return _row_to_scene_record(row) if row else None


def list_scenes_for_article(article_id: str) -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM algorithm_scenes
            WHERE article_id = ?
            ORDER BY updated_at DESC
            """,
            (article_id,),
        ).fetchall()
    return [_row_to_scene_record(row) for row in rows]


def update_verification(
    viz_id: str, verification: Dict[str, Any], schema_version: str = "1.0"
) -> Dict[str, Any] | None:
    """Store a fresh verification report against an existing scene."""
    with _connect() as conn:
        conn.execute(
            """
            UPDATE algorithm_scenes
            SET verification_json = ?, valid = ?, updated_at = ?
            WHERE viz_id = ? AND schema_version = ?
            """,
            (
                json.dumps(verification, ensure_ascii=False),
                1 if verification.get("valid") else 0,
                _now(),
                viz_id,
                schema_version,
            ),
        )
        row = conn.execute(
            "SELECT * FROM algorithm_scenes WHERE viz_id = ? AND schema_version = ?",
            (viz_id, schema_version),
        ).fetchone()
    return _row_to_scene_record(row) if row else None


def delete_scenes_for_visualization(viz_id: str) -> int:
    """Remove every scene for a visualization; called when the diagram is deleted."""
    with _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM algorithm_scenes WHERE viz_id = ?", (viz_id,)
        )
        return cursor.rowcount or 0

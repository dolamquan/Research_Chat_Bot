"""Persistence for per-node generated stage scenes (Three.js code documents).

Follows the conventions of `scene_store`: the same `DB_PATH`, a `_connect()`
that runs an idempotent `init_db()`, `sqlite3.Row` access, ISO-8601 UTC
timestamps and `*_json` columns unpacked in the row mapper. Stage scenes live
in their own table rather than inside `node_expansions.content` because they
are regenerated on a different cadence than the expansion text, and carry
their own check report and provenance.

One scene per (visualization, node, schema version): regenerating replaces the
row rather than accumulating history.
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
        CREATE TABLE IF NOT EXISTS stage_scenes (
            stage_scene_id TEXT PRIMARY KEY,
            viz_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            schema_version TEXT NOT NULL DEFAULT 'code-1.0',
            provider TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            scene_json TEXT NOT NULL,
            verification_json TEXT NOT NULL DEFAULT '{}',
            valid INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(viz_id, node_id, schema_version)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stage_scenes_viz
        ON stage_scenes(viz_id)
        """
    )

    conn.commit()
    if owns_connection:
        conn.close()


def _row_to_record(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "stage_scene_id": row["stage_scene_id"],
        "viz_id": row["viz_id"],
        "node_id": row["node_id"],
        "schema_version": row["schema_version"],
        "provider": row["provider"],
        "model": row["model"],
        "scene": json.loads(row["scene_json"]),
        "verification": json.loads(row["verification_json"] or "{}"),
        "valid": bool(row["valid"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def upsert_stage_scene(
    *,
    viz_id: str,
    node_id: str,
    scene: Dict[str, Any],
    verification: Dict[str, Any],
    provider: str = "",
    model: str = "",
    schema_version: str = "code-1.0",
) -> Dict[str, Any]:
    """Insert or replace the stage scene for one node of a visualization."""
    timestamp = _now()
    valid = 1 if verification.get("valid") else 0

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO stage_scenes (
                stage_scene_id, viz_id, node_id, schema_version, provider,
                model, scene_json, verification_json, valid,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(viz_id, node_id, schema_version) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model,
                scene_json = excluded.scene_json,
                verification_json = excluded.verification_json,
                valid = excluded.valid,
                updated_at = excluded.updated_at
            """,
            (
                uuid.uuid4().hex,
                viz_id,
                node_id,
                schema_version,
                provider,
                model,
                json.dumps(scene, ensure_ascii=False),
                json.dumps(verification, ensure_ascii=False),
                valid,
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute(
            "SELECT * FROM stage_scenes "
            "WHERE viz_id = ? AND node_id = ? AND schema_version = ?",
            (viz_id, node_id, schema_version),
        ).fetchone()

    if row is None:
        raise ValueError("Failed to persist stage scene")
    return _row_to_record(row)


def get_stage_scene(
    viz_id: str, node_id: str, schema_version: str = "code-1.0"
) -> Dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM stage_scenes "
            "WHERE viz_id = ? AND node_id = ? AND schema_version = ?",
            (viz_id, node_id, schema_version),
        ).fetchone()
    return _row_to_record(row) if row else None


def list_stage_scenes(
    viz_id: str, schema_version: str = "code-1.0"
) -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM stage_scenes "
            "WHERE viz_id = ? AND schema_version = ? ORDER BY node_id",
            (viz_id, schema_version),
        ).fetchall()
    return [_row_to_record(row) for row in rows]


def delete_stage_scenes_for_visualization(viz_id: str) -> int:
    """Remove every stage scene for a visualization, e.g. when it is deleted."""
    with _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM stage_scenes WHERE viz_id = ?", (viz_id,)
        )
        return cursor.rowcount or 0

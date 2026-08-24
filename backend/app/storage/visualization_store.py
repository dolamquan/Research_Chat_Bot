import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "researchmind.sqlite3"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
        CREATE TABLE IF NOT EXISTS paper_visualizations (
            viz_id TEXT PRIMARY KEY,
            article_id TEXT NOT NULL,
            document_source TEXT NOT NULL,
            diagram_kind TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            algorithm_name TEXT NOT NULL DEFAULT '',
            diagram_json TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            key_insight TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            source_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(article_id, diagram_kind)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_paper_visualizations_article
        ON paper_visualizations(article_id)
        """
    )
    _ensure_column(conn, "worked_example_json", "TEXT")
    _ensure_column(conn, "mechanism_domain", "TEXT")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS node_expansions (
            expansion_id TEXT PRIMARY KEY,
            viz_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            node_label TEXT NOT NULL DEFAULT '',
            content_json TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(viz_id, node_id)
        )
        """
    )
    conn.commit()

    if owns_connection:
        conn.close()


def _ensure_column(
    conn: sqlite3.Connection, column_name: str, column_sql: str
) -> None:
    columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(paper_visualizations)").fetchall()
    }
    if column_name not in columns:
        conn.execute(
            f"ALTER TABLE paper_visualizations ADD COLUMN {column_name} {column_sql}"
        )


def _row_to_record(row: sqlite3.Row) -> Dict[str, Any]:
    record = dict(row)
    try:
        record["diagram"] = json.loads(record.pop("diagram_json"))
    except Exception:
        record["diagram"] = {"nodes": [], "edges": [], "groups": []}

    raw_example = record.pop("worked_example_json", None)
    try:
        record["worked_example"] = json.loads(raw_example) if raw_example else None
    except Exception:
        record["worked_example"] = None
    return record


def set_mechanism_domain(viz_id: str, domain: str) -> None:
    """Which mechanism vocabulary this paper's storyboards may draw on."""
    with _connect() as conn:
        conn.execute(
            "UPDATE paper_visualizations SET mechanism_domain = ? WHERE viz_id = ?",
            (domain, viz_id),
        )


def set_worked_example(viz_id: str, worked_example: Dict[str, Any]) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE paper_visualizations SET worked_example_json = ? WHERE viz_id = ?",
            (json.dumps(worked_example, ensure_ascii=False), viz_id),
        )


def upsert_visualization(
    *,
    article_id: str,
    document_source: str,
    diagram_kind: str,
    title: str,
    algorithm_name: str,
    diagram: Dict[str, Any],
    summary: str,
    key_insight: str,
    model: str,
    source_count: int = 0,
) -> Dict[str, Any]:
    timestamp = _now()
    diagram_json = json.dumps(diagram, ensure_ascii=False)

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO paper_visualizations (
                viz_id, article_id, document_source, diagram_kind, title,
                algorithm_name, diagram_json, summary, key_insight, model,
                source_count, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(article_id, diagram_kind) DO UPDATE SET
                document_source = excluded.document_source,
                title = excluded.title,
                algorithm_name = excluded.algorithm_name,
                diagram_json = excluded.diagram_json,
                summary = excluded.summary,
                key_insight = excluded.key_insight,
                model = excluded.model,
                source_count = excluded.source_count,
                updated_at = excluded.updated_at
            """,
            (
                uuid.uuid4().hex,
                article_id,
                document_source,
                diagram_kind,
                title,
                algorithm_name,
                diagram_json,
                summary,
                key_insight,
                model,
                source_count,
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute(
            """
            SELECT * FROM paper_visualizations
            WHERE article_id = ? AND diagram_kind = ?
            """,
            (article_id, diagram_kind),
        ).fetchone()
        if row is not None:
            # Node ids change when a diagram is regenerated; drop stale expansions.
            conn.execute(
                "DELETE FROM node_expansions WHERE viz_id = ?",
                (row["viz_id"],),
            )

    if row is None:
        raise ValueError("Failed to persist visualization")
    return _row_to_record(row)


def list_visualizations(article_id: str) -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM paper_visualizations
            WHERE article_id = ?
            ORDER BY updated_at DESC
            """,
            (article_id,),
        ).fetchall()
    return [_row_to_record(row) for row in rows]


def get_visualization(
    article_id: str, diagram_kind: str
) -> Dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT * FROM paper_visualizations
            WHERE article_id = ? AND diagram_kind = ?
            """,
            (article_id, diagram_kind),
        ).fetchone()
    return _row_to_record(row) if row else None


def get_visualization_by_id(viz_id: str) -> Dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM paper_visualizations WHERE viz_id = ?",
            (viz_id,),
        ).fetchone()
    return _row_to_record(row) if row else None


def delete_visualization(viz_id: str) -> bool:
    with _connect() as conn:
        conn.execute("DELETE FROM node_expansions WHERE viz_id = ?", (viz_id,))
        cursor = conn.execute(
            "DELETE FROM paper_visualizations WHERE viz_id = ?",
            (viz_id,),
        )
    return cursor.rowcount > 0


def _row_to_expansion(row: sqlite3.Row) -> Dict[str, Any]:
    record = dict(row)
    try:
        record["content"] = json.loads(record.pop("content_json"))
    except Exception:
        record["content"] = {}
    return record


def upsert_node_expansion(
    *,
    viz_id: str,
    node_id: str,
    node_label: str,
    content: Dict[str, Any],
    model: str,
) -> Dict[str, Any]:
    timestamp = _now()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO node_expansions (
                expansion_id, viz_id, node_id, node_label, content_json,
                model, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(viz_id, node_id) DO UPDATE SET
                node_label = excluded.node_label,
                content_json = excluded.content_json,
                model = excluded.model,
                updated_at = excluded.updated_at
            """,
            (
                uuid.uuid4().hex,
                viz_id,
                node_id,
                node_label,
                json.dumps(content, ensure_ascii=False),
                model,
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute(
            "SELECT * FROM node_expansions WHERE viz_id = ? AND node_id = ?",
            (viz_id, node_id),
        ).fetchone()

    if row is None:
        raise ValueError("Failed to persist node expansion")
    return _row_to_expansion(row)


def get_node_expansion(viz_id: str, node_id: str) -> Dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM node_expansions WHERE viz_id = ? AND node_id = ?",
            (viz_id, node_id),
        ).fetchone()
    return _row_to_expansion(row) if row else None


def list_node_expansions(viz_id: str) -> List[Dict[str, Any]]:
    """Every stored expansion for a visualization, content included."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM node_expansions WHERE viz_id = ?",
            (viz_id,),
        ).fetchall()
    return [_row_to_expansion(row) for row in rows]


def list_expanded_node_ids(viz_id: str) -> List[str]:
    """Node ids that already have a stored expansion for this visualization."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT node_id, content_json FROM node_expansions WHERE viz_id = ?",
            (viz_id,),
        ).fetchall()
    # Only count expansions matching the current storyboard schema, so stages
    # stored by an older version are re-prepared rather than reported ready.
    prepared: List[str] = []
    for row in rows:
        try:
            content = json.loads(row["content_json"] or "{}")
        except Exception:
            continue
        steps = content.get("process_steps")
        if steps is None:
            continue
        if all(isinstance(step, dict) and "values" in step for step in steps):
            prepared.append(row["node_id"])
    return prepared


def copy_node_expansions(
    from_id: str, to_id: str, node_ids: List[str]
) -> int:
    """Carry storyboards over to a variant for stages the patch left alone.

    Stages that were changed, removed, or had their edges rewired are
    deliberately not copied: their storyboard prompt embeds the node's
    neighbourhood, so it would be stale. Those simply have no row and are
    regenerated on demand by the existing readiness path.
    """
    if not node_ids:
        return 0
    placeholders = ",".join("?" for _ in node_ids)
    timestamp = _now()
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT node_id, node_label, content_json, model FROM node_expansions "
            f"WHERE viz_id = ? AND node_id IN ({placeholders})",
            (from_id, *node_ids),
        ).fetchall()
        for row in rows:
            conn.execute(
                """
                INSERT INTO node_expansions (
                    expansion_id, viz_id, node_id, node_label, content_json,
                    model, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(viz_id, node_id) DO UPDATE SET
                    content_json = excluded.content_json,
                    updated_at = excluded.updated_at
                """,
                (
                    uuid.uuid4().hex,
                    to_id,
                    row["node_id"],
                    row["node_label"],
                    row["content_json"],
                    row["model"],
                    timestamp,
                    timestamp,
                ),
            )
    return len(rows)


def delete_node_expansions(viz_id: str) -> int:
    with _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM node_expansions WHERE viz_id = ?", (viz_id,)
        )
    return cursor.rowcount

"""Persistence for modified algorithm variants and their verification runs.

Variants form a lineage: each one points at the visualization it descends from
and, when it was branched off another variant, at that parent. Variants are
append-only — re-verifying creates a new run rather than mutating an old one.
"""

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "researchmind.sqlite3"

MAX_VARIANT_DEPTH = 5
MAX_VARIANTS_PER_ROOT = 50


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
        CREATE TABLE IF NOT EXISTS diagram_variants (
            variant_id TEXT PRIMARY KEY,
            root_viz_id TEXT NOT NULL,
            parent_variant_id TEXT,
            article_id TEXT NOT NULL,
            document_source TEXT NOT NULL,
            diagram_kind TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            algorithm_name TEXT NOT NULL DEFAULT '',
            variant_title TEXT NOT NULL DEFAULT '',
            diagram_json TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            key_insight TEXT NOT NULL DEFAULT '',
            worked_example_json TEXT,
            intent TEXT NOT NULL DEFAULT '',
            patch_json TEXT NOT NULL DEFAULT '{}',
            patch_result_json TEXT NOT NULL DEFAULT '{}',
            changed_node_ids_json TEXT NOT NULL DEFAULT '[]',
            depth INTEGER NOT NULL DEFAULT 1,
            model TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    for statement in (
        "CREATE INDEX IF NOT EXISTS idx_diagram_variants_root ON diagram_variants(root_viz_id)",
        "CREATE INDEX IF NOT EXISTS idx_diagram_variants_parent ON diagram_variants(parent_variant_id)",
        "CREATE INDEX IF NOT EXISTS idx_diagram_variants_article ON diagram_variants(article_id)",
    ):
        conn.execute(statement)

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS verification_runs (
            run_id TEXT PRIMARY KEY,
            target_id TEXT NOT NULL,
            target_kind TEXT NOT NULL DEFAULT 'variant',
            status TEXT NOT NULL,
            stage TEXT NOT NULL DEFAULT 'queued',
            message TEXT NOT NULL DEFAULT '',
            layers_json TEXT NOT NULL DEFAULT '[]',
            report_json TEXT,
            verdict TEXT NOT NULL DEFAULT '',
            finding_count INTEGER NOT NULL DEFAULT 0,
            blocking_count INTEGER NOT NULL DEFAULT 0,
            timings_json TEXT NOT NULL DEFAULT '{}',
            model TEXT NOT NULL DEFAULT '',
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_verification_runs_target
        ON verification_runs(target_id, created_at)
        """
    )
    init_message_table(conn)
    conn.commit()

    if owns_connection:
        conn.close()


def _loads(raw: Any, fallback: Any) -> Any:
    try:
        return json.loads(raw) if raw else fallback
    except Exception:
        return fallback


def _row_to_variant(row: sqlite3.Row) -> Dict[str, Any]:
    record = dict(row)
    record["diagram"] = _loads(
        record.pop("diagram_json", None), {"nodes": [], "edges": [], "groups": []}
    )
    record["worked_example"] = _loads(record.pop("worked_example_json", None), None)
    record["patch"] = _loads(record.pop("patch_json", None), {})
    record["patch_result"] = _loads(record.pop("patch_result_json", None), {})
    record["changed_node_ids"] = _loads(record.pop("changed_node_ids_json", None), [])
    # Lets the frontend tell a variant from a visualization without guessing.
    record["record_kind"] = "variant"
    return record


def _row_to_run(row: sqlite3.Row) -> Dict[str, Any]:
    record = dict(row)
    record["layers"] = _loads(record.pop("layers_json", None), [])
    record["report"] = _loads(record.pop("report_json", None), None)
    record["timings"] = _loads(record.pop("timings_json", None), {})
    return record


# ------------------------------------------------------------------ variants

def create_variant(
    *,
    root_viz_id: str,
    parent_variant_id: str | None,
    article_id: str,
    document_source: str,
    diagram_kind: str,
    title: str,
    algorithm_name: str,
    variant_title: str,
    diagram: Dict[str, Any],
    summary: str,
    key_insight: str,
    worked_example: Dict[str, Any] | None,
    intent: str,
    patch: Dict[str, Any],
    patch_result: Dict[str, Any],
    changed_node_ids: List[str],
    depth: int,
    model: str,
) -> Dict[str, Any]:
    if depth > MAX_VARIANT_DEPTH:
        raise ValueError(
            f"Variant chains are limited to {MAX_VARIANT_DEPTH} levels; "
            "start a new variant from the original diagram instead"
        )

    variant_id = uuid.uuid4().hex
    timestamp = _now()

    with _connect() as conn:
        existing = conn.execute(
            "SELECT COUNT(*) AS n FROM diagram_variants WHERE root_viz_id = ?",
            (root_viz_id,),
        ).fetchone()
        if existing and existing["n"] >= MAX_VARIANTS_PER_ROOT:
            raise ValueError(
                f"This diagram already has {MAX_VARIANTS_PER_ROOT} variants; "
                "delete some before creating more"
            )

        conn.execute(
            """
            INSERT INTO diagram_variants (
                variant_id, root_viz_id, parent_variant_id, article_id,
                document_source, diagram_kind, title, algorithm_name,
                variant_title, diagram_json, summary, key_insight,
                worked_example_json, intent, patch_json, patch_result_json,
                changed_node_ids_json, depth, model, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                variant_id,
                root_viz_id,
                parent_variant_id,
                article_id,
                document_source,
                diagram_kind,
                title,
                algorithm_name,
                variant_title,
                json.dumps(diagram, ensure_ascii=False),
                summary,
                key_insight,
                json.dumps(worked_example, ensure_ascii=False)
                if worked_example
                else None,
                intent,
                json.dumps(patch, ensure_ascii=False),
                json.dumps(patch_result, ensure_ascii=False),
                json.dumps(changed_node_ids, ensure_ascii=False),
                depth,
                model,
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute(
            "SELECT * FROM diagram_variants WHERE variant_id = ?", (variant_id,)
        ).fetchone()

    if row is None:
        raise ValueError("Failed to persist variant")
    return _row_to_variant(row)


def get_variant(variant_id: str) -> Dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM diagram_variants WHERE variant_id = ?", (variant_id,)
        ).fetchone()
    return _row_to_variant(row) if row else None


def list_variants_for_visualization(root_viz_id: str) -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM diagram_variants
            WHERE root_viz_id = ?
            ORDER BY created_at DESC
            """,
            (root_viz_id,),
        ).fetchall()
    return [_row_to_variant(row) for row in rows]


def list_variants_for_article(article_id: str) -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM diagram_variants
            WHERE article_id = ?
            ORDER BY created_at DESC
            """,
            (article_id,),
        ).fetchall()
    return [_row_to_variant(row) for row in rows]


def lineage_of(variant_id: str) -> List[Dict[str, Any]]:
    """Ancestor variants, oldest first. Excludes the variant itself."""
    chain: List[Dict[str, Any]] = []
    seen: set[str] = set()
    current = get_variant(variant_id)
    while current and current.get("parent_variant_id"):
        parent_id = current["parent_variant_id"]
        if parent_id in seen:  # defensive: never loop on corrupt lineage
            break
        seen.add(parent_id)
        parent = get_variant(parent_id)
        if parent is None:
            break
        chain.append(parent)
        current = parent
    return list(reversed(chain))


def descendant_ids(variant_id: str) -> List[str]:
    """The variant plus everything branched from it, parents before children."""
    ordered = [variant_id]
    frontier = [variant_id]
    with _connect() as conn:
        while frontier:
            placeholders = ",".join("?" for _ in frontier)
            rows = conn.execute(
                f"SELECT variant_id FROM diagram_variants "
                f"WHERE parent_variant_id IN ({placeholders})",
                tuple(frontier),
            ).fetchall()
            frontier = [row["variant_id"] for row in rows if row["variant_id"] not in ordered]
            ordered.extend(frontier)
    return ordered


def delete_variants(variant_ids: List[str]) -> int:
    """Delete variants and their verification runs. Callers cascade explicitly."""
    if not variant_ids:
        return 0
    placeholders = ",".join("?" for _ in variant_ids)
    with _connect() as conn:
        conn.execute(
            f"DELETE FROM verification_runs WHERE target_id IN ({placeholders})",
            tuple(variant_ids),
        )
        cursor = conn.execute(
            f"DELETE FROM diagram_variants WHERE variant_id IN ({placeholders})",
            tuple(variant_ids),
        )
    return cursor.rowcount


def delete_variants_for_visualization(root_viz_id: str) -> List[str]:
    """Used when the parent visualization itself is deleted."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT variant_id FROM diagram_variants WHERE root_viz_id = ?",
            (root_viz_id,),
        ).fetchall()
    variant_ids = [row["variant_id"] for row in rows]
    delete_variants(variant_ids)
    return variant_ids


# --------------------------------------------------------- verification runs

def create_run(
    *,
    target_id: str,
    target_kind: str,
    layers: List[str],
    status: str = "queued",
    stage: str = "queued",
    model: str = "",
) -> Dict[str, Any]:
    run_id = uuid.uuid4().hex
    timestamp = _now()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO verification_runs (
                run_id, target_id, target_kind, status, stage, layers_json,
                model, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                target_id,
                target_kind,
                status,
                stage,
                json.dumps(layers, ensure_ascii=False),
                model,
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute(
            "SELECT * FROM verification_runs WHERE run_id = ?", (run_id,)
        ).fetchone()
    if row is None:
        raise ValueError("Failed to create verification run")
    return _row_to_run(row)


def finish_run(
    run_id: str,
    *,
    status: str,
    report: Dict[str, Any] | None = None,
    verdict: str = "",
    finding_count: int = 0,
    blocking_count: int = 0,
    layers: List[Dict[str, Any]] | None = None,
    timings: Dict[str, Any] | None = None,
    message: str = "",
    error: str | None = None,
) -> Dict[str, Any] | None:
    timestamp = _now()
    with _connect() as conn:
        conn.execute(
            """
            UPDATE verification_runs SET
                status = ?, stage = ?, message = ?, report_json = ?, verdict = ?,
                finding_count = ?, blocking_count = ?, layers_json = ?,
                timings_json = ?, error = ?, updated_at = ?, completed_at = ?
            WHERE run_id = ?
            """,
            (
                status,
                "done" if status in {"complete", "partial"} else status,
                message,
                json.dumps(report, ensure_ascii=False) if report is not None else None,
                verdict,
                finding_count,
                blocking_count,
                json.dumps(layers or [], ensure_ascii=False),
                json.dumps(timings or {}, ensure_ascii=False),
                error,
                timestamp,
                timestamp,
                run_id,
            ),
        )
        row = conn.execute(
            "SELECT * FROM verification_runs WHERE run_id = ?", (run_id,)
        ).fetchone()
    return _row_to_run(row) if row else None


def get_run(run_id: str) -> Dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM verification_runs WHERE run_id = ?", (run_id,)
        ).fetchone()
    return _row_to_run(row) if row else None


def list_runs(target_id: str, limit: int = 10) -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM verification_runs
            WHERE target_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (target_id, limit),
        ).fetchall()
    return [_row_to_run(row) for row in rows]


def latest_run(target_id: str) -> Dict[str, Any] | None:
    runs = list_runs(target_id, limit=1)
    return runs[0] if runs else None


def active_run(target_id: str) -> Dict[str, Any] | None:
    """An unfinished run, so a second one is never started for the same target."""
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT * FROM verification_runs
            WHERE target_id = ? AND status IN ('queued', 'running')
            ORDER BY created_at DESC LIMIT 1
            """,
            (target_id,),
        ).fetchone()
    return _row_to_run(row) if row else None


# ------------------------------------------------------- discussion history

def init_message_table(connection: sqlite3.Connection | None = None) -> None:
    owns_connection = connection is None
    conn = connection or sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS variant_messages (
            message_id TEXT PRIMARY KEY,
            target_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            node_ids_json TEXT NOT NULL DEFAULT '[]',
            suggestions_json TEXT NOT NULL DEFAULT '[]',
            model TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_variant_messages_target
        ON variant_messages(target_id, created_at)
        """
    )
    conn.commit()
    if owns_connection:
        conn.close()


def _row_to_message(row: sqlite3.Row) -> Dict[str, Any]:
    record = dict(row)
    record["node_ids"] = _loads(record.pop("node_ids_json", None), [])
    record["suggestions"] = _loads(record.pop("suggestions_json", None), [])
    return record


def append_message(
    *,
    target_id: str,
    role: str,
    content: str,
    node_ids: List[str] | None = None,
    suggestions: List[str] | None = None,
    model: str = "",
) -> Dict[str, Any]:
    message_id = uuid.uuid4().hex
    with _connect() as conn:
        init_message_table(conn)
        conn.execute(
            """
            INSERT INTO variant_messages (
                message_id, target_id, role, content, node_ids_json,
                suggestions_json, model, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                target_id,
                role,
                content,
                json.dumps(node_ids or [], ensure_ascii=False),
                json.dumps(suggestions or [], ensure_ascii=False),
                model,
                _now(),
            ),
        )
        row = conn.execute(
            "SELECT * FROM variant_messages WHERE message_id = ?", (message_id,)
        ).fetchone()
    if row is None:
        raise ValueError("Failed to persist message")
    return _row_to_message(row)


def list_messages(target_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    with _connect() as conn:
        init_message_table(conn)
        rows = conn.execute(
            """
            SELECT * FROM variant_messages
            WHERE target_id = ?
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (target_id, limit),
        ).fetchall()
    return [_row_to_message(row) for row in rows]


def clear_messages(target_id: str) -> int:
    with _connect() as conn:
        init_message_table(conn)
        cursor = conn.execute(
            "DELETE FROM variant_messages WHERE target_id = ?", (target_id,)
        )
    return cursor.rowcount

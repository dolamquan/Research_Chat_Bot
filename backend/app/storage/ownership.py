"""Shared pieces of per-user scoping for the SQLite stores.

Ownership is one nullable `owner_id` column per table. NULL means "unowned":
public for papers, "not yet claimed by the administrator" for personal data.
"""
from __future__ import annotations

import sqlite3
from typing import Any, List


def ensure_owner_column(conn: sqlite3.Connection, table: str) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if "owner_id" not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN owner_id TEXT")
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_owner ON {table}(owner_id)")


def owner_clause(owner: str | None, *, column: str = "owner_id", include_public: bool = False) -> tuple[str, List[Any]]:
    """SQL fragment (without WHERE/AND) restricting rows to an owner; empty when unscoped."""
    if owner is None:
        return "", []
    if include_public:
        return f"({column} IS NULL OR {column} = ?)", [owner]
    return f"{column} = ?", [owner]


def claim_unowned(conn: sqlite3.Connection, table: str, owner: str) -> int:
    return conn.execute(f"UPDATE {table} SET owner_id = ? WHERE owner_id IS NULL", (owner,)).rowcount

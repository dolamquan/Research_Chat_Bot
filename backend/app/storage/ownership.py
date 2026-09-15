"""Shared pieces of per-user scoping for the SQLite stores.

Ownership is one nullable `owner_id` column per table. NULL means "unowned":
public for papers, "not yet claimed by the administrator" for personal data.
"""
from __future__ import annotations

from typing import Any, List

from app.storage import db


def ensure_column(conn: db.Connection, table: str, column: str, ddl: str) -> None:
    """Add `column` with the given DDL if the table does not have it yet (in-place migration)."""
    if column not in db.table_columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def ensure_owner_column(conn: db.Connection, table: str) -> None:
    ensure_column(conn, table, "owner_id", "TEXT")
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_owner ON {table}(owner_id)")


def owner_clause(owner: str | None, *, column: str = "owner_id", include_public: bool = False) -> tuple[str, List[Any]]:
    """SQL fragment (without WHERE/AND) restricting rows to an owner; empty when unscoped."""
    if owner is None:
        return "", []
    if include_public:
        return f"({column} IS NULL OR {column} = ?)", [owner]
    return f"{column} = ?", [owner]


def claim_unowned(conn: db.Connection, table: str, owner: str) -> int:
    return conn.execute(f"UPDATE {table} SET owner_id = ? WHERE owner_id IS NULL", (owner,)).rowcount

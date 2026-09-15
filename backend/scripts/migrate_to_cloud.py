"""Move Zoetrope's data off this machine: SQLite -> Postgres, PDFs -> Supabase Storage, vectors -> Qdrant Cloud.

Run from `backend/` with the TARGET credentials in the environment (or .env):

    DATABASE_URL=postgresql://...            Supabase pooled connection string (port 6543)
    SUPABASE_URL=https://xxx.supabase.co     already set for auth
    SUPABASE_SERVICE_ROLE_KEY=...            Storage needs the service role, not the anon key
    SUPABASE_STORAGE_BUCKET=papers           optional, default "papers"
    TARGET_QDRANT_URL=https://xxx.cloud.qdrant.io:6333
    TARGET_QDRANT_API_KEY=...

    python -m scripts.migrate_to_cloud --all            # tables, PDFs and vectors
    python -m scripts.migrate_to_cloud --tables --dry-run

Every step is idempotent: rows insert with ON CONFLICT DO NOTHING, PDFs with the
same size are skipped, and a Qdrant collection whose point count already matches
is left alone. Sources are only ever read. When it finishes it prints the .env
lines that switch the app over.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

try:
    # Trust the operating system's certificate store (Windows keeps antivirus
    # TLS-inspection roots there) instead of only certifi's bundle.
    import truststore  # noqa: E402

    truststore.inject_into_ssl()
except ImportError:
    pass

from dotenv import load_dotenv  # noqa: E402

load_dotenv(BACKEND_DIR / ".env")

from app.storage import db, files  # noqa: E402

DATA_DIR = BACKEND_DIR / "app" / "data"
SQLITE_FILES = ("agent_history.sqlite3", "chat_history.sqlite3", "researchmind.sqlite3")
SKIP_TABLES = {"sqlite_sequence", "annotations", "paper_visualizations_legacy"}
BATCH = 500
VECTOR_BATCH = 256
COLLECTIONS = ("mini_chatbot_docs", "research_notes")


def say(text: str = "") -> None:
    print(text.encode("utf-8", "replace").decode(sys.stdout.encoding or "utf-8", "replace") if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8" else text, flush=True)


# ------------------------------------------------------------------ tables

def _store_modules():
    from app.storage import (
        agent_history, article_store, chat_history, ingestion_jobs, integrations, notes,
        scene_store, stage_scene_store, variant_store, visual_assets, visualization_store,
    )
    return [
        agent_history, chat_history, article_store, ingestion_jobs, integrations, notes,
        visualization_store, scene_store, stage_scene_store, variant_store, visual_assets,
    ]


def _sqlite_tables(conn: sqlite3.Connection) -> List[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").fetchall()
    return [row[0] for row in rows if row[0] not in SKIP_TABLES and not row[0].startswith("sqlite_")]


def _ordered_by_dependencies(conn: sqlite3.Connection, tables: List[str]) -> List[str]:
    """Parents before children so foreign keys hold while rows are copied."""
    deps = {table: {row[2] for row in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall()} & set(tables) for table in tables}
    ordered: List[str] = []
    while deps:
        ready = sorted(t for t, parents in deps.items() if not (parents - set(ordered)))
        if not ready:  # a cycle; fall back to name order
            ready = sorted(deps)
        ordered.extend(ready)
        for t in ready:
            deps.pop(t)
    return ordered


def _foreign_keys(conn: sqlite3.Connection, table: str) -> List[Dict[str, str]]:
    """[{from, table, to}] for each foreign key the SQLite table declares."""
    rows = conn.execute(f"PRAGMA foreign_key_list({table})").fetchall()
    return [{"from": row[3], "table": row[2], "to": row[4] or "rowid"} for row in rows]


def _target_columns(pg: db.Connection, table: str) -> List[str]:
    return sorted(db.table_columns(pg, table))


def _identity_columns(pg: db.Connection, table: str) -> List[str]:
    rows = pg.raw.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = %s AND is_identity = 'YES'",
        (table,),
    ).fetchall()
    return [row["column_name"] for row in rows]


def _count(pg: db.Connection, table: str) -> int:
    return int(pg.raw.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"])


def migrate_tables(dry_run: bool) -> bool:
    if not db.using_postgres():
        say("DATABASE_URL is not set; skipping tables.")
        return False
    say(f"== Tables -> Postgres ({db.database_url().split('@')[-1]})")
    if not dry_run:
        for module in _store_modules():
            module.init_db()
        say("   schema created")

    ok = True
    for filename in SQLITE_FILES:
        path = DATA_DIR / filename
        if not path.exists():
            say(f"   {filename}: not present, skipped")
            continue
        src = sqlite3.connect(path)
        src.row_factory = sqlite3.Row
        tables = _ordered_by_dependencies(src, _sqlite_tables(src))
        for table in tables:
            total = src.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            if dry_run:
                say(f"   {filename}:{table:<28} {total:>7} rows")
                continue
            with db.connect(DATA_DIR / filename) as pg:
                if table not in db.table_names(pg):
                    say(f"   {filename}:{table:<28} {total:>7} rows  SKIPPED (no such table in the new schema)")
                    continue
                source_cols = [row[1] for row in src.execute(f"PRAGMA table_info({table})").fetchall()]
                target_cols = set(_target_columns(pg, table))
                cols = [c for c in source_cols if c in target_cols]
                dropped = [c for c in source_cols if c not in target_cols]
                if dropped:
                    say(f"   {table}: columns not in target, not copied: {', '.join(dropped)}")
                placeholders = ", ".join(["?"] * len(cols))
                insert = f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders}) ON CONFLICT DO NOTHING"
                before = _count(pg, table)
                # SQLite ran with foreign keys unenforced for years, so children
                # whose parent row is gone exist. Postgres will not take them;
                # copy only rows whose parents exist and say how many were left.
                guards = [
                    f"({fk['from']} IS NULL OR {fk['from']} IN (SELECT {fk['to']} FROM {fk['table']}))"
                    for fk in _foreign_keys(src, table)
                ]
                where = f" WHERE {' AND '.join(guards)}" if guards else ""
                orphans = total - src.execute(f"SELECT COUNT(*) FROM {table}{where}").fetchone()[0] if guards else 0
                if orphans:
                    say(f"   {table}: {orphans} row(s) reference a parent that no longer exists; not copied")
                cursor = src.execute(f"SELECT {', '.join(cols)} FROM {table}{where}")
                copied = 0
                while True:
                    rows = cursor.fetchmany(BATCH)
                    if not rows:
                        break
                    pg.executemany(insert, [tuple(row) for row in rows])
                    copied += len(rows)
                    if total > 2000:
                        say(f"      {table}: {copied}/{total}", )
                for column in _identity_columns(pg, table):
                    db.reset_identity(pg, table, column)
                pg.commit()
                after = _count(pg, table)
                expected = total - orphans
                mark = "ok" if after >= expected else "MISMATCH"
                if after < expected:
                    ok = False
                say(f"   {filename}:{table:<28} {total:>7} rows -> target has {after:>7} (+{after - before}) {mark}")
        src.close()
    return ok


# ------------------------------------------------------------------ PDFs

def migrate_pdfs(dry_run: bool) -> bool:
    if not files.storage_configured():
        say("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; skipping PDFs.")
        return False
    local = list(files.local_pdfs())
    say(f"== PDFs -> Supabase Storage bucket '{files.bucket_name()}' ({len(local)} local files)")
    if dry_run:
        say(f"   would upload up to {len(local)} files, {sum(p.stat().st_size for p in local) / 1e6:.0f} MB")
        return True
    files.ensure_bucket()
    existing = {item["name"]: item.get("size") for item in files.list_stored()}
    uploaded = skipped = failed = 0
    for index, path in enumerate(local, 1):
        size = path.stat().st_size
        if existing.get(path.name) == size:
            skipped += 1
            continue
        try:
            files.store_pdf(path)
            uploaded += 1
        except Exception as exc:
            failed += 1
            say(f"   FAILED {path.name}: {exc}")
        if index % 20 == 0 or index == len(local):
            say(f"   {index}/{len(local)}  uploaded {uploaded}, already there {skipped}, failed {failed}")
    manifest = DATA_DIR / "uploaded_docs" / "arxiv_manifest.json"
    if manifest.exists():
        say("   note: arxiv_manifest.json stays with the code (it is configuration, not a PDF)")
    return failed == 0


# ------------------------------------------------------------------ vectors

def _qdrant(url: str, api_key: str | None):
    from qdrant_client import QdrantClient

    return QdrantClient(url=url, api_key=api_key or None, timeout=120)


def migrate_vectors(source_url: str, target_url: str, target_key: str, dry_run: bool, force: bool) -> bool:
    if not target_url:
        say("TARGET_QDRANT_URL not set; skipping vectors.")
        return False
    from qdrant_client.models import PointStruct, VectorParams

    say(f"== Vectors: {source_url} -> {target_url}")
    source = _qdrant(source_url, os.getenv("QDRANT_API_KEY") or None)
    target = _qdrant(target_url, target_key)
    source_names = {c.name for c in source.get_collections().collections}
    target_names = {c.name for c in target.get_collections().collections}
    ok = True
    for name in COLLECTIONS:
        if name not in source_names:
            say(f"   {name}: not in source, skipped")
            continue
        info = source.get_collection(name)
        total = info.points_count or 0
        if dry_run:
            say(f"   {name:<20} {total:>7} points")
            continue
        if name not in target_names:
            target.create_collection(collection_name=name, vectors_config=info.config.params.vectors)
            say(f"   {name}: created on target")
        for field, schema in (info.payload_schema or {}).items():
            try:
                target.create_payload_index(collection_name=name, field_name=field, field_schema=schema.data_type)
            except Exception:
                pass  # already there
        have = target.get_collection(name).points_count or 0
        if have >= total and not force:
            say(f"   {name:<20} {total:>7} points already on target, skipped (use --force to re-copy)")
            continue
        copied = 0
        offset = None
        started = time.monotonic()
        while True:
            points, offset = source.scroll(collection_name=name, limit=VECTOR_BATCH, offset=offset, with_payload=True, with_vectors=True)
            if not points:
                break
            target.upsert(
                collection_name=name,
                points=[PointStruct(id=p.id, vector=p.vector, payload=p.payload or {}) for p in points],
                wait=True,
            )
            copied += len(points)
            if copied % (VECTOR_BATCH * 8) == 0 or offset is None:
                rate = copied / max(1e-6, time.monotonic() - started)
                say(f"      {name}: {copied}/{total} ({rate:.0f} points/s)")
            if offset is None:
                break
        after = target.get_collection(name).points_count or 0
        mark = "ok" if after >= total else "MISMATCH"
        if after < total:
            ok = False
        say(f"   {name:<20} source {total:>7} -> target {after:>7} {mark}")
    return ok


# ------------------------------------------------------------------ main

def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--all", action="store_true", help="tables, PDFs and vectors")
    parser.add_argument("--tables", action="store_true")
    parser.add_argument("--pdfs", action="store_true")
    parser.add_argument("--vectors", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="count, do not write")
    parser.add_argument("--force", action="store_true", help="re-copy vectors even when counts match")
    parser.add_argument("--source-qdrant", default=os.getenv("SOURCE_QDRANT_URL") or os.getenv("QDRANT_URL") or "http://127.0.0.1:6333")
    parser.add_argument("--target-qdrant", default=os.getenv("TARGET_QDRANT_URL", ""))
    parser.add_argument("--target-qdrant-key", default=os.getenv("TARGET_QDRANT_API_KEY", ""))
    args = parser.parse_args(argv)
    if not (args.all or args.tables or args.pdfs or args.vectors):
        parser.error("choose --all or at least one of --tables, --pdfs, --vectors")

    results: Dict[str, bool] = {}
    if args.all or args.tables:
        results["tables"] = migrate_tables(args.dry_run)
    if args.all or args.pdfs:
        results["pdfs"] = migrate_pdfs(args.dry_run)
    if args.all or args.vectors:
        results["vectors"] = migrate_vectors(args.source_qdrant, args.target_qdrant, args.target_qdrant_key, args.dry_run, args.force)

    say()
    if args.dry_run:
        say("Dry run only; nothing was written.")
        return 0
    say("== Summary: " + ", ".join(f"{k} {'ok' if v else 'incomplete'}" for k, v in results.items()))
    if any(results.values()):
        say()
        say("To switch the app over, make sure backend/.env has:")
        if results.get("tables"):
            say("   DATABASE_URL=<the same pooled connection string>")
        if results.get("pdfs"):
            say("   SUPABASE_SERVICE_ROLE_KEY=<same key>   (SUPABASE_URL is already set)")
        if results.get("vectors"):
            say(f"   QDRANT_URL={args.target_qdrant}")
            say("   QDRANT_API_KEY=<the Qdrant Cloud key>")
        say("then restart the backend. The local SQLite files, PDFs and Qdrant container become a cold backup.")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    try:
        code = main()
    finally:
        db.close()
    raise SystemExit(code)

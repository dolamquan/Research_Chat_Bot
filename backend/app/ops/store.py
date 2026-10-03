"""Local telemetry, independent of the application stores and LangSmith.

No prompts, completions, request bodies, headers or credentials are persisted.
Only outbound LLM/API events contribute to cost. Missing usage/rates remain NULL.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "data" / "operations.sqlite3"
_ready: set[str] = set()
_lock = threading.Lock()
PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing"
DEFAULT_SETTINGS = {
    "monthly_budget": 100.0,
    "alert_percent": 80,
    "rates": [
        {"provider": "openai", "model": "gpt-5", "input": 1.25, "cached": 0.125, "output": 10.0},
        {"provider": "openai", "model": "gpt-5-mini", "input": 0.25, "cached": 0.025, "output": 2.0},
        {"provider": "openai", "model": "gpt-4o-mini", "input": 0.15, "cached": 0.075, "output": 0.6},
    ],
}


def db_path() -> str:
    return os.getenv("OPS_DB_PATH") or str(DEFAULT_PATH)


@contextmanager
def connection():
    path = db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        with _lock:
            if path not in _ready:
                db.executescript("""
                    PRAGMA journal_mode=WAL;
                    CREATE TABLE IF NOT EXISTS events (
                        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, parent_id TEXT,
                        kind TEXT NOT NULL, name TEXT NOT NULL, provider TEXT DEFAULT '',
                        model TEXT DEFAULT '', user_id TEXT DEFAULT '', user_email TEXT DEFAULT '',
                        started_at REAL NOT NULL, ended_at REAL, duration_ms REAL,
                        status TEXT NOT NULL DEFAULT 'running', http_status INTEGER,
                        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
                        cost_usd REAL, cost_source TEXT DEFAULT 'unknown',
                        error_type TEXT DEFAULT '', error TEXT DEFAULT '',
                        fingerprint TEXT DEFAULT '', metadata TEXT DEFAULT '{}', source TEXT DEFAULT 'local'
                    );
                    CREATE INDEX IF NOT EXISTS ops_events_time ON events(started_at DESC);
                    CREATE INDEX IF NOT EXISTS ops_events_request ON events(request_id);
                    CREATE INDEX IF NOT EXISTS ops_events_user ON events(user_id, started_at);
                    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS resolutions (fingerprint TEXT PRIMARY KEY, resolved_at REAL NOT NULL);
                    CREATE TABLE IF NOT EXISTS apis (id TEXT PRIMARY KEY, value TEXT NOT NULL);
                """)
                columns = {r[1] for r in db.execute("PRAGMA table_info(events)")}
                for name, declaration in {"api_id": "TEXT DEFAULT ''", "category": "TEXT DEFAULT ''",
                                          "billing_unit": "TEXT DEFAULT ''", "units": "REAL",
                                          "admitted": "INTEGER DEFAULT 1"}.items():
                    if name not in columns:
                        db.execute(f"ALTER TABLE events ADD COLUMN {name} {declaration}")
                db.execute("CREATE INDEX IF NOT EXISTS ops_events_api ON events(api_id, started_at)")
                from app.ops.services import DEFAULT_APIS, defaults, model_api_id
                for api in DEFAULT_APIS:
                    db.execute("INSERT OR IGNORE INTO apis VALUES (?,?)", (api["id"], json.dumps(defaults(api))))
                # Add identities to historical LLM calls without changing their captured costs.
                for row in db.execute("SELECT DISTINCT provider FROM events WHERE kind='llm' AND api_id=''").fetchall():
                    provider = row[0] or "unknown"
                    api = defaults({"id": model_api_id(provider), "name": f"{provider} chat", "provider": provider, "category": "llm", "billing": "tokens"})
                    db.execute("INSERT OR IGNORE INTO apis VALUES (?,?)", (api["id"], json.dumps(api)))
                    db.execute("UPDATE events SET api_id=?, category='llm', billing_unit='tokens' WHERE kind='llm' AND api_id='' AND provider=?", (api["id"], row[0]))
                db.execute("INSERT OR IGNORE INTO settings VALUES (1, ?)", (json.dumps(DEFAULT_SETTINGS),))
                db.commit()
                _ready.add(path)
        with db:
            yield db
    finally:
        db.close()


def settings() -> dict:
    with connection() as db:
        return json.loads(db.execute("SELECT value FROM settings WHERE id=1").fetchone()[0])


def save_settings(value: dict) -> dict:
    with connection() as db:
        db.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps(value),))
    return value


def sanitize_error(value) -> str:
    text = str(value)
    text = re.sub(r"(?i)(bearer\s+|(?:api[_-]?key|access_token|password|authorization)[\s\"':=]+)[^\s,;\"'}]+", r"\1[redacted]", text)
    text = re.sub(r"\b(?:sk-|sb_secret_|eyJ)[a-zA-Z0-9_.-]+", "[redacted]", text)
    text = re.sub(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", "[email]", text)
    text = re.sub(r"(https?://[^\s?]+)\?[^\s]+", r"\1?[redacted]", text)
    return text[:800]


def begin(event: dict):
    if event.get("kind") == "llm" and not event.get("api_id"):
        from app.ops.services import for_model
        api = for_model(event.get("provider") or "unknown")
        event = {**event, "api_id": api["id"], "category": api["category"], "billing_unit": "tokens"}
    with connection() as db:
        insert_event(db, event)


def insert_event(db, event: dict):
    columns = ("id", "request_id", "parent_id", "kind", "name", "provider", "model", "user_id", "user_email", "started_at", "metadata", "source", "api_id", "category", "billing_unit", "admitted")
    values = {"started_at": time.time(), "metadata": "{}", "source": "local", "admitted": 1, **event}
    if isinstance(values.get("metadata"), dict):
        values["metadata"] = json.dumps(values["metadata"])
    db.execute(f"INSERT OR IGNORE INTO events ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", [values.get(c, "") for c in columns])


def estimate(provider: str, model: str, usage: dict | None, service_tier: str = "") -> float | None:
    if usage is None or service_tier not in ("", "auto", "default", "standard"):
        return None
    rates = settings()["rates"]
    # Exact names and dated snapshots only. Never guess a rate for a new model family.
    rate = next((r for r in rates if r["provider"] == provider and (
        r["model"] == model or re.fullmatch(re.escape(r["model"]) + r"-\d{4}-\d{2}-\d{2}", model)
    )), None)
    if rate is None:
        return None
    incoming = max(0, int(usage["input_tokens"]))
    cached = min(incoming, max(0, int(usage.get("cached_tokens", 0))))
    return ((incoming - cached) * rate["input"] + cached * rate["cached"] + max(0, int(usage["output_tokens"])) * rate["output"]) / 1_000_000


def finish(event_id: str, *, status: str = "success", error=None, error_type: str = "", usage: dict | None = None,
           model: str | None = None, http_status: int | None = None, user=None, name: str | None = None,
           service_tier: str = "", reported_cost: float | None = None, ended_at: float | None = None,
           units: float | None = None, cost_source: str = ""):
    ended = ended_at if ended_at is not None else time.time()
    with connection() as db:
        event = db.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
        if event is None:
            return
        model = model or event["model"]
        name = name or event["name"]
        cost = reported_cost if reported_cost is not None else (estimate(event["provider"], model, usage, service_tier) if event["kind"] == "llm" else None)
        billing = json.loads(event["metadata"]).get("billing", {})
        if event["kind"] in ("llm", "api") and billing and reported_cost is None:
            mode = billing.get("billing")
            if mode == "tokens":
                cost = estimate(event["provider"], model, usage, service_tier)
            elif mode == "free":
                cost = 0.0
            elif status == "success" and mode in ("request", "unit"):
                units = 1.0 if mode == "request" else units
                if units is not None:
                    cost = units * billing["unit_price"] / billing["unit_size"]
        message = sanitize_error(error) if error else ""
        fingerprint = hashlib.sha256(f"{event['kind']}:{name}:{error_type or http_status}".encode()).hexdigest()[:20] if status == "error" else ""
        db.execute("""UPDATE events SET ended_at=?, duration_ms=?, status=?, http_status=?,
            input_tokens=?, output_tokens=?, cached_tokens=?, cost_usd=?, cost_source=?, error_type=?, error=?,
            fingerprint=?, model=?, name=?, user_id=?, user_email=?, units=? WHERE id=?""", (
            ended, max(0, ended - event["started_at"]) * 1000, status, http_status,
            usage.get("input_tokens") if usage else None, usage.get("output_tokens") if usage else None,
            usage.get("cached_tokens", 0) if usage else None, cost,
            cost_source or ("langsmith" if reported_cost is not None else "estimated" if cost is not None else "unknown"),
            error_type, message, fingerprint, model, name,
            user.id if user else event["user_id"], user.email if user else event["user_email"], units, event_id,
        ))


def decode(row) -> dict:
    result = dict(row)
    result["metadata"] = json.loads(result["metadata"])
    return result


def period_start(days: int) -> float:
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return (today - timedelta(days=days - 1)).timestamp()


def list_events(*, days=7, kind="", status="", query="", user_id="", model="", api_id="", provider="", category="", limit=50, offset=0) -> dict:
    conditions, params = ["started_at>=?"], [period_start(days)]
    for column, value in (("kind", kind), ("status", status), ("user_id", user_id), ("model", model), ("api_id", api_id), ("provider", provider), ("category", category)):
        if value:
            conditions.append(f"{column}=?")
            params.append(value)
    if query:
        conditions.append("(name LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR user_email LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\')")
        needle = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        params.extend([needle] * 5)
    where = " AND ".join(conditions)
    with connection() as db:
        total = db.execute(f"SELECT COUNT(*) FROM events WHERE {where}", params).fetchone()[0]
        rows = db.execute(f"SELECT * FROM events WHERE {where} ORDER BY started_at DESC, id LIMIT ? OFFSET ?", [*params, limit, offset]).fetchall()
    return {"events": [decode(r) for r in rows], "total": total, "limit": limit, "offset": offset}


def event_detail(event_id: str) -> dict | None:
    with connection() as db:
        event = db.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
        if event is None:
            return None
        timeline = db.execute("SELECT * FROM events WHERE request_id=? ORDER BY started_at, id LIMIT 1000", (event["request_id"],)).fetchall()
    return {"event": decode(event), "timeline": [decode(r) for r in timeline]}


def get_event(event_id: str) -> dict | None:
    with connection() as db:
        row = db.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    return decode(row) if row is not None else None


_METRICS = """COUNT(*) AS events, COALESCE(SUM(kind IN ('llm','api')),0) AS calls,
    COALESCE(SUM(kind IN ('http','websocket') AND parent_id IS NULL),0) AS requests,
    COALESCE(SUM(status='error'),0) AS errors, COALESCE(SUM(status='running'),0) AS running,
    COALESCE(SUM(CASE WHEN kind IN ('llm','api') THEN cost_usd END),0) AS cost,
    COALESCE(SUM(kind IN ('llm','api') AND cost_usd IS NULL),0) AS unpriced,
    COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
    COALESCE(SUM(cached_tokens),0) AS cached_tokens,
    AVG(CASE WHEN kind IN ('llm','api') THEN duration_ms END) AS latency_ms"""


def overview(days=7) -> dict:
    start = period_start(days)
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    with connection() as db:
        stats = dict(db.execute(f"SELECT {_METRICS}, COUNT(DISTINCT NULLIF(user_id,'')) AS users FROM events WHERE started_at>=?", (start,)).fetchone())
        previous = dict(db.execute(f"SELECT {_METRICS} FROM events WHERE started_at>=? AND started_at<?", (start - days * 86400, start)).fetchone())
        models = [dict(r) for r in db.execute(f"SELECT provider, model, {_METRICS} FROM events WHERE kind='llm' AND started_at>=? GROUP BY provider,model ORDER BY cost DESC", (start,))]
        areas = [dict(r) for r in db.execute(f"SELECT name, {_METRICS} FROM events WHERE kind='http' AND started_at>=? GROUP BY name ORDER BY events DESC LIMIT 8", (start,))]
        monthly = dict(db.execute(f"SELECT {_METRICS} FROM events WHERE kind IN ('llm','api') AND started_at>=?", (month_start,)).fetchone())
        bucket_format = "%Y-%m-%dT%H:00:00Z" if days == 1 else "%Y-%m-%dT00:00:00Z"
        buckets = {r["bucket"]: dict(r) for r in db.execute(f"SELECT strftime(?,started_at,'unixepoch') AS bucket, {_METRICS} FROM events WHERE started_at>=? GROUP BY bucket", (bucket_format, start))}
        first = db.execute("SELECT MIN(started_at) FROM events").fetchone()[0]
    count = 24 if days == 1 else days
    delta = timedelta(hours=1) if days == 1 else timedelta(days=1)
    zero = {k: 0 for k in stats if k != "users"}
    series = []
    for i in range(count):
        bucket = (datetime.fromtimestamp(start, timezone.utc) + delta * i).strftime(bucket_format)
        series.append({**zero, **buckets.get(bucket, {}), "bucket": bucket})
    return {"stats": stats, "previous": previous, "models": models, "areas": areas, "series": series,
            "monthly": monthly, "settings": settings(), "first_event_at": first, "generated_at": time.time(), "timezone": "UTC"}


def users(days=7) -> list[dict]:
    with connection() as db:
        return [dict(r) for r in db.execute(f"SELECT user_id, MAX(user_email) AS email, MAX(started_at) AS last_seen, {_METRICS} FROM events WHERE user_id!='' AND started_at>=? GROUP BY user_id ORDER BY cost DESC, events DESC", (period_start(days),))]


def issues(days=7) -> list[dict]:
    with connection() as db:
        rows = db.execute("""SELECT e.fingerprint, e.name, e.kind, MAX(e.error_type) AS error_type,
            MAX(e.error) AS error, COUNT(*) AS occurrences, COUNT(DISTINCT NULLIF(e.user_id,'')) AS users,
            MAX(e.started_at) AS last_seen, MAX(e.id) AS event_id,
            COALESCE(MAX(e.started_at)<=r.resolved_at,0) AS resolved
            FROM events e LEFT JOIN resolutions r ON e.fingerprint=r.fingerprint
            WHERE e.status='error' AND e.started_at>=? GROUP BY e.fingerprint ORDER BY last_seen DESC""", (period_start(days),)).fetchall()
        result = [dict(r) for r in rows]
        for issue in result:
            issue["event_id"] = db.execute("SELECT id FROM events WHERE fingerprint=? ORDER BY started_at DESC LIMIT 1", (issue["fingerprint"],)).fetchone()[0]
        return result


def resolve_issue(fingerprint: str, resolved: bool):
    with connection() as db:
        if resolved:
            db.execute("INSERT INTO resolutions VALUES (?,?) ON CONFLICT(fingerprint) DO UPDATE SET resolved_at=excluded.resolved_at", (fingerprint, time.time()))
        else:
            db.execute("DELETE FROM resolutions WHERE fingerprint=?", (fingerprint,))

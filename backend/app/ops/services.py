"""Provider registry and admission policies for any outbound API.

Registration describes an integration; credentials stay in the integration's
existing server-side configuration. No endpoint proxy or secret storage here.
"""
from __future__ import annotations

import json
import hashlib
import re
import time
from datetime import datetime, timezone

from app.ops import store


DEFAULT_APIS = [
    {"id": "openai-chat", "name": "OpenAI chat", "provider": "openai", "category": "llm", "billing": "tokens"},
    {"id": "anthropic-chat", "name": "Anthropic chat", "provider": "anthropic", "category": "llm", "billing": "tokens"},
    {"id": "notion", "name": "Notion", "provider": "notion", "category": "productivity", "billing": "unknown"},
    {"id": "arxiv", "name": "arXiv", "provider": "arxiv", "category": "search", "billing": "unknown"},
    {"id": "document-fetch", "name": "Document downloads", "provider": "web", "category": "documents", "billing": "unknown"},
    {"id": "mcp-http", "name": "External MCP HTTP", "provider": "mcp", "category": "integration", "billing": "unknown"},
]


class APIControlError(RuntimeError):
    """A configured policy prevented a call before the provider was contacted."""


def defaults(value):
    return {"enabled": True, "billing": "unknown", "unit": "request", "unit_price": 0,
            "unit_size": 1, "monthly_budget": None, "monthly_call_limit": None, **value}


def get(api_id):
    with store.connection() as db:
        row = db.execute("SELECT value FROM apis WHERE id=?", (api_id,)).fetchone()
    return json.loads(row[0]) if row else None


def save(value):
    value = defaults(value)
    with store.connection() as db:
        db.execute("INSERT INTO apis VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
                   (value["id"], json.dumps(value)))
    return value


def model_api_id(provider):
    name = str(provider or "unknown").strip().lower()
    slug = re.sub(r"[^a-z0-9_-]+", "-", name).strip("-_") or "unknown"
    if slug != name or len(slug) > 70:
        slug = slug[:62] + "-" + hashlib.sha256(name.encode()).hexdigest()[:8]
    return f"{slug}-chat"


def for_model(provider):
    """Unknown LangChain providers register themselves with unknown token rates."""
    provider = str(provider or "unknown").strip().lower()[:50] or "unknown"
    api_id = model_api_id(provider)
    existing = get(api_id)
    if existing:
        return existing
    value = defaults({"id": api_id, "name": f"{provider} chat", "provider": provider,
                      "category": "llm", "billing": "tokens"})
    # Never overwrite an administrator's policy during concurrent discovery.
    with store.connection() as db:
        db.execute("INSERT OR IGNORE INTO apis VALUES (?,?)", (api_id, json.dumps(value)))
    return get(api_id)


def registry(days=7):
    month = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    with store.connection() as db:
        values = [json.loads(r[0]) for r in db.execute("SELECT value FROM apis ORDER BY id")]
        stats = {r["api_id"]: dict(r) for r in db.execute(
            f"SELECT api_id, {store._METRICS}, MAX(started_at) AS last_seen FROM events WHERE api_id!='' AND started_at>=? GROUP BY api_id",
            (store.period_start(days),))}
        monthly = {r["api_id"]: dict(r) for r in db.execute(
            "SELECT api_id, COALESCE(SUM(cost_usd),0) AS cost, SUM(admitted) AS calls FROM events WHERE api_id!='' AND started_at>=? GROUP BY api_id", (month,))}
    zero = {"events": 0, "calls": 0, "cost": 0, "errors": 0, "unpriced": 0, "latency_ms": None, "last_seen": None}
    return [{**v, "stats": stats.get(v["id"], zero), "monthly": monthly.get(v["id"], {"cost": 0, "calls": 0})} for v in values]


def admit(event):
    """Serialize policy checks and event insertion so call quotas are atomic.

    Spend thresholds use recorded cost. Concurrent or unpriced calls can exceed
    a spending threshold; these are not provider billing caps.
    """
    api_id = event["api_id"]
    now = time.time()
    month = datetime.fromtimestamp(now, timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    with store.connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT value FROM apis WHERE id=?", (api_id,)).fetchone()
        if not row:
            raise ValueError(f"Register API {api_id!r} before using it.")
        config = json.loads(row[0])
        totals = db.execute("SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost FROM events WHERE api_id=? AND admitted=1 AND started_at>=?", (api_id, month)).fetchone()
        reason = ""
        if not config["enabled"]:
            reason = f"{config['name']} is paused in Research Ops."
        elif config["monthly_call_limit"] is not None and totals["calls"] >= config["monthly_call_limit"]:
            reason = f"{config['name']} reached its monthly call limit."
        elif config["monthly_budget"] is not None and totals["cost"] >= config["monthly_budget"]:
            reason = f"{config['name']} reached its recorded monthly spending threshold."
        event = {**event, "started_at": now, "provider": config["provider"], "category": config["category"],
                 "billing_unit": "tokens" if config["billing"] == "tokens" else "request" if config["billing"] == "request" else config["unit"],
                 "admitted": 0 if reason else 1,
                 "metadata": {**event.get("metadata", {}), "billing": {k: config[k] for k in ("billing", "unit_price", "unit_size")}}}
        store.insert_event(db, event)
    if reason:
        store.finish(event["id"], status="error", error=reason, error_type="APIControlError", reported_cost=0,
                     cost_source="blocked", units=0)
        raise APIControlError(reason)
    return event["id"]

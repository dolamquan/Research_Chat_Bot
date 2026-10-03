import csv
import io
import os
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.auth.context import CurrentUser
from app.auth.deps import require_admin
from app.ops import services, store
from app.ops.telemetry import enabled

router = APIRouter(prefix="/ops", tags=["operations"], dependencies=[Depends(require_admin)])


class Rate(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    provider: str = Field(min_length=1, max_length=50)
    model: str = Field(min_length=1, max_length=100)
    input: float = Field(ge=0, le=10000)
    cached: float = Field(ge=0, le=10000)
    output: float = Field(ge=0, le=10000)


class Settings(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    monthly_budget: float = Field(gt=0, le=1_000_000)
    alert_percent: int = Field(ge=1, le=100)
    rates: list[Rate] = Field(max_length=200)

    @model_validator(mode="after")
    def unique_rates(self):
        keys = [(r.provider, r.model) for r in self.rates]
        if len(keys) != len(set(keys)):
            raise ValueError("Each provider and model must have a unique rate.")
        return self


class Resolution(BaseModel):
    resolved: bool


class HistoryImport(BaseModel):
    days: int = Field(default=7, ge=1, le=30)


class APIRegistration(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid", str_strip_whitespace=True)
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,79}$")
    name: str = Field(min_length=1, max_length=100)
    provider: str = Field(min_length=1, max_length=50)
    category: str = Field(min_length=1, max_length=50)
    enabled: bool = True
    billing: Literal["unknown", "free", "tokens", "request", "unit"] = "unknown"
    unit: str = Field(default="request", min_length=1, max_length=50)
    unit_price: float = Field(default=0, ge=0, le=1_000_000)
    unit_size: float = Field(default=1, gt=0, le=1_000_000_000)
    monthly_budget: float | None = Field(default=None, gt=0, le=1_000_000)
    monthly_call_limit: int | None = Field(default=None, ge=1, le=1_000_000_000)


@router.get("/apis")
def apis(days: int = Query(7, ge=1, le=90)):
    return {"apis": services.registry(days)}


@router.post("/apis", status_code=201)
def create_api(body: APIRegistration):
    # Use an atomic insert: repeated clicks cannot overwrite an existing policy.
    import json
    import sqlite3
    try:
        with store.connection() as db:
            db.execute("INSERT INTO apis VALUES (?,?)", (body.id, json.dumps(body.model_dump())))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "An API with this ID already exists.")
    return body.model_dump()


@router.put("/apis/{api_id}")
def update_api(api_id: str, body: APIRegistration):
    if body.id != api_id:
        raise HTTPException(422, "API IDs cannot be changed; integrations reference them.")
    existing = services.get(api_id)
    if existing is None:
        raise HTTPException(404, "API not found.")
    if body.provider != existing["provider"] or body.category != existing["category"]:
        raise HTTPException(422, "Provider and category cannot be changed for an existing API. Register another API ID.")
    return services.save(body.model_dump())


@router.get("/identity")
def identity(user: CurrentUser = Depends(require_admin)):
    return {"id": user.id, "email": user.email, "role": user.role}


@router.get("/overview")
def overview(days: int = Query(7, ge=1, le=90)):
    return store.overview(days)


@router.get("/events")
def events(days: int = Query(7, ge=1, le=90), kind: Literal["", "http", "websocket", "llm", "api", "tool", "retrieval"] = "",
           status: Literal["", "running", "success", "error", "cancelled"] = "", query: str = Query("", max_length=200),
           user_id: str = Query("", max_length=200), model: str = Query("", max_length=100),
           limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0, le=10_000_000),
           api_id: str = Query("", max_length=80), provider: str = Query("", max_length=50), category: str = Query("", max_length=50)):
    return store.list_events(days=days, kind=kind, status=status, query=query, user_id=user_id, model=model, limit=limit, offset=offset, api_id=api_id, provider=provider, category=category)


@router.get("/events/{event_id}")
def event(event_id: str):
    result = store.event_detail(event_id)
    if result is None:
        raise HTTPException(404, "Call not found.")
    return result


@router.get("/users")
def users(days: int = Query(7, ge=1, le=90)):
    return {"users": store.users(days)}


@router.get("/issues")
def issues(days: int = Query(7, ge=1, le=90)):
    return {"issues": store.issues(days)}


@router.patch("/issues/{fingerprint}")
def resolve_issue(fingerprint: str, body: Resolution):
    if not any(i["fingerprint"] == fingerprint for i in store.issues(90)):
        raise HTTPException(404, "Issue not found in the last 90 days.")
    store.resolve_issue(fingerprint, body.resolved)
    return {"resolved": body.resolved}


@router.get("/settings")
def settings():
    return store.settings()


@router.put("/settings")
def save_settings(body: Settings):
    return store.save_settings(body.model_dump())


@router.get("/connection")
def connection():
    with store.connection() as db:
        total = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    return {"telemetry_enabled": enabled(), "events_stored": total,
        "langsmith_configured": bool(os.getenv("LANGSMITH_API_KEY") or os.getenv("LANGCHAIN_API_KEY")),
        "langsmith_project": os.getenv("LANGSMITH_PROJECT") or os.getenv("LANGCHAIN_PROJECT") or "default",
        "pricing_source": store.PRICING_SOURCE, "pricing_verified": "2026-10-01",
        "storage": "SQLite on this backend", "coverage": "HTTP, assistant WebSocket connections, all LangChain chat providers, Notion, arXiv, document downloads, external MCP HTTP, retrieval, catalog tools and registered API adapters",
        "excluded": "Unwrapped SDK calls, database/vector-store traffic, external scripts not using an adapter, and live transcription audio billing"}


@router.post("/import-langsmith")
def import_langsmith(body: HistoryImport):
    from app.ops.langsmith_import import import_history
    try:
        return import_history(body.days)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        # Provider errors can contain credentials and hosts. Keep the response generic.
        raise HTTPException(502, "Could not read LangSmith. Check the project's server-side key, project name and connection.") from exc


@router.get("/export")
def export(days: int = Query(7, ge=1, le=90), kind: str = "", status: str = "", query: str = Query("", max_length=200),
           user_id: str = "", model: str = "", api_id: str = "", provider: str = "", category: str = ""):
    result = store.list_events(days=days, kind=kind, status=status, query=query, user_id=user_id, model=model, api_id=api_id, provider=provider, category=category, limit=10000)
    output = io.StringIO()
    columns = ["id", "request_id", "kind", "name", "api_id", "provider", "category", "model", "user_id", "user_email", "started_at", "duration_ms", "status", "input_tokens", "output_tokens", "cached_tokens", "units", "billing_unit", "admitted", "cost_usd", "cost_source", "error_type", "error", "source"]
    writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in result["events"]:
        # Prevent spreadsheet formula execution when opening exported telemetry.
        writer.writerow({key: "'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else value for key, value in row.items()})
    return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="research-ops-calls.csv"', "X-Ops-Export-Total": str(result["total"]), "X-Ops-Export-Rows": str(len(result["events"]))})

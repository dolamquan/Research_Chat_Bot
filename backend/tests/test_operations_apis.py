"""Expandable API accounting, migration and policies; no provider calls."""
import asyncio
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

from app.auth.context import CurrentUser, reset_current_user, set_current_user
from app.auth.deps import require_admin
from app.ops import services, store
from app.ops.api_calls import api_call, call_api
from app.ops.routes import router
from app.ops.telemetry import install_callbacks, parent_id, request_id


def register(**overrides):
    return services.save({"id": "search", "name": "Search", "provider": "custom-search",
                          "category": "search", "billing": "request", "unit_price": 2, "unit_size": 1000, **overrides})


def test_mixed_api_costs_units_and_trace_attribution():
    register()
    services.save({"id": "audio", "name": "Audio", "provider": "custom-audio", "category": "audio",
                   "billing": "unit", "unit": "seconds", "unit_price": .12, "unit_size": 60})
    actor = set_current_user(CurrentUser("alice", "alice@example.test"))
    trace = request_id.set("root")
    parent = parent_id.set("tool")
    try:
        with api_call("search", "Search documents"):
            pass
        async def audio():
            async with api_call("audio", "Transcription") as call:
                call.measure(units=90)
        asyncio.run(audio())
    finally:
        reset_current_user(actor); request_id.reset(trace); parent_id.reset(parent)
    result = store.list_events()
    assert all(e["request_id"] == "root" and e["parent_id"] == "tool" and e["user_id"] == "alice" for e in result["events"])
    assert store.overview()["stats"]["cost"] == pytest.approx(.182)
    assert store.overview()["monthly"]["cost"] == pytest.approx(.182)
    assert store.users()[0]["cost"] == pytest.approx(.182)
    assert store.list_events(category="audio")["events"][0]["billing_unit"] == "seconds"
    assert store.list_events(provider="custom-search")["total"] == 1
    assert store.list_events(api_id="search")["total"] == 1


def test_missing_usage_reported_cost_free_and_pricing_snapshot():
    register(billing="unit", unit="images")
    with api_call("search", "Unknown units"):
        pass
    with api_call("search", "Provider cost") as call:
        call.measure(reported_cost=.47)
    with api_call("search", "Captured price") as call:
        register(unit_price=200)
        call.measure(units=2)
    events = store.list_events()["events"]
    assert next(e for e in events if e["name"] == "Unknown units")["cost_usd"] is None
    assert next(e for e in events if e["name"] == "Provider cost")["cost_source"] == "provider"
    assert next(e for e in events if e["name"] == "Captured price")["cost_usd"] == pytest.approx(.004)
    register(billing="free")
    with api_call("search", "Explicitly free"):
        pass
    assert store.list_events()["events"][0]["cost_usd"] == 0


def test_controls_prevent_outbound_calls_and_record_denials():
    register(enabled=False)
    sent = []
    with pytest.raises(services.APIControlError, match="paused"):
        call_api("search", "Blocked", lambda: sent.append(True))
    assert sent == []
    denied = store.list_events()["events"][0]
    assert denied["admitted"] == 0 and denied["cost_usd"] == 0 and denied["error_type"] == "APIControlError"
    register(monthly_budget=.001)
    call_api("search", "Allowed", lambda: None)
    with pytest.raises(services.APIControlError, match="spending threshold"):
        call_api("search", "Over budget", lambda: sent.append(True))
    assert sent == []


def test_existing_notion_integration_obeys_pause_before_http(monkeypatch):
    from app.integrations import notion
    services.save({**services.get("notion"), "enabled": False})
    monkeypatch.setattr(notion, "_headers", lambda: {})
    sent = []
    monkeypatch.setattr(notion.requests, "request", lambda *args, **kwargs: sent.append(True))
    with pytest.raises(services.APIControlError, match="paused"):
        notion._request("GET", "/pages/private-page")
    assert sent == []
    assert store.list_events()["events"][0]["api_id"] == "notion"


def test_monthly_quota_admission_is_atomic_under_concurrency():
    register(monthly_call_limit=3)
    def attempt(_):
        try:
            with api_call("search", "Concurrent search"):
                return True
        except services.APIControlError:
            return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(attempt, range(12))) == 3
    assert next(a for a in services.registry() if a["id"] == "search")["monthly"]["calls"] == 3


def test_http_failures_cancellation_and_redaction():
    register()
    class FailedResponse:
        status_code = 503
        text = "SECRET RESPONSE BODY"
    call_api("search", "Search service", lambda: FailedResponse())
    assert store.list_events()["events"][0]["status"] == "error"
    assert store.list_events()["events"][0]["cost_usd"] is None
    with pytest.raises(RuntimeError):
        with api_call("search", "Failure"):
            raise RuntimeError("api_key=SECRET https://example.test/?token=PRIVATE")
    async def cancel():
        async with api_call("search", "Cancelled"):
            raise asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(cancel())
    events = store.list_events()["events"]
    assert not any("SECRET" in str(e) or "PRIVATE" in str(e) for e in events)
    assert events[0]["status"] == "cancelled"
    assert parent_id.get() == ""


def test_token_based_embedding_api_and_unknown_provider_discovery():
    register(billing="tokens", provider="custom-embed", category="embeddings")
    settings = store.settings()
    settings["rates"].append({"provider": "custom-embed", "model": "embed-v1", "input": 1, "cached": .5, "output": 0})
    store.save_settings(settings)
    with api_call("search", "Embed documents", model="embed-v1") as call:
        call.measure(usage={"input_tokens": 1000, "output_tokens": 0})
    assert store.list_events()["events"][0]["cost_usd"] == pytest.approx(.001)
    discovered = services.for_model("new-provider")
    services.save({**discovered, "enabled": False})
    assert not services.for_model("new-provider")["enabled"]
    from app.ops.routes import APIRegistration
    unusual = services.for_model("Example / Azure AI")
    assert APIRegistration.model_validate(unusual).id == unusual["id"]
    assert unusual["id"] != services.model_api_id("Example - Azure AI")


def test_langchain_controls_stop_actual_invocation_even_with_inbound_tracing_off(monkeypatch):
    monkeypatch.setenv("OPS_TELEMETRY_ENABLED", "false")
    install_callbacks()
    services.save({**services.for_model("unknown"), "enabled": False})
    model = FakeMessagesListChatModel(responses=[AIMessage(content="unused"), AIMessage(content="also unused")])
    with pytest.raises(services.APIControlError):
        model.invoke("private prompt", config={"metadata": {"ops_api_id": "unknown-chat"}})
    assert model.i == 0
    assert store.list_events()["events"][0]["admitted"] == 0


def test_registration_auth_validation_and_filtered_export():
    app = FastAPI(); app.include_router(router)
    async def admin():
        return CurrentUser("admin", "admin@example.test", role="admin")
    app.dependency_overrides[require_admin] = admin
    with TestClient(app) as client:
        config = services.defaults({"id": "images", "name": "Image API", "provider": "custom", "category": "images"})
        assert client.post("/ops/apis", json=config).status_code == 201
        assert client.post("/ops/apis", json=config).status_code == 409
        for change in ({"id": "INVALID"}, {"unit_size": 0}, {"monthly_call_limit": 0}, {"unit_price": -1}, {"secret": "never-store"}):
            assert client.post("/ops/apis", json={**config, **change}).status_code == 422
        assert client.put("/ops/apis/images", json={**config, "id": "other"}).status_code == 422
        assert client.put("/ops/apis/images", json={**config, "provider": "other"}).status_code == 422
        assert client.put("/ops/apis/images", json={**config, "enabled": False}).status_code == 200
        register()
        call_api("search", "Search", lambda: None)
        exported = client.get("/ops/export?api_id=search")
        assert exported.headers["X-Ops-Export-Rows"] == "1"
        assert "billing_unit" in exported.text
        assert client.get("/ops/events?kind=api&provider=custom-search").json()["total"] == 1
        assert client.get("/ops/apis").status_code == 200
    app.dependency_overrides.clear()
    with TestClient(app) as client:
        # Local development auth is disabled in conftest; override with forbidden to test admin boundary.
        from fastapi import HTTPException
        async def forbidden():
            raise HTTPException(403)
        app.dependency_overrides[require_admin] = forbidden
        assert client.get("/ops/apis").status_code == 403
        assert client.post("/ops/apis", json=config).status_code == 403
        assert client.put("/ops/apis/images", json=config).status_code == 403


def test_old_database_migrates_without_losing_historical_cost(tmp_path, monkeypatch):
    old = tmp_path / "legacy.sqlite3"
    # Construct the original schema by removing additive fields from a current database.
    store.begin({"id": "old", "request_id": "old", "kind": "llm", "name": "gpt-5", "provider": "openai", "model": "gpt-5"})
    store.finish("old", reported_cost=.123)
    with store.connection() as db:
        backup = sqlite3.connect(old); db.backup(backup); backup.close()
    with sqlite3.connect(old) as db:
        db.execute("DROP INDEX ops_events_api")
        for column in ("api_id", "category", "billing_unit", "units", "admitted"):
            db.execute(f"ALTER TABLE events DROP COLUMN {column}")
        db.execute("DROP TABLE apis")
    monkeypatch.setenv("OPS_DB_PATH", str(old))
    event = store.get_event("old")
    assert event["cost_usd"] == .123 and event["api_id"] == "openai-chat"
    assert services.get("openai-chat")["enabled"]

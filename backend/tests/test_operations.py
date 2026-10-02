"""Cost accounting, request attribution, private admin data and offline tracing."""
import asyncio
from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from app.auth.context import CurrentUser, reset_current_user, set_current_user
from app.auth.deps import get_current_user, require_admin
from app.ops import store
from app.ops.routes import router
from app.ops.telemetry import OperationsCallback, OperationsMiddleware, install_callbacks, traced_tool


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv("OPS_DB_PATH", str(tmp_path / "operations.sqlite3"))
    monkeypatch.setenv("OPS_TELEMETRY_ENABLED", "true")
    token = set_current_user(None)
    yield
    reset_current_user(token)


def client_app():
    application = FastAPI()
    application.add_middleware(OperationsMiddleware)
    application.include_router(router)
    return application


def test_cached_input_and_reasoning_are_counted_once():
    usage = {"input_tokens": 10000, "cached_tokens": 8000, "output_tokens": 2000}
    assert store.estimate("openai", "gpt-5", usage) == pytest.approx(.0235)
    assert store.estimate("openai", "gpt-5-2025-08-07", usage) == pytest.approx(.0235)
    assert store.estimate("openai", "gpt-5-new", usage) is None
    assert store.estimate("openai", "gpt-5", None) is None
    assert store.estimate("openai", "gpt-5", usage, "priority") is None


def test_callback_records_usage_and_does_not_store_model_text():
    token = set_current_user(CurrentUser("alice", "alice@example.test"))
    callback = OperationsCallback()
    run_id = uuid4()
    callback.on_chat_model_start({}, [["A PRIVATE PROMPT"]], run_id=run_id, invocation_params={"model": "gpt-5"})
    result = LLMResult(generations=[[ChatGeneration(message=AIMessage(content="A PRIVATE ANSWER", usage_metadata={
        "input_tokens": 10000, "output_tokens": 2000, "total_tokens": 12000, "input_token_details": {"cache_read": 8000}, "output_token_details": {"reasoning": 1000},
    }))]])
    callback.on_llm_end(result, run_id=run_id)
    event = store.event_detail(str(run_id))["event"]
    assert event["cost_usd"] == pytest.approx(.0235)
    assert event["user_id"] == "alice"
    assert event["cached_tokens"] == 8000
    assert "PRIVATE" not in str(event)
    reset_current_user(token)


def test_aggregate_output_not_double_counted_and_missing_usage_stays_unknown():
    cb = OperationsCallback()
    for usage in ({"prompt_tokens": 100, "completion_tokens": 50}, {}):
        run_id = uuid4()
        cb.on_chat_model_start({}, [], run_id=run_id, invocation_params={"model": "gpt-4o-mini"})
        cb.on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(content="ok"))]], llm_output={"token_usage": usage}), run_id=run_id)
    summary = store.overview()["stats"]
    assert summary["calls"] == 2
    assert summary["unpriced"] == 1
    assert summary["cost"] == pytest.approx(.000045)


def test_http_user_model_and_nested_tool_share_trace():
    install_callbacks()
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    app = client_app()
    model = FakeMessagesListChatModel(responses=[AIMessage(content="private", usage_metadata={"input_tokens": 10, "output_tokens": 4, "total_tokens": 14})])

    @traced_tool
    async def tool(name):
        return await model.ainvoke("private")

    @app.get("/research/{paper_id}")
    async def research(paper_id: str, user=Depends(get_current_user)):
        await tool("research.read_paper")
        return {"ok": True}

    with TestClient(app) as client:
        response = client.get("/research/paper-1?access_token=SECRET")
    events = store.list_events()["events"]
    assert {e["kind"] for e in events} == {"http", "llm", "tool"}
    assert len({e["request_id"] for e in events}) == 1
    assert all(e["user_id"] == "local-dev" for e in events)
    assert next(e for e in events if e["kind"] == "http")["name"] == "GET /research/{paper_id}"
    assert "SECRET" not in str(events)
    assert response.headers["x-ops-request-id"] == events[0]["request_id"]


def test_admin_routes_reject_regular_users_and_do_not_trace_polling():
    app = client_app()

    async def forbidden():
        raise HTTPException(403, "Administrator access required.")

    app.dependency_overrides[require_admin] = forbidden
    with TestClient(app) as client:
        for path in ("/ops/overview", "/ops/events", "/ops/users", "/ops/settings", "/ops/export"):
            assert client.get(path).status_code == 403
        assert client.put("/ops/settings", json=store.DEFAULT_SETTINGS).status_code == 403
    assert store.list_events()["total"] == 0


def test_settings_reject_invalid_rates_and_apply_only_to_future_calls():
    with TestClient(client_app()) as client:
        payload = {**store.settings(), "monthly_budget": 0}
        assert client.put("/ops/settings", json=payload).status_code == 422
        payload = store.settings()
        payload["rates"].append(payload["rates"][0])
        assert client.put("/ops/settings", json=payload).status_code == 422
        payload = store.settings()
        payload["monthly_budget"] = 50
        assert client.put("/ops/settings", json=payload).status_code == 200
        assert client.get("/ops/settings").json()["monthly_budget"] == 50


def test_error_resolution_reopens_on_new_failure_and_redacts_credentials():
    app = client_app()

    @app.get("/fail")
    def fail():
        raise HTTPException(502, "api_key=sk-secret-token alice@example.com https://example.com/?access_token=secret")

    with TestClient(app) as client:
        client.get("/fail")
        issue = client.get("/ops/issues").json()["issues"][0]
        assert "secret" not in issue["error"] and "alice@example.com" not in issue["error"]
        assert client.patch(f"/ops/issues/{issue['fingerprint']}", json={"resolved": True}).status_code == 200
        assert client.get("/ops/issues").json()["issues"][0]["resolved"] == 1
        client.get("/fail")
        assert client.get("/ops/issues").json()["issues"][0]["resolved"] == 0


def test_export_escapes_formula_fields_and_pagination_keeps_full_total():
    for i in range(5):
        store.begin({"id": str(i), "request_id": str(i), "kind": "tool", "name": "=HYPERLINK(\"malicious\")"})
        store.finish(str(i))
    result = store.list_events(limit=2, offset=2)
    assert result["total"] == 5 and len(result["events"]) == 2
    assert store.list_events(query="%")['total'] == 0
    with TestClient(client_app()) as client:
        response = client.get("/ops/export")
        assert "'=HYPERLINK" in response.text
        assert response.headers['x-ops-export-total'] == '5'


def test_telemetry_failure_does_not_change_endpoint_result(monkeypatch):
    def broken(*args, **kwargs):
        raise OSError("Disk unavailable")
    monkeypatch.setattr(store, "begin", broken)
    app = client_app()

    @app.get("/research")
    def research():
        return {"ok": True}

    with TestClient(app) as client:
        assert client.get("/research").json() == {"ok": True}

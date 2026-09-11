"""Connect Notion: consent round-trip, signed state, token storage, database listing.

No test reaches Notion: the token exchange is stubbed at the HTTP boundary.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.auth.context import LOCAL_USER
from app.integrations import notion, notion_oauth
from app.storage import integrations

FRONTEND = "http://127.0.0.1:5173"


@pytest.fixture(autouse=True)
def configured(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(integrations, "DATA_DIR", tmp_path)
    monkeypatch.setattr(integrations, "DB_PATH", tmp_path / "integrations.sqlite3")
    monkeypatch.setattr(integrations, "KEY_PATH", tmp_path / "integration.key")
    monkeypatch.delenv("INTEGRATION_SECRET_KEY", raising=False)
    monkeypatch.setenv("NOTION_CLIENT_ID", "client-123")
    monkeypatch.setenv("NOTION_CLIENT_SECRET", "secret-xyz")
    monkeypatch.setenv("NOTION_REDIRECT_URI", "http://localhost:8002/integrations/notion/callback")
    monkeypatch.setenv("FRONTEND_URL", FRONTEND)
    monkeypatch.delenv("NOTION_API_KEY", raising=False)


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app, follow_redirects=False)


def test_authorize_url_carries_client_redirect_and_a_state_bound_to_the_user():
    url = notion_oauth.authorize_url("user-a")
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    assert parsed.netloc == "api.notion.com" and parsed.path == "/v1/oauth/authorize"
    assert query["client_id"] == ["client-123"]
    assert query["owner"] == ["user"]
    assert query["redirect_uri"] == ["http://localhost:8002/integrations/notion/callback"]
    assert notion_oauth.read_state(query["state"][0]) == "user-a"
    # Each link is single-purpose: a fresh nonce every time.
    assert parse_qs(urlparse(notion_oauth.authorize_url("user-a")).query)["state"] != query["state"]


def test_state_rejects_tampering_and_requires_configuration(monkeypatch):
    with pytest.raises(notion_oauth.NotionOAuthError):
        notion_oauth.read_state("not-a-real-state")
    good = notion_oauth.make_state("user-a")
    with pytest.raises(notion_oauth.NotionOAuthError):
        notion_oauth.read_state(good[:-4] + "AAAA")
    monkeypatch.delenv("NOTION_CLIENT_SECRET")
    assert not notion_oauth.is_configured()
    with pytest.raises(notion_oauth.NotionOAuthError, match="not configured"):
        notion_oauth.authorize_url("user-a")


def test_exchange_code_uses_basic_auth_and_surfaces_notion_errors(monkeypatch):
    calls = []

    def fake_post(url, headers, json, timeout):
        calls.append((url, headers, json))
        return SimpleNamespace(status_code=200, json=lambda: {"access_token": "ntn-token", "workspace_name": "Jack's Space", "workspace_id": "ws-1", "bot_id": "bot-1"})

    monkeypatch.setattr(notion_oauth.requests, "post", fake_post)
    data = notion_oauth.exchange_code("code-1")
    assert data["access_token"] == "ntn-token"
    url, headers, payload = calls[0]
    assert url == notion_oauth.TOKEN_URL
    assert headers["Authorization"].startswith("Basic ") and "client-123" not in headers["Authorization"]
    assert payload == {"grant_type": "authorization_code", "code": "code-1", "redirect_uri": "http://localhost:8002/integrations/notion/callback"}

    monkeypatch.setattr(
        notion_oauth.requests, "post",
        lambda *a, **k: SimpleNamespace(status_code=400, json=lambda: {"error": "invalid_grant", "error_description": "Code expired"}, text=""),
    )
    with pytest.raises(notion_oauth.NotionOAuthError, match="Code expired"):
        notion_oauth.exchange_code("stale")


def test_complete_stores_the_token_for_the_state_user_with_workspace_metadata(monkeypatch):
    monkeypatch.setattr(
        notion_oauth, "exchange_code",
        lambda code: {"access_token": "ntn-token", "workspace_name": "Jack's Space", "workspace_id": "ws-1", "workspace_icon": "📚"},
    )
    status = notion_oauth.complete("code-1", notion_oauth.make_state("user-a"))
    assert status["configured"] and status["source"] == "user" and status["method"] == "oauth"
    assert status["meta"] == {"workspace_name": "Jack's Space", "workspace_icon": "📚"}
    assert status["oauth_available"] is True
    assert integrations.get_secret("notion", owner_id="user-a") == "ntn-token"
    assert integrations.get_secret("notion", owner_id="user-b") == ""
    # A pasted token replaces the OAuth one and is reported as such.
    integrations.set_secret("notion", "ntn-pasted", owner_id="user-a")
    assert integrations.status_for("notion", owner_id="user-a")["method"] == "token"


def test_callback_redirects_back_into_the_app(client, monkeypatch):
    denied = client.get("/integrations/notion/callback", params={"error": "access_denied", "error_description": "User cancelled"})
    assert denied.status_code == 302
    location = urlparse(denied.headers["location"])
    assert location.netloc == "127.0.0.1:5173" and location.path == "/app"
    assert parse_qs(location.query) == {"notion": ["error"], "detail": ["User cancelled"]}

    bad_state = client.get("/integrations/notion/callback", params={"code": "c", "state": "garbage"})
    assert parse_qs(urlparse(bad_state.headers["location"]).query)["notion"] == ["error"]

    monkeypatch.setattr(notion_oauth, "exchange_code", lambda code: {"access_token": "ntn-token", "workspace_name": "Jack's Space"})
    ok = client.get("/integrations/notion/callback", params={"code": "c", "state": notion_oauth.make_state(LOCAL_USER.id)})
    assert ok.status_code == 302
    assert parse_qs(urlparse(ok.headers["location"]).query) == {"notion": ["connected"]}
    assert integrations.get_secret("notion", owner_id=LOCAL_USER.id) == "ntn-token"

    # No token is needed on the callback itself: it is the redirect from Notion.
    assert "authorization" not in {k.lower() for k in ok.request.headers}


def test_authorize_and_database_routes(client, monkeypatch):
    url = client.get("/integrations/notion/authorize").json()["url"]
    assert notion_oauth.read_state(parse_qs(urlparse(url).query)["state"][0]) == LOCAL_USER.id

    status = {item["provider"]: item for item in client.get("/integrations").json()["integrations"]}
    assert status["notion"]["oauth_available"] is True
    assert status["github"].get("oauth_available") is None

    # Without a credential the request never leaves the server.
    assert client.get("/integrations/notion/databases").status_code == 400

    monkeypatch.setattr(
        notion, "_request",
        lambda method, path, json_body=None, timeout=30: {"results": [
            {"id": "db-1", "title": [{"plain_text": "Papers"}], "url": "https://notion.so/db-1"},
            {"id": "db-2", "title": [], "url": ""},
        ]},
    )
    integrations.set_secret("notion", "ntn-token", owner_id=LOCAL_USER.id)
    databases = client.get("/integrations/notion/databases").json()["databases"]
    assert databases == [
        {"database_id": "db-1", "title": "Papers", "url": "https://notion.so/db-1"},
        {"database_id": "db-2", "title": "Untitled database", "url": ""},
    ]

    monkeypatch.delenv("NOTION_CLIENT_ID")
    assert client.get("/integrations/notion/authorize").status_code == 503

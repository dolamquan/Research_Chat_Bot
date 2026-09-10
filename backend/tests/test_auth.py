"""Sign-in: Supabase tokens are verified locally, routes refuse everything else.

Tokens are minted with a locally generated P-256 key and the JWKS client is
stubbed to return its public half, so nothing here touches the network.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.auth import context, verifier
from app.auth.deps import user_from_claims
from app.storage import article_store

PROJECT = "https://proj.supabase.co"


@pytest.fixture(scope="module")
def keypair():
    private = ec.generate_private_key(ec.SECP256R1())
    return private, private.public_key()


@pytest.fixture
def supabase_mode(monkeypatch, keypair):
    monkeypatch.setenv("SUPABASE_URL", PROJECT)
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setattr(
        verifier,
        "_jwk_client",
        lambda: SimpleNamespace(get_signing_key_from_jwt=lambda token: SimpleNamespace(key=keypair[1])),
    )
    return keypair[0]


def mint(private, **overrides) -> str:
    claims = {
        "sub": "user-a",
        "aud": "authenticated",
        "iss": f"{PROJECT}/auth/v1",
        "exp": int(time.time()) + 600,
        "email": "a@example.com",
        "app_metadata": {"role": "user"},
        **overrides,
    }
    return jwt.encode(claims, private, algorithm="ES256", headers={"kid": "k1"})


@pytest.fixture(scope="module")
def client():
    from app.main import app

    return TestClient(app)


@pytest.fixture(autouse=True)
def stub_articles(monkeypatch):
    monkeypatch.setattr(article_store, "list_domains", lambda owner_id=context.UNSET: [{"domain": "research", "category": "nlp", "article_count": 1}])


def test_verify_token_accepts_a_valid_es256_token(supabase_mode):
    claims = verifier.verify_token(mint(supabase_mode))
    assert claims["sub"] == "user-a"


@pytest.mark.parametrize("bad", [
    {"aud": "anon"},
    {"iss": "https://other.supabase.co/auth/v1"},
    {"exp": int(time.time()) - 5},
])
def test_verify_token_rejects_wrong_audience_issuer_or_expiry(supabase_mode, bad):
    with pytest.raises(jwt.PyJWTError):
        verifier.verify_token(mint(supabase_mode, **bad))


def test_verify_token_requires_configuration(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    with pytest.raises(verifier.AuthNotConfigured):
        verifier.verify_token("x")


def test_role_comes_from_app_metadata_never_user_metadata():
    user = user_from_claims({"sub": "u", "email": "e", "app_metadata": {"role": "admin"}, "user_metadata": {"role": "user"}})
    assert user.is_admin
    user = user_from_claims({"sub": "u", "user_metadata": {"role": "admin"}})
    assert not user.is_admin and user.role == "user"


def test_routes_require_a_bearer_token(client, supabase_mode):
    assert client.get("/articles/domains").status_code == 401
    assert client.get("/articles/domains", headers={"Authorization": "Bearer nope"}).status_code == 401
    ok = client.get("/articles/domains", headers={"Authorization": f"Bearer {mint(supabase_mode)}"})
    assert ok.status_code == 200 and ok.json()["domains"][0]["domain"] == "research"


def test_health_and_auth_config_stay_public(client, supabase_mode):
    assert client.get("/health").status_code == 200
    config = client.get("/auth/config").json()
    assert config == {"mode": "supabase", "supabase_url": PROJECT}


def test_query_token_only_works_for_get(client, supabase_mode):
    token = mint(supabase_mode)
    assert client.get(f"/articles/domains?access_token={token}").status_code == 200
    assert client.post(f"/notes/search?access_token={token}", json={"query": "x"}).status_code == 401


def test_me_reports_identity_and_role(client, supabase_mode):
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {mint(supabase_mode)}"}).json()
    assert me["id"] == "user-a" and me["email"] == "a@example.com" and me["role"] == "user"
    assert me["claimed"] == {}


def test_admin_only_routes(client, supabase_mode, monkeypatch):
    from app.rag import vector_store
    from app.routes import articles as articles_routes

    monkeypatch.setattr(articles_routes, "set_article_visibility", lambda article_id, public, owner_id=None: {"article_id": article_id, "owner_id": None})
    monkeypatch.setattr(vector_store, "set_article_owner", lambda article_id, owner_id: None)

    user = {"Authorization": f"Bearer {mint(supabase_mode)}"}
    admin = {"Authorization": f"Bearer {mint(supabase_mode, sub='admin-1', app_metadata={'role': 'admin'})}"}
    assert client.post("/articles/a1/visibility", json={"public": True}, headers=user).status_code == 403
    assert client.post("/articles/a1/visibility", json={"public": True}, headers=admin).status_code == 200


def test_disabled_mode_acts_as_local_admin(client, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "disabled")
    assert client.get("/articles/domains").status_code == 200
    me = client.get("/auth/me").json()
    assert me["id"] == context.LOCAL_USER.id and me["role"] == "admin"


def test_agent_internal_calls_run_as_the_signed_in_user(client, supabase_mode):
    # execute_tool re-enters the app over ASGI; without forwarding the token
    # the inner request would be refused and surface as a 400.
    response = client.post(
        "/agent/tools/call",
        json={"name": "api.articles.get_domains", "arguments": {}},
        headers={"Authorization": f"Bearer {mint(supabase_mode)}"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["result"]["domains"][0]["domain"] == "research"

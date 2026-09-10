"""Verify Supabase access tokens against the project's public signing keys.

Supabase signs sessions with an asymmetric key (ES256 for this project) and
publishes the public half at `/auth/v1/.well-known/jwks.json`. Verifying
against that endpoint means no shared secret lives in this backend and key
rotation needs no redeploy: PyJWKClient refetches keys it has not seen.
"""
from __future__ import annotations

import os

import jwt
from jwt import PyJWKClient

ALGORITHMS = ["ES256", "RS256"]
AUDIENCE = "authenticated"
# Supabase's edge caches the JWKS for 10 minutes; caching longer here would
# keep trusting a revoked key past that window.
JWKS_CACHE_SECONDS = 600

_clients: dict[str, PyJWKClient] = {}


class AuthNotConfigured(RuntimeError):
    """SUPABASE_URL is missing while token verification is required."""


def supabase_url() -> str:
    return os.getenv("SUPABASE_URL", "").strip().rstrip("/")


def issuer() -> str:
    return f"{supabase_url()}/auth/v1"


def jwks_url() -> str:
    return f"{issuer()}/.well-known/jwks.json"


def _jwk_client() -> PyJWKClient:
    url = jwks_url()
    client = _clients.get(url)
    if client is None:
        client = PyJWKClient(url, cache_keys=True, lifespan=JWKS_CACHE_SECONDS)
        _clients[url] = client
    return client


def verify_token(token: str) -> dict:
    """Return the token's claims, or raise `jwt.PyJWTError` when it is not trustworthy."""
    if not supabase_url():
        raise AuthNotConfigured("SUPABASE_URL is not configured; set it or use AUTH_MODE=disabled for local development")
    signing_key = _jwk_client().get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=ALGORITHMS,
        audience=AUDIENCE,
        issuer=issuer(),
        options={"require": ["exp", "sub", "iss"]},
    )

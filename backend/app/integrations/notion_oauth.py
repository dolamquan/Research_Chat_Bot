"""Notion OAuth: a user approves Zoetrope inside Notion instead of pasting a token.

Zoetrope is registered once as a public Notion integration (NOTION_CLIENT_ID /
NOTION_CLIENT_SECRET). Each user is sent to Notion's consent screen, picks the
pages and databases to grant, and comes back through the callback with a code
that we exchange for an access token stored encrypted for that user. Notion
OAuth tokens do not expire, so there is no refresh flow.

The `state` round-trip is what ties the callback to a signed-in user: it is an
encrypted, time-limited envelope carrying the user id, so the callback needs
no bearer token (browsers do not send one on a redirect).
"""
from __future__ import annotations

import base64
import json
import os
import secrets
from typing import Any, Dict
from urllib.parse import urlencode

import requests
from cryptography.fernet import InvalidToken

from app.storage import integrations

AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize"
TOKEN_URL = "https://api.notion.com/v1/oauth/token"
DEFAULT_REDIRECT_URI = "http://localhost:8002/integrations/notion/callback"
DEFAULT_FRONTEND_URL = "http://127.0.0.1:5173"
STATE_TTL_SECONDS = 600


class NotionOAuthError(Exception):
    """Something in the consent round-trip failed; the message is safe to show the user."""


def client_id() -> str:
    return os.getenv("NOTION_CLIENT_ID", "").strip()


def client_secret() -> str:
    return os.getenv("NOTION_CLIENT_SECRET", "").strip()


def redirect_uri() -> str:
    return os.getenv("NOTION_REDIRECT_URI", "").strip() or DEFAULT_REDIRECT_URI


def frontend_url() -> str:
    return (os.getenv("FRONTEND_URL", "").strip() or DEFAULT_FRONTEND_URL).rstrip("/")


def is_configured() -> bool:
    return bool(client_id() and client_secret())


def make_state(user_id: str) -> str:
    payload = json.dumps({"sub": user_id, "nonce": secrets.token_urlsafe(8)})
    return integrations.cipher().encrypt(payload.encode("utf-8")).decode("ascii")


def read_state(state: str) -> str:
    """The user id a state was minted for; raises when expired or tampered with."""
    try:
        raw = integrations.cipher().decrypt(state.encode("ascii"), ttl=STATE_TTL_SECONDS)
        return str(json.loads(raw)["sub"])
    except (InvalidToken, ValueError, KeyError, UnicodeEncodeError) as exc:
        raise NotionOAuthError("The Notion sign-in link expired or was altered. Start again from Zoetrope.") from exc


def authorize_url(user_id: str) -> str:
    if not is_configured():
        raise NotionOAuthError(
            "Notion sign-in is not configured on this server (NOTION_CLIENT_ID / NOTION_CLIENT_SECRET)."
        )
    query = {
        "client_id": client_id(),
        "response_type": "code",
        "owner": "user",
        "redirect_uri": redirect_uri(),
        "state": make_state(user_id),
    }
    return f"{AUTHORIZE_URL}?{urlencode(query)}"


def exchange_code(code: str) -> Dict[str, Any]:
    """Trade the consent code for an access token. Never logs the secret or token."""
    basic = base64.b64encode(f"{client_id()}:{client_secret()}".encode("utf-8")).decode("ascii")
    try:
        response = requests.post(
            TOKEN_URL,
            headers={"Authorization": f"Basic {basic}", "Content-Type": "application/json"},
            json={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri()},
            timeout=30,
        )
    except requests.RequestException as exc:
        raise NotionOAuthError(f"Could not reach Notion to finish signing in: {exc}") from exc

    if response.status_code >= 400:
        try:
            body = response.json()
            detail = body.get("error_description") or body.get("error") or response.text[:300]
        except ValueError:
            detail = response.text[:300]
        raise NotionOAuthError(f"Notion refused the authorization: {detail}")

    data = response.json()
    if not data.get("access_token"):
        raise NotionOAuthError("Notion returned no access token.")
    return data


def complete(code: str, state: str) -> Dict[str, Any]:
    """Finish the round-trip: verify the state, exchange the code, store the token for that user."""
    user_id = read_state(state)
    data = exchange_code(code)
    meta = {
        "method": "oauth",
        "workspace_id": data.get("workspace_id"),
        "workspace_name": data.get("workspace_name"),
        "workspace_icon": data.get("workspace_icon"),
        "bot_id": data.get("bot_id"),
        "duplicated_template_id": data.get("duplicated_template_id"),
    }
    return integrations.set_secret("notion", data["access_token"], owner_id=user_id, meta=meta)


def redirect_target(status: str, detail: str = "") -> str:
    """Where the browser lands after the callback: back in the app, on the Notes view."""
    params: Dict[str, str] = {"notion": status}
    if detail:
        params["detail"] = detail[:200]
    return f"{frontend_url()}/app?{urlencode(params)}"

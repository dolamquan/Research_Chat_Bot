from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from app.auth.context import current_user
from app.integrations import notion_oauth
from app.integrations.notion import NotionError, search_databases
from app.storage import integrations

router = APIRouter(prefix="/integrations", tags=["integrations"])

# Notion redirects the user's browser here after consent. A redirect carries no
# bearer token, so this router is mounted without the sign-in dependency; the
# signed `state` parameter is what identifies the user.
public_router = APIRouter(prefix="/integrations", tags=["integrations"])


class SecretRequest(BaseModel):
    secret: str = Field(..., min_length=1, max_length=4000)


@router.get("")
def list_integrations() -> Dict[str, Any]:
    """Which external services the current user has credentials for. Never returns values."""
    return {"integrations": integrations.integration_status()}


@router.get("/notion/authorize")
def notion_authorize() -> Dict[str, Any]:
    """Where to send the browser so the user can approve Zoetrope in their Notion account."""
    user = current_user()
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in required.")
    try:
        return {"url": notion_oauth.authorize_url(user.id)}
    except notion_oauth.NotionOAuthError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/notion/databases")
def notion_databases() -> Dict[str, Any]:
    """Notion databases the current user's connection can reach (what they granted)."""
    try:
        return {"databases": search_databases()}
    except NotionError as exc:
        status = {"not_configured": 400, "unauthorized": 401, "rate_limited": 429}.get(exc.code, 502)
        raise HTTPException(status_code=status, detail=exc.message) from exc


@public_router.get("/notion/callback")
def notion_callback(
    code: str = "",
    state: str = "",
    error: str = "",
    error_description: str = "",
) -> RedirectResponse:
    """Finish Notion sign-in and send the browser back into the app."""
    if error:
        return RedirectResponse(notion_oauth.redirect_target("error", error_description or error), status_code=302)
    if not code or not state:
        return RedirectResponse(notion_oauth.redirect_target("error", "Notion did not return a code."), status_code=302)
    try:
        notion_oauth.complete(code, state)
    except (notion_oauth.NotionOAuthError, ValueError) as exc:
        return RedirectResponse(notion_oauth.redirect_target("error", str(exc)), status_code=302)
    return RedirectResponse(notion_oauth.redirect_target("connected"), status_code=302)


@router.put("/{provider}")
def set_integration_secret(provider: str, request: SecretRequest) -> Dict[str, Any]:
    """Store the current user's credential for a provider (encrypted at rest)."""
    try:
        return {"integration": integrations.set_secret(provider, request.secret)}
    except integrations.UnknownProvider as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/{provider}")
def delete_integration_secret(provider: str) -> Dict[str, Any]:
    """Forget the current user's credential for a provider (disconnect)."""
    try:
        removed = integrations.delete_secret(provider)
    except integrations.UnknownProvider as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "deleted" if removed else "not_configured", "integration": integrations.status_for(provider)}

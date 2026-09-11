"""FastAPI dependencies: resolve the caller, publish them to the request context."""
from __future__ import annotations

import os

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.context import LOCAL_USER, CurrentUser, set_current_user
from app.auth.verifier import AuthNotConfigured, verify_token

_bearer = HTTPBearer(auto_error=False)


def auth_mode() -> str:
    """`supabase` (default) verifies tokens; `disabled` acts as one local admin."""
    return os.getenv("AUTH_MODE", "supabase").strip().lower() or "supabase"


def user_from_claims(claims: dict, token: str = "") -> CurrentUser:
    # `app_metadata` is server-controlled; `user_metadata` is editable by the
    # user and must never drive authorization.
    app_metadata = claims.get("app_metadata") or {}
    role = str(app_metadata.get("role") or "user")
    return CurrentUser(id=str(claims["sub"]), email=str(claims.get("email") or ""), role=role, token=token)


def _extract_token(request: Request, credentials: HTTPAuthorizationCredentials | None) -> str:
    if credentials and credentials.scheme.lower() == "bearer" and credentials.credentials:
        return credentials.credentials
    # <img>, <iframe> and PDF viewers cannot set headers, so GET requests may
    # carry the same access token as a query parameter. It is still verified.
    if request.method == "GET":
        return request.query_params.get("access_token", "")
    return ""


class AuthError(Exception):
    """Token verification failed; `status` mirrors the HTTP code a route would return."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


async def authenticate_token(token: str) -> CurrentUser:
    """Resolve a bearer token to a user. Shared by HTTP routes and the assistant websocket."""
    if auth_mode() == "disabled":
        return LOCAL_USER
    if not token:
        raise AuthError(401, "Sign in required.")
    try:
        claims = await run_in_threadpool(verify_token, token)
    except AuthNotConfigured as exc:
        raise AuthError(503, str(exc)) from exc
    except jwt.PyJWTError as exc:
        raise AuthError(401, f"Invalid or expired session: {exc}") from exc
    return user_from_claims(claims, token)


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> CurrentUser:
    # This dependency is async on purpose: it runs in the request's own task,
    # so the context variable it sets is visible to the endpoint, to sync
    # code running in the threadpool, and to background tasks.
    try:
        user = await authenticate_token(_extract_token(request, credentials))
    except AuthError as exc:
        headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else None
        raise HTTPException(status_code=exc.status, detail=exc.detail, headers=headers) from exc
    request.state.user = user
    set_current_user(user)
    return user


async def require_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Administrator access required.")
    return user

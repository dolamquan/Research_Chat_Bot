"""Who is acting, made available to every layer without threading a parameter.

The request dependency sets the current user once per request; storage
modules, the MCP bridge and the agent read it from here. Storage functions
accept `owner_id=UNSET` meaning "the request's user" (the normal case),
`owner_id=None` meaning "no scoping" (scripts, migrations, admin tooling), or
an explicit id. This module imports nothing from FastAPI so storage code can
depend on it freely.
"""
from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass


@dataclass(frozen=True)
class CurrentUser:
    id: str
    email: str = ""
    role: str = "user"
    token: str = ""

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


# Development/test identity used when AUTH_MODE=disabled.
LOCAL_USER = CurrentUser(id="local-dev", email="local@zoetrope.dev", role="admin")

_current_user: ContextVar[CurrentUser | None] = ContextVar("zoetrope_current_user", default=None)


class _Unset:
    __slots__ = ()

    def __repr__(self) -> str:
        return "UNSET"


UNSET = _Unset()


def set_current_user(user: CurrentUser | None) -> Token:
    return _current_user.set(user)


def reset_current_user(token: Token) -> None:
    _current_user.reset(token)


def current_user() -> CurrentUser | None:
    return _current_user.get()


def current_owner_id() -> str | None:
    user = _current_user.get()
    return user.id if user else None


def request_token() -> str:
    user = _current_user.get()
    return user.token if user else ""


def resolve_owner(owner_id) -> str | None:
    """Translate a storage function's owner argument into a concrete filter value."""
    return current_owner_id() if owner_id is UNSET else owner_id

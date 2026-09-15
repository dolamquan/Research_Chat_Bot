"""Per-user credentials for external services (Notion, GitHub).

Secrets are encrypted at rest with a server-side key (`INTEGRATION_SECRET_KEY`,
or a key file generated next to the databases). Users only ever see whether a
credential is configured, never its value. The environment variables that used
to hold these keys remain the administrator's defaults and the fallback when no
user is acting (CLI scripts), so single-user setups keep working unchanged.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from cryptography.fernet import Fernet, InvalidToken

from app.auth.context import UNSET, current_user, resolve_owner
from app.storage import db

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DB_PATH = DATA_DIR / "researchmind.sqlite3"
KEY_PATH = DATA_DIR / "integration.key"

PROVIDERS: Dict[str, Dict[str, str]] = {
    "notion": {"label": "Notion", "env": "NOTION_API_KEY"},
    "github": {"label": "GitHub", "env": "GITHUB_TOKEN"},
}


class UnknownProvider(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect():
    return db.connect(DB_PATH, init_db)


def init_db(connection: db.Connection | None = None) -> None:
    if connection is None:
        with db.connect(DB_PATH) as conn:
            init_db(conn)
        return
    conn = connection
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_integrations (
            owner_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            secret TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (owner_id, provider)
        )
        """
    )
    # How the credential was obtained (oauth vs pasted token) and what it is
    # connected to (workspace name/icon) — shown to the user, never the secret.
    columns = db.table_columns(conn, "user_integrations")
    if "meta_json" not in columns:
        conn.execute("ALTER TABLE user_integrations ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'")
    conn.commit()


def cipher() -> Fernet:
    """The server-side cipher, also used to sign short-lived OAuth state envelopes."""
    return _fernet()


def _fernet() -> Fernet:
    key = os.getenv("INTEGRATION_SECRET_KEY", "").strip()
    if not key:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if KEY_PATH.exists():
            key = KEY_PATH.read_text(encoding="utf-8").strip()
        else:
            key = Fernet.generate_key().decode("ascii")
            KEY_PATH.write_text(key, encoding="utf-8")
    return Fernet(key.encode("ascii"))


def _check_provider(provider: str) -> str:
    if provider not in PROVIDERS:
        raise UnknownProvider(f"Unknown integration: {provider}. Known: {', '.join(PROVIDERS)}")
    return provider


def set_secret(
    provider: str,
    secret: str,
    owner_id: Any = UNSET,
    meta: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    _check_provider(provider)
    owner = resolve_owner(owner_id)
    if owner is None:
        raise ValueError("A signed-in user is required to store a credential")
    value = secret.strip()
    if not value:
        raise ValueError("The credential is empty")
    meta_json = json.dumps({"method": "token", **(meta or {})}, default=str)
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO user_integrations (owner_id, provider, secret, updated_at, meta_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_id, provider) DO UPDATE SET
                secret = excluded.secret, updated_at = excluded.updated_at, meta_json = excluded.meta_json
            """,
            (owner, provider, _fernet().encrypt(value.encode("utf-8")).decode("ascii"), _now(), meta_json),
        )
        conn.commit()
    return status_for(provider, owner_id=owner)


def delete_secret(provider: str, owner_id: Any = UNSET) -> bool:
    _check_provider(provider)
    owner = resolve_owner(owner_id)
    if owner is None:
        return False
    with _connect() as conn:
        deleted = conn.execute(
            "DELETE FROM user_integrations WHERE owner_id = ? AND provider = ?",
            (owner, provider),
        ).rowcount
        conn.commit()
    return deleted > 0


def _stored_row(provider: str, owner: str) -> tuple[str, Dict[str, Any]]:
    """(decrypted secret, metadata) for a user's stored credential; ('', {}) when none."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT secret, meta_json FROM user_integrations WHERE owner_id = ? AND provider = ?",
            (owner, provider),
        ).fetchone()
    if row is None:
        return "", {}
    try:
        meta = json.loads(row["meta_json"] or "{}")
    except (TypeError, ValueError):
        meta = {}
    try:
        return _fernet().decrypt(row["secret"].encode("ascii")).decode("utf-8"), meta
    except InvalidToken:
        # The server key changed; the stored value is unrecoverable and must be re-entered.
        return "", meta


def _stored_secret(provider: str, owner: str) -> str:
    return _stored_row(provider, owner)[0]


def _env_fallback_allowed(owner: str | None) -> bool:
    """CLI scripts (nobody acting) and administrators may use the server-wide key."""
    if owner is None:
        return True
    user = current_user()
    return bool(user and user.id == owner and user.is_admin)


def secret_source(provider: str, owner_id: Any = UNSET) -> str:
    """'user', 'environment' or '' — where the credential in effect comes from."""
    _check_provider(provider)
    owner = resolve_owner(owner_id)
    if owner is not None and _stored_secret(provider, owner):
        return "user"
    if _env_fallback_allowed(owner) and os.getenv(PROVIDERS[provider]["env"], "").strip():
        return "environment"
    return ""


def get_secret(provider: str, owner_id: Any = UNSET) -> str:
    """The credential the acting user may use for a provider, or '' when none."""
    _check_provider(provider)
    owner = resolve_owner(owner_id)
    if owner is not None:
        stored = _stored_secret(provider, owner)
        if stored:
            return stored
    if _env_fallback_allowed(owner):
        return os.getenv(PROVIDERS[provider]["env"], "").strip()
    return ""


def status_for(provider: str, owner_id: Any = UNSET) -> Dict[str, Any]:
    source = secret_source(provider, owner_id=owner_id)
    owner = resolve_owner(owner_id)
    meta = _stored_row(provider, owner)[1] if (source == "user" and owner is not None) else {}
    status: Dict[str, Any] = {
        "provider": provider,
        "label": PROVIDERS[provider]["label"],
        "configured": bool(source),
        "source": source or None,
        "method": (meta.get("method") or "token") if source == "user" else ("environment" if source else None),
        "meta": {key: meta.get(key) for key in ("workspace_name", "workspace_icon") if meta.get(key)},
    }
    if provider == "notion":
        from app.integrations import notion_oauth

        status["oauth_available"] = notion_oauth.is_configured()
    return status


def integration_status(owner_id: Any = UNSET) -> List[Dict[str, Any]]:
    return [status_for(provider, owner_id=owner_id) for provider in PROVIDERS]

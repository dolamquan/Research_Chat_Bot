from typing import Any, Dict

from fastapi import APIRouter, Depends

from app.auth.context import CurrentUser
from app.auth.deps import auth_mode, get_current_user
from app.auth.verifier import supabase_url
from app.rag import notes_index
from app.storage import agent_history, chat_history, notes, variant_store, visualization_store

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/config")
def get_auth_config() -> Dict[str, Any]:
    """Whether sign-in is required and which Supabase project issues sessions. Public."""
    return {"mode": auth_mode(), "supabase_url": supabase_url()}


def claim_legacy_rows(user: CurrentUser) -> Dict[str, int]:
    """Give pre-authentication data to the first administrator who signs in.

    Rows written before accounts existed have no owner. They belong to the
    person who ran the single-user app, so an admin adopts them. Idempotent:
    once claimed there is nothing left to adopt.
    """
    claimed = {
        **notes.claim_unowned(user.id),
        **chat_history.claim_unowned(user.id),
        **agent_history.claim_unowned(user.id),
        **visualization_store.claim_unowned(user.id),
        **variant_store.claim_unowned(user.id),
    }
    if claimed.get("notes"):
        notes_index.claim_unowned_safe(user.id)
    return claimed


@router.get("/me")
def get_me(user: CurrentUser = Depends(get_current_user)) -> Dict[str, Any]:
    """The signed-in user as the backend sees them."""
    claimed = claim_legacy_rows(user) if user.is_admin else {}
    return {"id": user.id, "email": user.email, "role": user.role, "claimed": claimed}

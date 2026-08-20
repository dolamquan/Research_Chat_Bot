from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.rag.diagram_mutator import ModificationPatch
from app.rag.variant_chat import discuss_change, discussion_history, reset_discussion
from app.rag.variant_lab import (
    apply_modification,
    delete_variant_tree,
    get_variant_detail,
    propose_modification,
    variant_tree,
    verify_target,
)
from app.storage.variant_store import (
    list_runs,
    list_variants_for_article,
    list_variants_for_visualization,
)


router = APIRouter(prefix="/variants", tags=["variants"])


def _fail(error: Exception) -> HTTPException:
    message = str(error)
    if isinstance(error, ValueError):
        status = 404 if "not found" in message.lower() else 422
        return HTTPException(status_code=status, detail=message)
    return HTTPException(status_code=502, detail=f"Variant operation failed: {message}")


class DiscussRequest(BaseModel):
    message: str = Field(min_length=2)


class ProposeRequest(BaseModel):
    target_id: str
    intent: str = Field(min_length=4)
    max_ops: int = Field(default=8, ge=1, le=12)


class ApplyRequest(BaseModel):
    target_id: str
    intent: str
    patch: ModificationPatch
    drop_op_indices: List[int] = Field(default_factory=list)


@router.post("/propose")
def propose(request: ProposeRequest) -> Dict[str, Any]:
    """Turn a natural-language modification into a reviewable patch."""
    try:
        return {"proposal": propose_modification(
            request.target_id, request.intent, request.max_ops
        )}
    except Exception as error:
        raise _fail(error) from error


@router.post("/apply")
def apply(request: ApplyRequest) -> Dict[str, Any]:
    """Create a persisted variant from an approved patch. No LLM call."""
    try:
        return apply_modification(
            request.target_id,
            request.intent,
            request.patch,
            request.drop_op_indices,
        )
    except Exception as error:
        raise _fail(error) from error


@router.get("/for-visualization/{viz_id}")
def for_visualization(viz_id: str) -> Dict[str, Any]:
    return {
        "variants": list_variants_for_visualization(viz_id),
        "tree": variant_tree(viz_id),
    }


@router.get("/by-article/{article_id}")
def by_article(article_id: str) -> Dict[str, Any]:
    return {"variants": list_variants_for_article(article_id)}


@router.get("/item/{variant_id}")
def item(variant_id: str) -> Dict[str, Any]:
    try:
        return get_variant_detail(variant_id)
    except Exception as error:
        raise _fail(error) from error


@router.post("/item/{target_id}/verify")
def verify(target_id: str) -> Dict[str, Any]:
    """Verify a variant, or an original diagram as a calibration control."""
    try:
        return verify_target(target_id)
    except Exception as error:
        raise _fail(error) from error


@router.get("/item/{target_id}/verifications")
def verifications(target_id: str, limit: int = 10) -> Dict[str, Any]:
    return {"runs": list_runs(target_id, limit=limit)}


@router.post("/item/{target_id}/chat")
def discuss(target_id: str, request: DiscussRequest) -> Dict[str, Any]:
    """Converse about a diagram or a modification made to it."""
    try:
        return discuss_change(target_id, request.message)
    except Exception as error:
        raise _fail(error) from error


@router.get("/item/{target_id}/chat")
def chat_history(target_id: str) -> Dict[str, Any]:
    return {"history": discussion_history(target_id)}


@router.delete("/item/{target_id}/chat")
def clear_chat(target_id: str) -> Dict[str, Any]:
    return {"status": "cleared", "removed": reset_discussion(target_id)}


@router.delete("/item/{variant_id}")
def delete(variant_id: str) -> Dict[str, Any]:
    try:
        deleted = delete_variant_tree(variant_id)
    except Exception as error:
        raise _fail(error) from error
    return {"status": "deleted", "deleted": deleted}

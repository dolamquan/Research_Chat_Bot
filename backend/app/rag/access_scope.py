"""Restrict Qdrant reads to what the current user may see.

Chunk payloads carry `owner_id` for privately ingested papers and nothing for
public ones, so "visible" is: owner matches, or the field is empty. Without a
signed-in user (scripts, evaluation) nothing is filtered.
"""
from __future__ import annotations

from qdrant_client.models import FieldCondition, Filter, IsEmptyCondition, MatchValue, PayloadField

from app.auth.context import current_owner_id

OWNER_KEY = "owner_id"


def visibility_condition(owner: str) -> Filter:
    return Filter(
        should=[
            FieldCondition(key=OWNER_KEY, match=MatchValue(value=owner)),
            IsEmptyCondition(is_empty=PayloadField(key=OWNER_KEY)),
        ]
    )


def owner_scope(base: Filter | None) -> Filter | None:
    """Add the current user's visibility to a filter; unchanged when no user is acting."""
    owner = current_owner_id()
    if owner is None:
        return base
    visibility = visibility_condition(owner)
    if base is None:
        return Filter(must=[visibility])
    must = list(base.must) if isinstance(base.must, list) else ([base.must] if base.must else [])
    return Filter(must=[*must, visibility], should=base.should, must_not=base.must_not)

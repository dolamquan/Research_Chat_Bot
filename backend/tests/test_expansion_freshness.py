"""The expansion-freshness predicate, and its convergence guarantee.

The predicate decides when a stored node expansion regenerates. Its two
callers must agree -- `_expansion_is_current` gates per-click regeneration
while `list_expanded_node_ids` feeds the UI's "prepared" state -- and a row
must never be permanently stale: that would re-run the full expansion on
every click, forever.

The composed-scene and schema-version cases that used to live here were
retired with the declarative theater: stored `scene` / `scene_graph` /
`scene_schema_version` keys are ignored by the predicate now.
"""

from __future__ import annotations

from typing import Any, Dict

from app.rag.paper_visualizer import _expansion_is_current, primitives_for_domain
from app.storage.visualization_store import expansion_content_is_current

GENERAL = set(primitives_for_domain("general"))


def content(**overrides: Any) -> Dict[str, Any]:
    """A stored expansion content dict matching the current schema."""
    base: Dict[str, Any] = {
        "process_steps": [
            {"primitive": "transport", "caption": "", "values": [0.1], "items": []}
        ],
        "stage_grounded": True,
    }
    base.update(overrides)
    return base


CASES = {
    "current row": (content(), True),
    "row predating process_steps": ({"substeps": []}, False),
    "row predating step values": (
        content(process_steps=[{"primitive": "transport", "caption": ""}]),
        False,
    ),
    "row predating stage grounding": (content(stage_grounded=False), False),
    # Rows written while the retired composer tiers existed still parse; their
    # legacy keys are simply ignored rather than forcing a regeneration.
    "row with retired composer keys": (
        content(
            scene={"title": "", "actors": [], "beats": [], "described": False},
            scene_graph=None,
            scene_schema_version=3,
        ),
        True,
    ),
}


def test_predicate_verdicts():
    for name, (payload, expected) in CASES.items():
        assert expansion_content_is_current(payload, GENERAL) is expected, name


def test_both_callers_agree_on_every_case():
    """The regeneration gate and the prepared-listing must never diverge."""
    for name, (payload, _) in CASES.items():
        gate = _expansion_is_current({"content": payload}, "general")
        listing = expansion_content_is_current(payload)
        # The listing skips the vocabulary check (it has no domain), so it may
        # only ever be MORE permissive -- never report unprepared what the
        # gate would accept.
        assert not (gate and not listing), name
        assert gate == listing, name  # holds while cases use general vocabulary


def test_vocabulary_check_only_applies_when_a_domain_is_known():
    row = content(
        process_steps=[
            {"primitive": "attention_links", "caption": "", "values": [], "items": []}
        ]
    )
    # attention_links is not in the general vocabulary...
    assert expansion_content_is_current(row, GENERAL) is False
    # ...but a caller without a domain skips the check rather than guessing.
    assert expansion_content_is_current(row) is True
    assert expansion_content_is_current(
        row, set(primitives_for_domain("computational"))
    ) is True

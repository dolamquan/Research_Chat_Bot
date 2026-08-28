"""The mechanism-scene vocabulary must be mirrored across four declaration sites.

A form or behaviour exists in: the backend Literal (what the schema accepts),
the backend help dict (what the model is told exists -- missing here means the
value is legal but never emitted), the frontend type union, and the frontend
renderer (the FORMS registry / the actorStateAt switch -- missing there is a
silent no-op, the switch has an ignore-unknown default). Drift between any two
fails silently in production, so it fails loudly here instead.

Modeled on test_no_code_generation's registry-parity tests, but with its own
path constants: SceneStage.tsx and types.ts live outside the visualization/
package that suite scans, and widening its constant would change what the
security tests cover.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.rag.scene_composer import (
    ACTOR_FORM_DATA,
    ACTOR_FORM_HELP,
    ActorForm,
    ActorTone,
    BEHAVIOR_HELP,
    BehaviorKind,
    Slot,
)

FRONTEND_APP = Path(__file__).resolve().parents[2] / "frontend" / "src" / "app"
TYPES_SRC = (FRONTEND_APP / "types.ts").read_text(encoding="utf-8")
STAGE_SRC = (FRONTEND_APP / "components" / "SceneStage.tsx").read_text(
    encoding="utf-8"
)


def ts_union(name: str) -> set:
    block = TYPES_SRC.split(f"export type {name} =", 1)[1].split(";", 1)[0]
    return set(re.findall(r'"(\w+)"', block))


def registry_keys(source: str, marker: str) -> set:
    block = source.split(marker, 1)[1].split("};", 1)[0]
    return set(re.findall(r"^\s{2}(\w+):", block, re.MULTILINE))


class TestActorForms:
    def test_help_covers_every_form(self):
        # A form absent from the help text is never described to the model:
        # legal in the schema, invisible in practice.
        assert set(ACTOR_FORM_HELP) == set(ActorForm.__args__)

    def test_data_guidance_covers_every_form(self):
        assert set(ACTOR_FORM_DATA) == set(ActorForm.__args__)

    def test_types_ts_mirrors_the_literal(self):
        assert ts_union("ActorForm") == set(ActorForm.__args__)

    def test_forms_registry_renders_every_form(self):
        # `FORMS[actor.form] ?? UnknownForm` renders drift as a wireframe, so
        # a missing entry is visible -- but it should still never happen.
        assert registry_keys(STAGE_SRC, "const FORMS:") == set(ActorForm.__args__)


class TestBehaviorKinds:
    def test_help_covers_every_kind(self):
        assert set(BEHAVIOR_HELP) == set(BehaviorKind.__args__)

    def test_types_ts_mirrors_the_literal(self):
        assert ts_union("BehaviorKind") == set(BehaviorKind.__args__)

    def test_the_state_switch_handles_every_kind(self):
        # `correspond` has an explicit no-op case (it renders relationally in
        # CorrespondenceLinks), so plain set equality holds. The switch's
        # `default` ignores unknowns; this test is what makes that safe.
        switch = STAGE_SRC.split("switch (beat.kind)", 1)[1]
        handled = set(re.findall(r'case "(\w+)":', switch))
        assert handled == set(BehaviorKind.__args__)


class TestTonesAndSlots:
    def test_types_ts_mirrors_tones_and_slots(self):
        assert ts_union("ActorTone") == set(ActorTone.__args__)
        assert ts_union("SceneSlot") == set(Slot.__args__)

    def test_renderer_tables_cover_tones_and_slots(self):
        assert registry_keys(STAGE_SRC, "const TONE_COLORS:") == set(
            ActorTone.__args__
        )
        assert registry_keys(STAGE_SRC, "const SLOT_POSITIONS:") == set(
            Slot.__args__
        )


class TestSceneGraphVocabulary:
    """The scene-graph tier has its own four-site mirror obligation."""

    GRAPH_SRC = (FRONTEND_APP / "components" / "SceneGraphStage.tsx").read_text(
        encoding="utf-8"
    )

    def test_help_covers_every_enum(self):
        from app.rag.scene_graph import (
            GEOMETRY_HELP,
            LAYOUT_HELP,
            TRACK_HELP,
            GeometryKind,
            LayoutKind,
            TrackProperty,
        )

        assert set(GEOMETRY_HELP) == set(GeometryKind.__args__)
        assert set(LAYOUT_HELP) == set(LayoutKind.__args__)
        assert set(TRACK_HELP) == set(TrackProperty.__args__)

    def test_types_ts_mirrors_the_literals(self):
        from app.rag.scene_graph import Easing, GeometryKind, LayoutKind, TrackProperty

        assert ts_union("GraphGeometry") == set(GeometryKind.__args__)
        assert ts_union("GraphLayout") == set(LayoutKind.__args__)
        assert ts_union("GraphTrackProp") == set(TrackProperty.__args__)
        assert ts_union("GraphEasing") == set(Easing.__args__)

    def test_interpreter_handles_every_geometry(self):
        from app.rag.scene_graph import GeometryKind

        switch = self.GRAPH_SRC.split("function UnitGeometry", 1)[1].split("}\n", 1)[0]
        handled = set(re.findall(r'case "(\w+)":', switch))
        assert handled == set(GeometryKind.__args__)

    def test_interpreter_handles_every_layout(self):
        from app.rag.scene_graph import LayoutKind

        body = self.GRAPH_SRC.split("export function instanceOffset", 1)[1].split(
            "\n}\n", 1
        )[0]
        handled = set(re.findall(r'case "(\w+)":', body))
        handled.add("single")  # early-returned before the switch
        assert handled == set(LayoutKind.__args__)


class TestAnchorTables:
    def test_every_form_has_units_anchors_and_extent(self):
        # The correspondence links and the form renderers read the same three
        # tables; a form missing from any of them falls back to blob geometry
        # and links land in the wrong place.
        for marker in ("const FORM_UNITS:", "const FORM_ANCHORS:", "const FORM_EXTENT:"):
            assert registry_keys(STAGE_SRC, marker) == set(ActorForm.__args__), marker

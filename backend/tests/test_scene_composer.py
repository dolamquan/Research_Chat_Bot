"""First coverage for the mechanism-scene composer.

These start as characterization tests: they pin `normalize_scene`'s behaviour
as it ships today, so the upcoming schema changes (actor `items`/`values`, the
`correspond` beat) cannot quietly alter how stored scenes are repaired. The
duration test documents a known operator-precedence quirk on purpose rather
than asserting the intended behaviour -- fixing it is a separate change.
"""

from __future__ import annotations

import pytest

from app.rag.scene_composer import (
    MAX_ACTORS,
    MAX_BEATS,
    MechanismScene,
    SceneActor,
    SceneBeat,
    compose_mechanism_scene,
    normalize_scene,
    scene_to_dict,
)


def make_actor(actor_id: str = "a1", **overrides) -> SceneActor:
    fields = {
        "actor_id": actor_id,
        "label": actor_id,
        "form": "particles",
        "tone": "primary",
        "count": 5,
        "at": "left",
        "note": "",
        "items": [],
        "values": [],
    }
    fields.update(overrides)
    return SceneActor(**fields)


def make_beat(actor_id: str = "a1", **overrides) -> SceneBeat:
    fields = {
        "start": 0.1,
        "duration": 0.3,
        "kind": "enter",
        "actor_id": actor_id,
        "target_id": "",
        "to": "same",
        "magnitude": 1.0,
        "caption": "",
        "weights": [],
    }
    fields.update(overrides)
    return SceneBeat(**fields)


def make_scene(actors, beats, described: bool = True) -> MechanismScene:
    return MechanismScene(
        title="t",
        summary="s",
        actors=actors,
        beats=beats,
        evidence="",
        described=described,
    )


class TestNormalizeScene:
    def test_caps_the_cast_at_max_actors(self):
        scene = make_scene([make_actor(f"a{i}") for i in range(9)], [])
        assert len(normalize_scene(scene).actors) == MAX_ACTORS

    def test_clamps_count_into_range(self):
        scene = make_scene(
            [make_actor("a1", count=0), make_actor("a2", count=400)], []
        )
        normalized = normalize_scene(scene)
        assert normalized.actors[0].count == 1
        assert normalized.actors[1].count == 40

    def test_drops_beats_for_unknown_actors(self):
        scene = make_scene([make_actor("a1")], [make_beat("ghost")])
        assert normalize_scene(scene).beats == []

    def test_blanks_dangling_target_ids(self):
        scene = make_scene(
            [make_actor("a1")], [make_beat("a1", target_id="ghost")]
        )
        assert normalize_scene(scene).beats[0].target_id == ""

    def test_keeps_valid_target_ids(self):
        scene = make_scene(
            [make_actor("a1"), make_actor("a2")],
            [make_beat("a1", kind="bind", target_id="a2")],
        )
        assert normalize_scene(scene).beats[0].target_id == "a2"

    def test_clamps_start_and_magnitude(self):
        scene = make_scene(
            [make_actor("a1")], [make_beat("a1", start=3.0, magnitude=-2.0)]
        )
        beat = normalize_scene(scene).beats[0]
        # start clamps to 1.0, then retiming shifts a late-opening timeline
        # forward: a lone beat at the very end becomes the scene's opener.
        assert beat.start == pytest.approx(0.05)
        assert beat.magnitude == 0.0

    def test_duration_is_clamped_to_the_remaining_timeline(self):
        scene = make_scene(
            [make_actor("a1")],
            [
                make_beat("a1", start=0.4, duration=0.9),
                make_beat("a1", start=0.0, duration=2.0),
                make_beat("a1", start=1.0, duration=0.5),
            ],
        )
        beats = normalize_scene(scene).beats  # sorted by start
        assert beats[0].start == 0.0
        assert beats[0].duration == 1.0
        assert beats[1].start == 0.4
        assert beats[1].duration == 0.6
        # A beat at start=1.0 would play for a single invisible instant, so
        # retiming pulls it to 0.85 and floors its duration at 0.15.
        assert beats[2].start == 0.85
        assert beats[2].duration == 0.15

    def test_a_late_opening_timeline_is_shifted_forward(self):
        scene = make_scene(
            [make_actor("a1")],
            [
                make_beat("a1", start=0.5, duration=0.3),
                make_beat("a1", start=0.9, duration=0.1),
            ],
        )
        beats = normalize_scene(scene).beats
        assert beats[0].start == pytest.approx(0.05)  # earliest opens the scene
        assert beats[1].start == pytest.approx(0.45)  # relative spacing kept
        assert all(beat.duration >= 0.15 for beat in beats)

    def test_an_early_opening_timeline_is_not_shifted(self):
        scene = make_scene(
            [make_actor("a1")],
            [make_beat("a1", start=0.1, duration=0.4)],
        )
        assert normalize_scene(scene).beats[0].start == 0.1

    def test_an_all_neutral_cast_gets_distinct_tones(self):
        scene = make_scene(
            [make_actor(f"a{i}", tone="neutral") for i in range(3)], []
        )
        tones = [actor.tone for actor in normalize_scene(scene).actors]
        assert "neutral" not in tones
        assert len(set(tones)) == 3

    def test_deliberate_tone_choices_are_left_alone(self):
        scene = make_scene(
            [make_actor("a1", tone="signal"), make_actor("a2", tone="neutral")],
            [],
        )
        tones = [actor.tone for actor in normalize_scene(scene).actors]
        assert tones == ["signal", "neutral"]

    def test_caps_beats_at_max_beats(self):
        scene = make_scene(
            [make_actor("a1")], [make_beat("a1") for _ in range(12)]
        )
        assert len(normalize_scene(scene).beats) == MAX_BEATS

    def test_sorts_beats_by_start(self):
        scene = make_scene(
            [make_actor("a1")],
            [make_beat("a1", start=0.8), make_beat("a1", start=0.2)],
        )
        starts = [b.start for b in normalize_scene(scene).beats]
        assert starts == sorted(starts)

    def test_empty_cast_is_marked_undescribed(self):
        scene = make_scene([], [], described=True)
        assert normalize_scene(scene).described is False


class TestComposeMechanismScene:
    def test_returns_the_normalized_structured_scene(self, stub_chat_model):
        raw = make_scene(
            [make_actor("a1", count=99)],
            [make_beat("a1"), make_beat("ghost")],
        )
        stub = stub_chat_model(structured=raw)
        scene = compose_mechanism_scene(
            stage_label="Input Embeddings",
            stage_detail="maps tokens to vectors",
            algorithm_name="Transformer",
            domain="computational",
            context="Each token is mapped to a vector.",
            llm=stub,
        )
        assert scene.actors[0].count == 40
        assert len(scene.beats) == 1

    def test_prompt_carries_stage_and_vocabulary(self, stub_chat_model):
        stub = stub_chat_model(structured=make_scene([make_actor()], []))
        compose_mechanism_scene(
            stage_label="Input Embeddings",
            stage_detail="maps tokens to vectors",
            algorithm_name="Transformer",
            domain="computational",
            context="excerpt text",
            llm=stub,
        )
        prompt = stub.prompts[0]
        assert "STAGE: Input Embeddings" in prompt
        assert "particles" in prompt  # the form menu made it in
        assert "PAPER EXCERPTS:\nexcerpt text" in prompt


class TestNewFieldClamping:
    def test_filters_non_finite_actor_values_and_caps_length(self):
        scene = make_scene(
            [
                make_actor(
                    "a1",
                    values=[0.5, float("nan"), float("inf"), -1.25] + [0.1] * 20,
                )
            ],
            [],
        )
        values = normalize_scene(scene).actors[0].values
        assert float("nan") not in values
        assert all(abs(v) < float("inf") for v in values)
        assert len(values) <= 16
        assert values[0] == 0.5 and values[1] == -1.25

    def test_strips_and_caps_actor_items(self):
        scene = make_scene(
            [make_actor("a1", items=["  the ", "", "x" * 60, "cat", "sat", "on", "mat", "extra"])],
            [],
        )
        items = normalize_scene(scene).actors[0].items
        assert len(items) <= 6
        assert items[0] == "the"
        assert all(len(item) <= 24 for item in items)
        assert "" not in items

    def test_clamps_beat_weights_into_unit_range(self):
        scene = make_scene(
            [make_actor("a1"), make_actor("a2")],
            [
                make_beat(
                    "a1",
                    kind="correspond",
                    target_id="a2",
                    weights=[2.0, -0.5, 0.7, float("nan")],
                )
            ],
        )
        weights = normalize_scene(scene).beats[0].weights
        assert weights == [1.0, 0.0, 0.7]

    def test_drops_correspond_beats_without_a_target(self):
        scene = make_scene(
            [make_actor("a1")],
            [make_beat("a1", kind="correspond", target_id="")],
        )
        assert normalize_scene(scene).beats == []

    def test_drops_correspond_beats_whose_target_is_unknown(self):
        scene = make_scene(
            [make_actor("a1")],
            [make_beat("a1", kind="correspond", target_id="ghost")],
        )
        assert normalize_scene(scene).beats == []


class TestStageDataBlock:
    def test_empty_without_data(self):
        from app.rag.scene_composer import _stage_data_block

        assert _stage_data_block(None, None) == ""
        assert _stage_data_block([], {}) == ""
        assert (
            _stage_data_block(
                [{"caption": "no data here", "items": [], "values": []}], {}
            )
            == ""
        )

    def test_quotes_tokens_and_values_verbatim(self):
        from app.rag.scene_composer import _stage_data_block

        block = _stage_data_block(
            [
                {
                    "caption": "Each token becomes a vector",
                    "items": ["the", "cat"],
                    "values": [0.42, -0.13],
                }
            ],
            {"input_text": "The cat sat", "tokens": ["the", "cat", "sat"]},
        )
        assert "the, cat, sat" in block
        assert "0.42" in block and "-0.13" in block
        assert "Each token becomes a vector" in block


class TestSeeding:
    def test_seeds_items_when_exactly_one_actor_matches(self, stub_chat_model):
        raw = make_scene(
            [make_actor("a1", count=3), make_actor("a2", form="blob", count=1)],
            [],
        )
        stub = stub_chat_model(structured=raw)
        scene = compose_mechanism_scene(
            stage_label="s",
            stage_detail="d",
            algorithm_name="A",
            domain="computational",
            context="c",
            worked_example={"tokens": ["the", "cat", "sat"]},
            llm=stub,
        )
        assert scene.actors[0].items == ["the", "cat", "sat"]
        assert scene.actors[1].items == []

    def test_does_nothing_when_two_actors_match(self, stub_chat_model):
        raw = make_scene(
            [make_actor("a1", count=3), make_actor("a2", count=3)], []
        )
        stub = stub_chat_model(structured=raw)
        scene = compose_mechanism_scene(
            stage_label="s",
            stage_detail="d",
            algorithm_name="A",
            domain="computational",
            context="c",
            worked_example={"tokens": ["the", "cat", "sat"]},
            llm=stub,
        )
        assert scene.actors[0].items == []
        assert scene.actors[1].items == []

    def test_never_seeds_values(self, stub_chat_model):
        raw = make_scene([make_actor("a1", count=2)], [])
        stub = stub_chat_model(structured=raw)
        scene = compose_mechanism_scene(
            stage_label="s",
            stage_detail="d",
            algorithm_name="A",
            domain="computational",
            context="c",
            process_steps=[
                {"caption": "x", "items": [], "values": [0.9, 0.1]}
            ],
            worked_example={"tokens": ["a", "b"]},
            llm=stub,
        )
        assert scene.actors[0].values == []


def test_compose_puts_the_extracted_data_in_the_prompt(stub_chat_model):
    stub = stub_chat_model(structured=make_scene([make_actor()], []))
    compose_mechanism_scene(
        stage_label="Input Embeddings",
        stage_detail="maps tokens to vectors",
        algorithm_name="Transformer",
        domain="computational",
        context="excerpt text",
        process_steps=[
            {
                "caption": "Each token is mapped to a vector",
                "items": ["the", "cat"],
                "values": [0.42, -0.13],
            }
        ],
        worked_example={"tokens": ["the", "cat", "sat"]},
        llm=stub,
    )
    prompt = stub.prompts[0]
    assert "the, cat, sat" in prompt
    assert "0.42" in prompt
    assert prompt.index("EXTRACTED FOR THIS STAGE") < prompt.index("PAPER EXCERPTS")


def test_scene_round_trips_through_scene_to_dict():
    scene = make_scene(
        [make_actor("a1"), make_actor("a2")],
        [make_beat("a1", kind="bind", target_id="a2")],
    )
    payload = scene_to_dict(normalize_scene(scene))
    again = MechanismScene(**payload)
    assert scene_to_dict(again) == payload

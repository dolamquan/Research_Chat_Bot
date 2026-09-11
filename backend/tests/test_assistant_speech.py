"""Spoken lines, streamed-token gating and yes/no classification."""

from __future__ import annotations

from app.agents.assistant.confirmations import PendingActions, classify_reply, explicit_guard
from app.agents.assistant.speech import SpeakGate, speakable, split_spoken


def test_split_spoken_takes_the_trailing_marker_line_only():
    body, spoken = split_spoken("I opened **Graph RAG** at page 4.\n\nSPEAK: I opened Graph RAG at page four.")
    assert body == "I opened **Graph RAG** at page 4."
    assert spoken == "I opened Graph RAG at page four."


def test_split_spoken_ignores_markers_inside_the_body():
    text = "```\nSPEAK: not this\n```\nDone."
    assert split_spoken(text) == (text, "")
    assert split_spoken("") == ("", "")


def test_spoken_line_never_contains_markdown_or_the_wake_word():
    _, spoken = split_spoken("x\nSPEAK: **Zoetrope** found [a paper](http://x) about $E=mc^2$.")
    assert "*" not in spoken and "http" not in spoken and "$" not in spoken
    assert "zoetrope" not in spoken.lower()


def test_speakable_strips_tables_code_mermaid_and_links():
    markdown = (
        "# Results\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n"
        "Graph RAG links [concepts](http://x) across papers [1] p.3. It improves recall. A third sentence here."
    )
    spoken = speakable(markdown)
    assert spoken == "Graph RAG links concepts across papers. It improves recall."
    assert speakable("") == ""


def test_speakable_truncates_long_first_sentences_on_a_word_boundary():
    spoken = speakable("word " * 100, limit=60)
    assert len(spoken) <= 60 and spoken.endswith("…") and not spoken.endswith(" …")


def test_speak_gate_forwards_text_but_never_the_marker():
    gate = SpeakGate()
    pieces = ["I opened", " the paper.", "\n", "SPE", "AK: I", " opened it."]
    forwarded = "".join(gate.feed(piece) for piece in pieces) + gate.flush()
    assert forwarded == "I opened the paper."
    assert gate.text.endswith("SPEAK: I opened it.")


def test_speak_gate_releases_a_newline_that_was_not_a_marker():
    gate = SpeakGate()
    out = gate.feed("Line one\n") + gate.feed("Line two") + gate.flush()
    assert out == "Line one\nLine two"


def test_classify_reply_handles_short_utterances_only():
    assert classify_reply("yes") == "yes"
    assert classify_reply("Yes, go ahead.") == "yes"
    assert classify_reply("go ahead") == "yes"
    assert classify_reply("no thanks") == "no"
    assert classify_reply("never mind") == "no"
    assert classify_reply("yes but first search for graph papers") is None
    assert classify_reply("open the library") is None
    assert classify_reply("") is None


def test_explicit_guard_parks_risky_calls_and_lets_reads_through():
    store = PendingActions(ttl=60)
    guard = explicit_guard(store, "s1")
    assert guard({"name": "app.papers", "effect": "read"}, {}) is None
    refused = guard({"name": "api.notes.delete_note", "effect": "destructive", "description": "Delete a note [DELETE /notes/{note_id}]"},
                    {"path": {"note_id": "n1"}})
    assert refused["requires_confirmation"] is True
    pending = store.get("s1")
    assert pending is not None and pending.tool == "api.notes.delete_note"
    assert "note_id=n1" in pending.summary and "Delete a note" in pending.summary
    # A second, different risky call while one is parked is refused without replacing it.
    other = guard({"name": "notion.create_research_page", "effect": "external_write"}, {"title": "x"})
    assert "already waiting" in other["error"]
    assert store.pop("s1").id == pending.id
    assert store.get("s1") is None

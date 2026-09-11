"""Turning a Markdown answer into something a voice can say.

The model ends every assistant answer with one line `SPEAK: ...`. That line is
split off and sent to the browser's speech synthesis; the rest is rendered.
When the model forgets, `speakable` derives a short spoken line from the
Markdown deterministically so the assistant never falls silent.
"""
from __future__ import annotations

import re
from typing import Tuple

SPEAK_MARKER = "SPEAK:"
DEFAULT_SPOKEN_LIMIT = 220
# The wake word must never come out of the speaker, or the assistant wakes itself.
_SELF_NAME = re.compile(r"\b(?:zoetrope|zoe)\b", re.IGNORECASE)

_FENCE = re.compile(r"```.*?```", re.DOTALL)
_MATH_BLOCK = re.compile(r"\$\$.*?\$\$", re.DOTALL)
_MATH_INLINE = re.compile(r"\$[^$\n]+\$")
_TABLE_LINE = re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE)
# Headings are labels, not sentences: drop the whole line from speech.
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s.*$", re.MULTILINE)
_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.MULTILINE)
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_URL = re.compile(r"https?://\S+")
_CITATION = re.compile(r"\[\d+(?:,\s*\d+)*\](?:\s*p\.\s*\d+)?")
_EMPHASIS = re.compile(r"(\*\*|__|\*|_|`|~~)")
_HTML = re.compile(r"<[^>]+>")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def split_spoken(answer: str) -> Tuple[str, str]:
    """Return (markdown_without_marker, spoken_line). Both empty-safe.

    Only a line that *starts* with the marker and sits at the end of the
    answer counts, so a stray "SPEAK:" inside a code block is left alone.
    """
    text = (answer or "").rstrip()
    if not text:
        return "", ""
    lines = text.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        line = lines[index].strip()
        if not line:
            continue
        if line.upper().startswith(SPEAK_MARKER):
            spoken = line[len(SPEAK_MARKER):].strip()
            body = "\n".join(lines[:index]).rstrip()
            return body, sanitize_spoken(spoken)
        break
    return text, ""


def strip_markdown(markdown: str) -> str:
    text = markdown or ""
    text = _FENCE.sub(" ", text)
    text = _MATH_BLOCK.sub(" ", text)
    text = _MATH_INLINE.sub(" ", text)
    text = _TABLE_LINE.sub(" ", text)
    text = _IMAGE.sub(" ", text)
    text = _LINK.sub(r"\1", text)
    text = _URL.sub(" ", text)
    text = _HTML.sub(" ", text)
    text = _HEADING.sub("", text)
    text = _BULLET.sub("", text)
    text = _CITATION.sub("", text)
    text = _EMPHASIS.sub("", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s*\n\s*", " ", text)
    text = re.sub(r"\s+([.,;:!?])", r"\1", text)
    return text.strip()


def sanitize_spoken(text: str) -> str:
    """Never speak Markdown or the wake word."""
    clean = strip_markdown(text)
    clean = _SELF_NAME.sub("I", clean)
    clean = re.sub(r"\bI am I\b", "I am here", clean)
    return re.sub(r"\s+", " ", clean).strip()


def speakable(markdown: str, limit: int = DEFAULT_SPOKEN_LIMIT, sentences: int = 2) -> str:
    """The first sentence or two of an answer, as plain speech."""
    text = sanitize_spoken(markdown)
    if not text:
        return ""
    parts = [p.strip() for p in _SENTENCE_END.split(text) if p.strip()]
    spoken = ""
    for part in parts[:sentences]:
        candidate = f"{spoken} {part}".strip()
        if spoken and len(candidate) > limit:
            break
        spoken = candidate
    if len(spoken) > limit:
        cut = spoken[: limit - 1]
        cut = cut[: cut.rfind(" ")] if " " in cut else cut
        spoken = cut.rstrip(",;:- ") + "…"
    return spoken


class SpeakGate:
    """Forwards streamed answer text until the SPEAK: line begins.

    Tokens arrive in arbitrary splits, so the gate keeps the tail of the
    stream back until it can tell whether it is the start of the marker.
    """

    def __init__(self) -> None:
        self.text = ""
        self._sent = 0
        self.closed = False

    def feed(self, delta: str) -> str:
        if not delta:
            return ""
        self.text += delta
        if self.closed:
            return ""
        marker_at = self._marker_position()
        if marker_at is not None:
            self.closed = True
            out = self.text[self._sent:marker_at]
            self._sent = marker_at
            return out
        # Hold back any suffix that could still grow into "\nSPEAK:".
        hold = self._possible_marker_suffix()
        end = len(self.text) - hold
        out = self.text[self._sent:end] if end > self._sent else ""
        self._sent = max(self._sent, end)
        return out

    def flush(self) -> str:
        if self.closed:
            return ""
        out = self.text[self._sent:]
        self._sent = len(self.text)
        return out

    def _marker_position(self) -> int | None:
        upper = self.text.upper()
        if upper.startswith(SPEAK_MARKER):
            return 0
        found = upper.find("\n" + SPEAK_MARKER)
        return found if found >= 0 else None

    def _possible_marker_suffix(self) -> int:
        """Length of a trailing fragment that could still grow into the marker."""
        upper = self.text.upper()
        full = "\n" + SPEAK_MARKER
        for length in range(len(full) - 1, 0, -1):  # "\n", "\nS", ... "\nSPEAK"
            if upper.endswith(full[:length]):
                return length
        if len(upper) < len(SPEAK_MARKER) and SPEAK_MARKER.startswith(upper):
            return len(upper)  # the whole stream so far might be the marker's start
        return 0

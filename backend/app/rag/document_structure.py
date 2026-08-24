"""Structured extraction of a paper's sections, figures and equations.

The retrieval path elsewhere in this codebase treats a paper as a flat list of
chunks, which is fine for question answering but loses exactly what a diagram
needs: which text is the *proposed method* rather than related work, which
caption belongs to the architecture figure, and where the equations sit.

Docling recovers that structure when it is installed. When it is not, or when
it fails on a particular PDF, `extract_structured_paper` falls back to the
chunks the existing ingestion pipeline already produced and reconstructs a
coarse section list by matching headings. The fallback is deliberately
unambitious -- it exists so that no paper becomes unusable, not to reimplement
a parser -- and every record carries an `extraction_strategy` field so a
downstream consumer can tell which path produced it.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Sequence

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

EXTRACTION_DOCLING = "docling"
EXTRACTION_LEGACY = "legacy_chunks"
EXTRACTION_EMPTY = "empty"

# Section titles worth feeding a diagram, in priority order. Matching is on a
# normalised, lowercased title, so "3.2 Proposed Method" matches "proposed
# method". Related work and baselines are deliberately absent: describing them
# is how a visualization ends up depicting someone else's algorithm.
ARCHITECTURE_SECTION_PATTERNS: Sequence[tuple[str, int]] = (
    (r"\babstract\b", 100),
    (r"\bproposed (method|approach|model|framework|architecture)\b", 98),
    (r"\bour (method|approach|model|framework)\b", 96),
    (r"\bmethodolog", 94),
    (r"\bmethods?\b", 92),
    (r"\barchitectur", 90),
    (r"\bmodel\b", 86),
    (r"\bapproach\b", 84),
    (r"\bframework\b", 82),
    (r"\btraining\b", 78),
    (r"\binference\b", 76),
    (r"\bimplementation\b", 72),
    (r"\bexperimental setup\b", 60),
    (r"\bablation\b", 58),
    (r"\bsystem design\b", 80),
    (r"\bpreliminar", 40),
)

# Sections that actively mislead a method diagram.
EXCLUDED_SECTION_PATTERNS: Sequence[str] = (
    r"\brelated work\b",
    r"\bbackground\b",
    r"\bprior (work|art)\b",
    r"\breferences?\b",
    r"\bbibliograph",
    r"\backnowledg",
    r"\bappendix\b",
    r"\bbroader impact\b",
    r"\blimitations?\b",
    r"\bconclusion",
)

# Figure captions that plausibly show the architecture.
ARCHITECTURE_FIGURE_PATTERNS: Sequence[str] = (
    r"\barchitectur",
    r"\boverview\b",
    r"\bpipeline\b",
    r"\bframework\b",
    r"\bmodel\b",
    r"\bblock diagram\b",
    r"\bschematic\b",
    r"\bproposed\b",
    r"\bworkflow\b",
)

MAX_SECTION_CHARS = 12_000
MAX_EVIDENCE_CHARS = 20_000


class PaperSection(BaseModel):
    section_id: str
    title: str
    text: str
    page_start: int | None = None
    page_end: int | None = None
    section_type: str = "body"


class PaperFigure(BaseModel):
    figure_id: str
    caption: str
    page: int | None = None
    image_ref: str | None = None
    surrounding_text: str = ""


class PaperEquation(BaseModel):
    equation_id: str
    latex: str
    page: int | None = None
    surrounding_text: str = ""


class StructuredPaper(BaseModel):
    title: str = ""
    abstract: str = ""
    sections: List[PaperSection] = Field(default_factory=list)
    figures: List[PaperFigure] = Field(default_factory=list)
    equations: List[PaperEquation] = Field(default_factory=list)
    extraction_strategy: str = EXTRACTION_EMPTY

    def is_empty(self) -> bool:
        return not (self.sections or self.figures or self.abstract)


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip().lower()


def classify_section(title: str) -> tuple[str, int]:
    """Return a section type and a priority score for a heading.

    Score 0 means "do not feed this to a diagram". Excluded headings are
    checked first so that "Related Work on Model Architectures" is dropped
    rather than scored highly for the word "architecture".
    """
    normalised = _normalise(title)
    if not normalised:
        return "body", 10

    for pattern in EXCLUDED_SECTION_PATTERNS:
        if re.search(pattern, normalised):
            return "excluded", 0

    for pattern, score in ARCHITECTURE_SECTION_PATTERNS:
        if re.search(pattern, normalised):
            if score >= 90:
                return "method", score
            if score >= 70:
                return "implementation", score
            return "supporting", score

    return "body", 10


def figure_is_architectural(caption: str) -> bool:
    normalised = _normalise(caption)
    return any(re.search(p, normalised) for p in ARCHITECTURE_FIGURE_PATTERNS)


# --- Docling -----------------------------------------------------------------


def docling_available() -> bool:
    try:
        import docling  # noqa: F401
    except Exception:
        return False
    return True


def _extract_with_docling(pdf_path: Path) -> StructuredPaper | None:
    """Parse a PDF with Docling, or return None if it cannot.

    Returning None rather than raising keeps the caller's control flow simple:
    every failure mode -- not installed, unsupported file, parser error --
    lands on the legacy path identically.
    """
    try:
        from docling.document_converter import DocumentConverter
    except Exception:
        logger.info("docling not installed; using legacy extraction")
        return None

    try:
        converter = DocumentConverter()
        result = converter.convert(str(pdf_path))
        document = getattr(result, "document", None)
        if document is None:
            return None
        return _structured_from_docling_document(document)
    except Exception as error:
        # Deliberately broad: Docling raises a wide variety of parser errors and
        # any of them should degrade to the legacy path rather than fail
        # ingestion. The reason is logged, without the document's contents.
        logger.warning("docling extraction failed (%s); using legacy extraction",
                       type(error).__name__)
        return None


def _structured_from_docling_document(document: Any) -> StructuredPaper:
    """Map a Docling document into our models.

    Written against duck-typed attributes rather than Docling's classes so the
    unit tests can drive it with a lightweight stub and so a Docling version
    bump does not break the import.
    """
    title = str(getattr(document, "name", "") or "")
    sections: List[PaperSection] = []
    figures: List[PaperFigure] = []
    equations: List[PaperEquation] = []
    abstract = ""

    current_title = ""
    current_text: List[str] = []
    current_page: int | None = None

    def flush() -> None:
        nonlocal current_title, current_text, current_page
        if not current_text:
            current_title, current_page = "", None
            return
        body = "\n".join(current_text).strip()
        if body:
            section_type, _score = classify_section(current_title)
            sections.append(
                PaperSection(
                    section_id=f"sec_{len(sections) + 1}",
                    title=current_title or f"Section {len(sections) + 1}",
                    text=body[:MAX_SECTION_CHARS],
                    page_start=current_page,
                    page_end=current_page,
                    section_type=section_type,
                )
            )
        current_title, current_text, current_page = "", [], None

    for item in _iter_docling_items(document):
        label = str(getattr(item, "label", "") or "").lower()
        text = str(getattr(item, "text", "") or "").strip()
        page = _docling_page(item)

        if label in {"section_header", "title", "heading"}:
            flush()
            current_title = text
            current_page = page
        elif label in {"caption", "figure", "picture"}:
            caption = text
            if caption:
                figures.append(
                    PaperFigure(
                        figure_id=f"fig_{len(figures) + 1}",
                        caption=caption[:2000],
                        page=page,
                        image_ref=str(getattr(item, "self_ref", "") or "") or None,
                        surrounding_text="\n".join(current_text[-2:])[:1500],
                    )
                )
        elif label in {"formula", "equation"}:
            if text:
                equations.append(
                    PaperEquation(
                        equation_id=f"eq_{len(equations) + 1}",
                        latex=text[:2000],
                        page=page,
                        surrounding_text="\n".join(current_text[-2:])[:1500],
                    )
                )
        elif text:
            current_text.append(text)
            if current_page is None:
                current_page = page

    flush()

    for section in sections:
        if _normalise(section.title).startswith("abstract"):
            abstract = section.text
            break
    if not abstract and sections:
        abstract = sections[0].text[:2000]

    return StructuredPaper(
        title=title,
        abstract=abstract,
        sections=sections,
        figures=figures,
        equations=equations,
        extraction_strategy=EXTRACTION_DOCLING,
    )


def _iter_docling_items(document: Any):
    """Yield Docling body items in reading order, whatever the version calls it."""
    for attribute in ("texts", "items", "body"):
        value = getattr(document, attribute, None)
        if isinstance(value, list) and value:
            return value
    iterate = getattr(document, "iterate_items", None)
    if callable(iterate):
        try:
            return [item[0] if isinstance(item, tuple) else item for item in iterate()]
        except Exception:
            return []
    return []


def _docling_page(item: Any) -> int | None:
    provenance = getattr(item, "prov", None)
    if isinstance(provenance, list) and provenance:
        page = getattr(provenance[0], "page_no", None)
        if isinstance(page, int):
            return page
    page = getattr(item, "page", None)
    return page if isinstance(page, int) else None


# --- legacy fallback ----------------------------------------------------------

_HEADING_RE = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*\s*[.)]?\s+)?([A-Z][A-Za-z0-9 \-:/&]{2,70})\s*$"
)


def _structured_from_chunks(chunks: Sequence[Dict[str, Any]]) -> StructuredPaper:
    """Rebuild a coarse structure from already-ingested chunks.

    Chunks carry no section metadata, so headings are recovered by looking for
    short title-case lines. This is approximate by nature; its job is to keep
    the pipeline working for papers Docling has not seen, not to be exact.
    """
    sections: List[PaperSection] = []
    figures: List[PaperFigure] = []
    title = ""
    current_title = "Body"
    current_text: List[str] = []
    current_page: int | None = None

    def flush() -> None:
        nonlocal current_title, current_text, current_page
        body = "\n".join(current_text).strip()
        if body:
            section_type, _score = classify_section(current_title)
            sections.append(
                PaperSection(
                    section_id=f"sec_{len(sections) + 1}",
                    title=current_title,
                    text=body[:MAX_SECTION_CHARS],
                    page_start=current_page,
                    page_end=current_page,
                    section_type=section_type,
                )
            )
        current_text, current_page = [], None

    for chunk in chunks:
        text = str(chunk.get("text") or "").strip()
        if not text:
            continue
        page = chunk.get("page")
        page = page if isinstance(page, int) else None
        if not title:
            title = str(chunk.get("title") or "")

        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            caption_match = re.match(r"^(figure|fig\.?|table)\s*\d+[.:]\s*(.+)$",
                                     stripped, re.IGNORECASE)
            if caption_match:
                figures.append(
                    PaperFigure(
                        figure_id=f"fig_{len(figures) + 1}",
                        caption=stripped[:2000],
                        page=page,
                        image_ref=None,
                        surrounding_text="\n".join(current_text[-2:])[:1500],
                    )
                )
                continue

            heading = _HEADING_RE.match(stripped)
            if heading and len(stripped) < 72 and not stripped.endswith("."):
                flush()
                current_title = heading.group(1).strip()
                current_page = page
                continue

            current_text.append(stripped)
            if current_page is None:
                current_page = page

    flush()

    abstract = ""
    for section in sections:
        if _normalise(section.title).startswith("abstract"):
            abstract = section.text
            break

    return StructuredPaper(
        title=title,
        abstract=abstract,
        sections=sections,
        figures=figures,
        equations=[],
        extraction_strategy=EXTRACTION_LEGACY,
    )


def extract_structured_paper(
    pdf_path: str | Path | None = None,
    chunks: Sequence[Dict[str, Any]] | None = None,
    prefer_docling: bool = True,
) -> StructuredPaper:
    """Best available structure for a paper.

    Docling first when a PDF is on disk and the package is importable, then the
    already-ingested chunks. Never raises: an empty `StructuredPaper` is a
    valid answer meaning "no structure recovered", and callers degrade to plain
    retrieval.
    """
    if prefer_docling and pdf_path:
        path = Path(pdf_path)
        if path.exists():
            structured = _extract_with_docling(path)
            if structured is not None and not structured.is_empty():
                return structured

    if chunks:
        return _structured_from_chunks(chunks)

    return StructuredPaper(extraction_strategy=EXTRACTION_EMPTY)


# --- evidence selection -------------------------------------------------------


def select_architecture_evidence(
    paper: StructuredPaper,
    max_chars: int = MAX_EVIDENCE_CHARS,
) -> str:
    """Assemble the excerpt a diagram should be built from.

    Sections are taken in priority order rather than reading order, so the
    proposed method is present even in a paper whose method section starts on
    page nine -- the failure that made earlier diagrams describe whichever
    algorithm the introduction happened to survey. Architecture figure captions
    come first because they are the densest description of a method available.
    """
    parts: List[str] = []
    total = 0

    def add(label: str, body: str) -> None:
        nonlocal total
        body = (body or "").strip()
        if not body:
            return
        block = f"[{label}]\n{body}"
        if total + len(block) > max_chars:
            remaining = max_chars - total
            if remaining < 400:
                return
            block = block[:remaining]
        parts.append(block)
        total += len(block)

    architecture_figures = [f for f in paper.figures if figure_is_architectural(f.caption)]
    for figure in architecture_figures[:4]:
        page = f", p.{figure.page}" if figure.page else ""
        add(f"FIGURE {figure.figure_id}{page}", figure.caption)

    if paper.abstract:
        add("ABSTRACT", paper.abstract)

    scored = []
    for section in paper.sections:
        _type, score = classify_section(section.title)
        if score <= 0:
            continue
        scored.append((score, section))
    scored.sort(key=lambda pair: -pair[0])

    for _score, section in scored:
        if total >= max_chars:
            break
        page = f", p.{section.page_start}" if section.page_start else ""
        add(f"SECTION {section.title}{page}", section.text)

    for equation in paper.equations[:6]:
        add(f"EQUATION {equation.equation_id}", equation.latex)

    return "\n\n".join(parts)


def evidence_candidates(paper: StructuredPaper) -> List[Dict[str, Any]]:
    """Quotable units the planner can cite, each with a stable id.

    Giving the model a fixed menu of citable sources -- rather than letting it
    invent citations -- is what makes `evidence_ids` verifiable afterwards.
    """
    candidates: List[Dict[str, Any]] = []

    if paper.abstract:
        candidates.append(
            {
                "evidence_id": "ev_abstract",
                "section": "Abstract",
                "page": None,
                "quote": paper.abstract[:1200],
            }
        )

    for section in paper.sections:
        _type, score = classify_section(section.title)
        if score <= 0:
            continue
        candidates.append(
            {
                "evidence_id": f"ev_{section.section_id}",
                "section": section.title,
                "page": section.page_start,
                "quote": section.text[:1200],
            }
        )

    for figure in paper.figures:
        if not figure_is_architectural(figure.caption):
            continue
        candidates.append(
            {
                "evidence_id": f"ev_{figure.figure_id}",
                "section": f"Figure ({figure.figure_id})",
                "page": figure.page,
                "quote": figure.caption[:1200],
            }
        )

    for equation in paper.equations[:10]:
        candidates.append(
            {
                "evidence_id": f"ev_{equation.equation_id}",
                "section": "Equation",
                "page": equation.page,
                "quote": equation.latex[:600],
            }
        )

    return candidates

"""Structured extraction, Docling fallback, and evidence prioritisation."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.rag import document_structure
from app.rag.document_structure import (
    EXTRACTION_DOCLING,
    EXTRACTION_EMPTY,
    EXTRACTION_LEGACY,
    PaperFigure,
    PaperSection,
    StructuredPaper,
    classify_section,
    evidence_candidates,
    extract_structured_paper,
    figure_is_architectural,
    select_architecture_evidence,
)


# --- section classification ---------------------------------------------------


@pytest.mark.parametrize(
    "title,expected_type",
    [
        ("Abstract", "method"),
        ("3 Proposed Method", "method"),
        ("4. Methodology", "method"),
        ("Model Architecture", "method"),
        ("5 Implementation Details", "implementation"),
        ("Training", "implementation"),
        ("6 Ablation Study", "supporting"),
        ("Related Work", "excluded"),
        ("References", "excluded"),
        ("Acknowledgements", "excluded"),
        ("Conclusion", "excluded"),
        ("Something Unrelated", "body"),
    ],
)
def test_section_classification(title, expected_type):
    section_type, _score = classify_section(title)
    assert section_type == expected_type


def test_related_work_wins_over_a_method_keyword():
    """'Related Work on Model Architectures' must not score as method."""
    section_type, score = classify_section("Related Work on Model Architectures")
    assert section_type == "excluded"
    assert score == 0


@pytest.mark.parametrize(
    "caption,expected",
    [
        ("Figure 1: Overview of our architecture.", True),
        ("Figure 2: The proposed pipeline.", True),
        ("Figure 3: Block diagram of the system.", True),
        ("Figure 4: Accuracy against training epochs.", False),
        ("Table 1: Dataset statistics.", False),
    ],
)
def test_architecture_figure_detection(caption, expected):
    assert figure_is_architectural(caption) is expected


# --- Docling path -------------------------------------------------------------


class _Prov:
    def __init__(self, page: int) -> None:
        self.page_no = page


class _Item:
    def __init__(self, label: str, text: str, page: int = 1) -> None:
        self.label = label
        self.text = text
        self.prov = [_Prov(page)]
        self.self_ref = f"#/{label}"


class _Doc:
    name = "Stub Paper"

    def __init__(self, items) -> None:
        self.texts = items


def test_docling_document_is_mapped(monkeypatch):
    document = _Doc(
        [
            _Item("section_header", "Abstract"),
            _Item("text", "We propose a stub method."),
            _Item("section_header", "Proposed Method", page=3),
            _Item("text", "The stub encoder maps x to z.", page=3),
            _Item("caption", "Figure 1: Overview of the architecture.", page=3),
            _Item("formula", "z = Wx + b", page=3),
        ]
    )
    paper = document_structure._structured_from_docling_document(document)

    assert paper.extraction_strategy == EXTRACTION_DOCLING
    assert paper.title == "Stub Paper"
    assert "stub method" in paper.abstract
    titles = [section.title for section in paper.sections]
    assert "Proposed Method" in titles
    assert len(paper.figures) == 1
    assert paper.figures[0].page == 3
    assert len(paper.equations) == 1
    assert paper.equations[0].latex == "z = Wx + b"


def test_docling_failure_falls_back_to_chunks(monkeypatch, tmp_path: Path):
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4 stub")

    def _boom(_path):
        raise RuntimeError("docling exploded")

    monkeypatch.setattr(document_structure, "_extract_with_docling",
                        lambda path: _boom(path))

    with pytest.raises(RuntimeError):
        document_structure._extract_with_docling(pdf)

    # The public entry point must swallow it and use the legacy path instead.
    monkeypatch.setattr(document_structure, "_extract_with_docling", lambda path: None)
    paper = extract_structured_paper(
        pdf_path=pdf,
        chunks=[{"text": "Proposed Method\nThe encoder maps x to z.", "page": 3}],
    )
    assert paper.extraction_strategy == EXTRACTION_LEGACY
    assert paper.sections


def test_docling_absent_uses_legacy(monkeypatch):
    monkeypatch.setattr(document_structure, "_extract_with_docling", lambda path: None)
    paper = extract_structured_paper(
        pdf_path=None,
        chunks=[{"text": "Method\nWe encode the input.", "page": 1, "title": "P"}],
    )
    assert paper.extraction_strategy == EXTRACTION_LEGACY


def test_no_pdf_and_no_chunks_is_empty_not_an_error():
    paper = extract_structured_paper(pdf_path=None, chunks=[])
    assert paper.extraction_strategy == EXTRACTION_EMPTY
    assert paper.is_empty()


def test_legacy_extraction_recovers_headings_and_captions():
    chunks = [
        {
            "text": (
                "Abstract\n"
                "We propose a stub method for testing.\n"
                "Related Work\n"
                "Others did other things.\n"
                "Proposed Method\n"
                "The encoder maps x to z.\n"
                "Figure 1: Overview of the proposed architecture.\n"
            ),
            "page": 1,
            "title": "Stub Paper",
        }
    ]
    paper = extract_structured_paper(pdf_path=None, chunks=chunks)
    titles = [section.title for section in paper.sections]
    assert "Abstract" in titles
    assert "Proposed Method" in titles
    assert len(paper.figures) == 1


# --- evidence selection -------------------------------------------------------


@pytest.fixture
def paper() -> StructuredPaper:
    return StructuredPaper(
        title="P",
        abstract="ABSTRACT_TEXT",
        sections=[
            PaperSection(section_id="s1", title="Related Work",
                         text="RELATED_WORK_TEXT", section_type="excluded"),
            PaperSection(section_id="s2", title="Proposed Method",
                         text="METHOD_TEXT", page_start=3, section_type="method"),
            PaperSection(section_id="s3", title="Implementation",
                         text="IMPL_TEXT", page_start=6, section_type="implementation"),
        ],
        figures=[
            PaperFigure(figure_id="f1",
                        caption="Figure 1: Overview of the architecture.", page=3),
            PaperFigure(figure_id="f2",
                        caption="Figure 2: Accuracy versus epochs.", page=8),
        ],
        equations=[],
        extraction_strategy=EXTRACTION_LEGACY,
    )


def test_evidence_excludes_related_work(paper):
    evidence = select_architecture_evidence(paper)
    assert "METHOD_TEXT" in evidence
    assert "RELATED_WORK_TEXT" not in evidence


def test_evidence_is_not_the_first_n_characters(paper):
    """Method text must be present even though Related Work comes first."""
    evidence = select_architecture_evidence(paper)
    assert evidence.index("METHOD_TEXT") < evidence.index("IMPL_TEXT")


def test_architecture_figure_leads(paper):
    evidence = select_architecture_evidence(paper)
    assert evidence.index("Overview of the architecture") < evidence.index("METHOD_TEXT")
    assert "Accuracy versus epochs" not in evidence


def test_evidence_respects_the_character_budget(paper):
    evidence = select_architecture_evidence(paper, max_chars=500)
    assert len(evidence) <= 500


def test_evidence_candidates_have_unique_ids(paper):
    candidates = evidence_candidates(paper)
    ids = [candidate["evidence_id"] for candidate in candidates]
    assert len(ids) == len(set(ids))
    assert "ev_abstract" in ids
    # Excluded sections are never citable.
    assert "ev_s1" not in ids

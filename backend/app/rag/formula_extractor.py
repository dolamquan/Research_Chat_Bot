import base64
import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List

import fitz
from dotenv import load_dotenv
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from langsmith import traceable


UPLOAD_FOLDER = Path(__file__).resolve().parents[1] / "data" / "uploaded_docs"
VISION_MODEL = "gpt-4o-mini"
DEFAULT_FORMULA_PAGE_LIMIT = 40

FORMULA_SYMBOL_PATTERN = re.compile(r"[=+*/∑∏√≤≥≈≠→←↔∞∫∂∆∇±×÷∈∉⊂⊆∪∩α-ωΑ-Ω]")
FORMULA_RELATION_PATTERN = re.compile(r"[=≤≥≈≠→←↔∈∉⊂⊆]")
FORMULA_WORD_PATTERN = re.compile(
    r"\b(argmax|argmin|softmax|log|ln|exp|sim|score|loss|rank|ppr|pr|tf|idf)\b",
    re.IGNORECASE,
)
EQUATION_LABEL_PATTERN = re.compile(r"^\(?\d+\)?$")
JSON_BLOCK_PATTERN = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)


def _resolve_pdf_path(document_source: str) -> Path | None:
    source_name = Path(document_source).name
    if not source_name:
        return None

    candidate = (UPLOAD_FOLDER / source_name).resolve()
    upload_root = UPLOAD_FOLDER.resolve()

    try:
        candidate.relative_to(upload_root)
    except ValueError:
        return None

    if candidate.exists() and candidate.suffix.lower() == ".pdf":
        return candidate

    return None


def _get_llm_text(response: Any) -> str:
    return str(getattr(response, "content", response)).strip()


def _normalize_line(text: str) -> str:
    text = text.replace("\x00", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _page_png_data_url(page: fitz.Page, zoom: float = 1.75) -> str:
    matrix = fitz.Matrix(zoom, zoom)
    pixmap = page.get_pixmap(matrix=matrix, alpha=False)
    encoded = base64.b64encode(pixmap.tobytes("png")).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


def _strip_json_fence(text: str) -> str:
    match = JSON_BLOCK_PATTERN.search(text.strip())
    return match.group(1).strip() if match else text.strip()


def _parse_formula_json(text: str) -> List[Dict[str, Any]]:
    try:
        data = json.loads(_strip_json_fence(text))
    except Exception:
        return []

    if isinstance(data, dict):
        formulas = data.get("formulas")
    else:
        formulas = data

    if not isinstance(formulas, list):
        return []

    parsed: List[Dict[str, Any]] = []
    for item in formulas:
        if not isinstance(item, dict):
            continue

        latex = str(item.get("latex") or "").strip()
        if not latex:
            continue

        parsed.append(
            {
                "title": str(item.get("title") or "Formula").strip(),
                "latex": latex.strip("$ \n"),
                "equation_number": str(item.get("equation_number") or "").strip(),
                "explanation": str(item.get("explanation") or "").strip(),
                "definitions": [
                    str(definition).strip()
                    for definition in item.get("definitions", [])
                    if str(definition).strip()
                ][:4],
            }
        )

    return parsed


def _formula_page_prompt(page_number: int, document_title: str) -> str:
    return f"""
You are extracting equations from a research paper page image.

Return JSON only, with this shape:
{{
  "formulas": [
    {{
      "title": "short descriptive heading",
      "equation_number": "1",
      "latex": "valid KaTeX-compatible LaTeX without surrounding dollar signs",
      "explanation": "one concise sentence explaining what the equation represents",
      "definitions": ["optional short symbol definition", "optional short symbol definition"]
    }}
  ]
}}

Rules:
- Extract only important displayed equations or numbered equations visible on the page.
- Prefer numbered equations. Include unnumbered equations only if they are central and displayed.
- Do not include prose, references, table text, section numbers, or inline fragments.
- Use KaTeX-compatible LaTeX. Use \\operatorname{{...}} for multi-letter names.
- If there are no important displayed equations, return {{"formulas": []}}.
- Do not invent definitions that are not visible or directly implied.

Document: {document_title}
Page: {page_number}
""".strip()


def _extract_page_formulas_with_vision(
    page: fitz.Page,
    *,
    page_number: int,
    document_title: str,
    llm: Any,
) -> List[Dict[str, Any]]:
    message = HumanMessage(
        content=[
            {"type": "text", "text": _formula_page_prompt(page_number, document_title)},
            {
                "type": "image_url",
                "image_url": {
                    "url": _page_png_data_url(page),
                    "detail": "high",
                },
            },
        ]
    )
    response = llm.invoke([message])
    formulas = _parse_formula_json(_get_llm_text(response))

    for index, formula in enumerate(formulas):
        formula.update(
            {
                "id": f"formula-vision:{document_title}:{page_number}:{index}",
                "source": document_title,
                "page": page_number,
                "text": formula["latex"],
                "document_type": "formula",
                "section_type": "equation",
                "topic": "math formula",
                "extraction_method": "vision",
            }
        )

    return formulas


def _formula_score(line: str) -> int:
    if len(line) < 2:
        return 0

    stripped = line.strip()
    lowered = stripped.lower()
    if "http://" in lowered or "https://" in lowered or "www." in lowered:
        return 0

    alpha_count = sum(character.isalpha() for character in stripped)
    digit_count = sum(character.isdigit() for character in stripped)
    symbol_count = len(FORMULA_SYMBOL_PATTERN.findall(stripped))
    relation_count = len(FORMULA_RELATION_PATTERN.findall(stripped))
    operator_count = len(re.findall(r"(?<!\w)[=+*/](?!\w)|[≤≥≈≠→←↔]", stripped))
    bracket_count = sum(stripped.count(character) for character in "()[]{}")
    score = symbol_count + relation_count * 4 + operator_count * 2 + min(bracket_count, 4)

    if FORMULA_WORD_PATTERN.search(stripped):
        score += 2
    if EQUATION_LABEL_PATTERN.match(stripped):
        score += 2
    if digit_count and symbol_count:
        score += 2
    if len(stripped) <= 120 and symbol_count >= 2:
        score += 2
    if len(stripped) > 220:
        score -= 3
    if alpha_count > 120 and relation_count == 0:
        score -= 3
    if stripped.endswith("-") and relation_count == 0:
        score -= 4
    if relation_count == 0 and symbol_count < 2:
        score -= 5

    return score


def _looks_like_formula(line: str) -> bool:
    score = _formula_score(line)
    if score >= 7:
        return True

    compact = line.replace(" ", "")
    return bool(
        len(compact) <= 160
        and re.search(r"[A-Za-z0-9)][=≈≤≥∈]", compact)
        and FORMULA_SYMBOL_PATTERN.search(compact)
    )


def _looks_like_formula_continuation(line: str) -> bool:
    stripped = line.strip()
    if not stripped or len(stripped) > 100:
        return False

    if _formula_score(stripped) >= 4:
        return True

    compact = stripped.replace(" ", "")
    if EQUATION_LABEL_PATTERN.match(compact):
        return True

    if len(compact) <= 30 and re.search(r"[A-Za-z0-9α-ωΑ-Ω]", compact):
        return True

    return False


def _line_blocks(page: fitz.Page) -> List[str]:
    return [
        normalized
        for line in page.get_text("text").splitlines()
        if (normalized := _normalize_line(line))
    ]


def _merge_formula_lines(lines: List[str]) -> List[str]:
    formulas: List[str] = []
    index = 0

    while index < len(lines):
        line = lines[index]
        if not _looks_like_formula(line):
            index += 1
            continue

        group = [line]
        index += 1

        while index < len(lines) and len(group) < 10:
            next_line = lines[index]
            if not _looks_like_formula_continuation(next_line):
                break
            group.append(next_line)
            index += 1

        formula = "\n".join(group).strip()
        if formula and formula not in formulas:
            formulas.append(formula)

    return formulas


def _context_for_formula(lines: List[str], formula: str) -> str:
    first_line = formula.splitlines()[0]
    try:
        index = lines.index(first_line)
    except ValueError:
        return ""

    before = " ".join(lines[max(0, index - 2):index])
    after = " ".join(lines[index + len(formula.splitlines()):index + len(formula.splitlines()) + 2])
    return _normalize_line(f"{before} {after}")[:500]


@traceable(name="extract_document_formulas", run_type="tool")
def extract_document_formulas(
    document_source: str,
    *,
    limit: int = 30,
) -> List[Dict[str, Any]]:
    pdf_path = _resolve_pdf_path(document_source)
    if pdf_path is None:
        return []

    formulas: List[Dict[str, Any]] = []

    with fitz.open(pdf_path) as document:
        for page_index, page in enumerate(document):
            lines = _line_blocks(page)
            for formula in _merge_formula_lines(lines):
                formulas.append(
                    {
                        "id": f"formula:{pdf_path.name}:{page_index + 1}:{len(formulas)}",
                        "source": pdf_path.name,
                        "title": pdf_path.stem.replace("_", " "),
                        "page": page_index + 1,
                        "text": formula,
                        "context": _context_for_formula(lines, formula),
                        "document_type": "formula",
                        "section_type": "equation",
                        "topic": "math formula",
                    }
                )

                if len(formulas) >= limit:
                    return formulas

    return formulas


@traceable(name="extract_document_formula_report", run_type="tool")
def extract_document_formula_report(
    document_source: str,
    *,
    llm: Any = None,
    page_limit: int = DEFAULT_FORMULA_PAGE_LIMIT,
) -> Dict[str, Any]:
    pdf_path = _resolve_pdf_path(document_source)
    if pdf_path is None:
        return {
            "answer": (
                f"I could not find `{Path(document_source).name}` in the uploaded PDF library."
            ),
            "sources": [],
        }

    load_dotenv()
    if llm is None:
        llm = ChatOpenAI(model=VISION_MODEL, temperature=0)

    started_at = time.perf_counter()
    formulas: List[Dict[str, Any]] = []
    document_title = pdf_path.stem.replace("_", " ")

    with fitz.open(pdf_path) as document:
        total_pages = len(document)
        pages_to_scan = min(total_pages, page_limit)
        for page_index in range(pages_to_scan):
            page = document[page_index]
            try:
                formulas.extend(
                    _extract_page_formulas_with_vision(
                        page,
                        page_number=page_index + 1,
                        document_title=document_title,
                        llm=llm,
                    )
                )
            except Exception:
                continue

    if not formulas:
        fallback = extract_document_formulas(document_source, limit=20)
        return {
            "answer": format_formula_answer(fallback, document_source),
            "sources": fallback,
        }

    elapsed_seconds = max(1, round(time.perf_counter() - started_at))
    return {
        "answer": format_formula_report(
            formulas=formulas,
            document_source=document_source,
            elapsed_seconds=elapsed_seconds,
            scanned_page_count=pages_to_scan,
        ),
        "sources": formulas,
    }


def _format_elapsed(seconds: int) -> str:
    minutes, remaining_seconds = divmod(seconds, 60)
    if minutes and remaining_seconds:
        return f"{minutes}m {remaining_seconds}s"
    if minutes:
        return f"{minutes}m"
    return f"{remaining_seconds}s"


def format_formula_report(
    *,
    formulas: List[Dict[str, Any]],
    document_source: str,
    elapsed_seconds: int,
    scanned_page_count: int,
) -> str:
    filename = Path(document_source).name
    title = Path(document_source).stem.replace("_", " ")
    lines = [
        f"Worked for {_format_elapsed(elapsed_seconds)}",
        "",
        "# All rendered formulas in the paper",
        "",
        f"Extracted and cleanly rendered from *{title}*.",
        "",
        f"`{filename}`",
        "",
    ]

    for index, formula in enumerate(formulas, start=1):
        heading = str(formula.get("title") or "Formula").strip()
        equation_number = str(formula.get("equation_number") or "").strip()
        page = formula.get("page")
        explanation = str(formula.get("explanation") or "").strip()
        definitions = formula.get("definitions") or []
        latex = str(formula.get("latex") or formula.get("text") or "").strip().strip("$")

        lines.append(f"## {index}. {heading}")
        lines.append("")
        lines.append("$$")
        lines.append(latex)
        lines.append("$$")
        if equation_number:
            lines.append("")
            lines.append(f"Equation ({equation_number}), p.{page}")
        elif page:
            lines.append("")
            lines.append(f"p.{page}")
        if explanation:
            lines.append("")
            lines.append(explanation)
        if definitions:
            lines.append("")
            lines.append("Where:")
            for definition in definitions:
                lines.append(f"- {definition}")
        lines.append("")
        lines.append("---")
        lines.append("")

    lines.append(
        f"Scanned {scanned_page_count} page{'s' if scanned_page_count != 1 else ''} for displayed equations."
    )

    return "\n".join(lines).strip()


def format_formula_answer(formulas: List[Dict[str, Any]], document_source: str) -> str:
    if not formulas:
        return (
            f"I could not extract formula-like math from `{Path(document_source).name}`. "
            "This can happen when the PDF stores equations as images or the text extraction "
            "splits symbols too aggressively."
        )

    lines = [
        f"I found {len(formulas)} formula-like passages in `{Path(document_source).name}`:",
    ]

    for index, formula in enumerate(formulas, start=1):
        context = str(formula.get("context") or "").strip()
        lines.append(
            "\n".join(
                [
                    f"{index}. p.{formula.get('page')}",
                    "```text",
                    str(formula.get("text") or "").strip(),
                    "```",
                    f"Context: {context}" if context else "",
                ]
            ).strip()
        )

    return "\n\n".join(lines)

import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlparse

import requests

from app.rag.metadata import build_article_metadata
from app.rag.vector_store import index_pdf
from app.storage.article_store import upsert_article


UPLOAD_FOLDER = Path(__file__).resolve().parents[1] / "data" / "uploaded_docs"
REQUEST_TIMEOUT_SECONDS = 60
ARXIV_API_URL = "https://export.arxiv.org/api/query"
ATOM_NAMESPACE = {"atom": "http://www.w3.org/2005/Atom"}


def _normalize_tags(tags: List[str] | None) -> List[str]:
    normalized: List[str] = []

    for tag in tags or []:
        value = str(tag).strip().lower()
        if value and value not in normalized:
            normalized.append(value)

    return normalized


def _clean_text(text: str | None) -> str:
    return " ".join((text or "").split())


def _arxiv_id_from_url(url: str) -> str | None:
    match = re.search(r"arxiv\.org/(?:abs|pdf)/([^/?#]+)", url)
    if not match:
        return None

    return match.group(1).removesuffix(".pdf")


def _pdf_url_from_url(url: str) -> str:
    arxiv_id = _arxiv_id_from_url(url)
    if arxiv_id:
        return f"https://arxiv.org/pdf/{arxiv_id}.pdf"

    return url


def _fetch_arxiv_metadata(arxiv_id: str) -> Dict[str, Any]:
    response = requests.get(
        ARXIV_API_URL,
        params={"id_list": arxiv_id},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    root = ET.fromstring(response.text)
    entry = root.find("atom:entry", ATOM_NAMESPACE)
    if entry is None:
        raise ValueError(f"No arXiv metadata found for {arxiv_id}")

    title = _clean_text(entry.findtext("atom:title", default="", namespaces=ATOM_NAMESPACE))
    abstract = _clean_text(entry.findtext("atom:summary", default="", namespaces=ATOM_NAMESPACE))
    published = _clean_text(entry.findtext("atom:published", default="", namespaces=ATOM_NAMESPACE))
    updated = _clean_text(entry.findtext("atom:updated", default="", namespaces=ATOM_NAMESPACE))
    authors = [
        _clean_text(author.findtext("atom:name", default="", namespaces=ATOM_NAMESPACE))
        for author in entry.findall("atom:author", ATOM_NAMESPACE)
    ]
    authors = [author for author in authors if author]

    categories = [
        category.attrib.get("term", "").strip().lower()
        for category in entry.findall("atom:category", ATOM_NAMESPACE)
    ]
    categories = [category for category in categories if category]

    pdf_url = ""
    canonical_url = f"https://arxiv.org/abs/{arxiv_id}"
    for link in entry.findall("atom:link", ATOM_NAMESPACE):
        href = link.attrib.get("href", "")
        title_attr = link.attrib.get("title", "").lower()
        link_type = link.attrib.get("type", "").lower()
        rel = link.attrib.get("rel", "").lower()

        if rel == "alternate" and href:
            canonical_url = href
        if title_attr == "pdf" or "pdf" in link_type:
            pdf_url = href

    return {
        "title": title or arxiv_id,
        "abstract": abstract,
        "authors": authors,
        "published_at": published,
        "updated_at_source": updated,
        "categories": categories,
        "url": canonical_url,
        "pdf_url": pdf_url or _pdf_url_from_url(canonical_url),
    }


def _resolve_url_metadata(url: str) -> Dict[str, Any]:
    arxiv_id = _arxiv_id_from_url(url)
    if arxiv_id:
        try:
            metadata = _fetch_arxiv_metadata(arxiv_id)
            metadata["arxiv_id"] = arxiv_id
            return metadata
        except (requests.RequestException, ET.ParseError, ValueError):
            # The PDF path still works without the metadata API, so keep ingestion usable.
            pass

    return {
        "title": _title_from_url(url),
        "abstract": "",
        "authors": [],
        "published_at": "",
        "updated_at_source": "",
        "categories": [],
        "url": url,
        "pdf_url": _pdf_url_from_url(url),
        "arxiv_id": arxiv_id or "",
    }


def _safe_pdf_filename(url: str, title: str = "") -> str:
    arxiv_id = _arxiv_id_from_url(url)
    if arxiv_id:
        slug = re.sub(r"[^a-zA-Z0-9]+", "_", title.lower()).strip("_")
        if slug:
            return f"{arxiv_id}_{slug[:90]}.pdf"
        return f"{arxiv_id}.pdf"

    parsed = urlparse(url)
    name = Path(parsed.path).name
    if name.lower().endswith(".pdf"):
        return re.sub(r"[^a-zA-Z0-9._-]+", "_", name)

    slug = re.sub(r"[^a-zA-Z0-9]+", "_", title.lower() or "downloaded_paper").strip("_")
    return f"{slug[:110]}.pdf"


def _title_from_url(url: str) -> str:
    arxiv_id = _arxiv_id_from_url(url)
    if arxiv_id:
        return arxiv_id

    parsed = urlparse(url)
    stem = Path(parsed.path).stem
    return " ".join(stem.replace("_", " ").replace("-", " ").split()) or "Downloaded paper"


def _download_pdf(pdf_url: str, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with requests.get(pdf_url, timeout=REQUEST_TIMEOUT_SECONDS, stream=True) as response:
        response.raise_for_status()

        content_type = response.headers.get("content-type", "").lower()
        if "pdf" not in content_type and not pdf_url.lower().endswith(".pdf"):
            raise ValueError(f"URL did not return a PDF content type: {content_type}")

        with output_path.open("wb") as file:
            for chunk in response.iter_content(chunk_size=1024 * 256):
                if chunk:
                    file.write(chunk)


def ingest_article_url(
    url: str,
    title: str | None = None,
    domain: str = "research",
    category: str = "uncategorized",
    tags: List[str] | None = None,
) -> Dict[str, Any]:
    """
    Download a paper URL/PDF URL, index it into Qdrant, and record article metadata.
    """
    resolved = _resolve_url_metadata(url)
    arxiv_categories = resolved.get("categories", [])
    normalized_tags = _normalize_tags([*(tags or []), *arxiv_categories])
    pdf_url = resolved["pdf_url"]
    resolved_title = title.strip() if title else resolved["title"]
    resolved_category = (
        arxiv_categories[0]
        if category == "uncategorized" and arxiv_categories
        else category
    )
    filename = _safe_pdf_filename(pdf_url, title=resolved_title)
    pdf_path = UPLOAD_FOLDER / filename
    article_metadata = build_article_metadata(
        source=filename,
        article_metadata={
            "title": resolved_title,
            "url": resolved["url"],
            "abstract": resolved.get("abstract", ""),
            "authors": resolved.get("authors", []),
            "domain": domain,
            "category": resolved_category,
            "tags": normalized_tags,
        },
    )

    try:
        if not pdf_path.exists():
            _download_pdf(pdf_url, pdf_path)

        index_pdf(
            str(pdf_path),
            article_metadata=article_metadata,
            use_llm_metadata=False,
        )

        article = upsert_article(
            article_id=article_metadata["article_id"],
            title=article_metadata["title"] or resolved_title,
            source=filename,
            url=resolved["url"],
            pdf_url=pdf_url,
            domain=article_metadata["domain"],
            category=article_metadata["category"],
            tags=article_metadata["tags"],
            abstract=resolved.get("abstract", ""),
            authors=resolved.get("authors", []),
            published_at=resolved.get("published_at", ""),
            updated_at_source=resolved.get("updated_at_source", ""),
            status="indexed",
        )
    except Exception as exc:
        article = upsert_article(
            article_id=article_metadata["article_id"],
            title=article_metadata["title"] or resolved_title,
            source=filename,
            url=resolved["url"],
            pdf_url=pdf_url,
            domain=article_metadata["domain"],
            category=article_metadata["category"],
            tags=article_metadata["tags"],
            abstract=resolved.get("abstract", ""),
            authors=resolved.get("authors", []),
            published_at=resolved.get("published_at", ""),
            updated_at_source=resolved.get("updated_at_source", ""),
            status="failed",
            error=str(exc),
        )
        raise

    return {
        "article": article,
        "pdf_path": str(pdf_path),
        "pdf_url": pdf_url,
    }

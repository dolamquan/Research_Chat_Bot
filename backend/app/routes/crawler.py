import re
import xml.etree.ElementTree as ET
from typing import Any, Dict, List

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


router = APIRouter(prefix="/crawler", tags=["crawler"])

ARXIV_API_URL = "https://export.arxiv.org/api/query"
ATOM_NAMESPACE = {"atom": "http://www.w3.org/2005/Atom"}
REQUEST_TIMEOUT_SECONDS = 45
STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "about",
    "based",
    "by",
    "for",
    "from",
    "in",
    "into",
    "me",
    "of",
    "on",
    "or",
    "paper",
    "papers",
    "recent",
    "research",
    "show",
    "that",
    "the",
    "to",
    "using",
    "with",
}


class ArxivSearchRequest(BaseModel):
    description: str = Field(..., min_length=3)
    max_results: int = Field(default=10, ge=1, le=25)
    category: str | None = None
    sort_by: str = "relevance"


def _clean_text(text: str | None) -> str:
    return " ".join((text or "").split())


def _extract_keywords(description: str, limit: int = 8) -> List[str]:
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9-]{2,}", description.lower())
    keywords: List[str] = []

    for word in words:
        normalized = word.strip("-")
        if normalized in STOPWORDS or normalized in keywords:
            continue
        keywords.append(normalized)
        if len(keywords) >= limit:
            break

    return keywords


def _build_arxiv_query(description: str, category: str | None = None) -> str:
    keywords = _extract_keywords(description)

    if not keywords:
        search_query = f'all:"{description.strip()}"'
    else:
        search_query = " AND ".join(f'all:"{keyword}"' for keyword in keywords)

    if category:
        search_query = f"({search_query}) AND cat:{category.strip()}"

    return search_query


def _sort_by(sort_by: str) -> str:
    if sort_by == "newest":
        return "submittedDate"
    if sort_by == "last_updated":
        return "lastUpdatedDate"
    return "relevance"


def _entry_to_paper(entry: ET.Element) -> Dict[str, Any]:
    entry_id = _clean_text(entry.findtext("atom:id", default="", namespaces=ATOM_NAMESPACE))
    arxiv_id = entry_id.rstrip("/").split("/")[-1]
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
        category.attrib.get("term", "").strip()
        for category in entry.findall("atom:category", ATOM_NAMESPACE)
    ]
    categories = [category for category in categories if category]

    pdf_url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
    url = entry_id or f"https://arxiv.org/abs/{arxiv_id}"

    for link in entry.findall("atom:link", ATOM_NAMESPACE):
        href = link.attrib.get("href", "")
        title_attr = link.attrib.get("title", "").lower()
        link_type = link.attrib.get("type", "").lower()
        rel = link.attrib.get("rel", "").lower()

        if rel == "alternate" and href:
            url = href
        if href and (title_attr == "pdf" or "pdf" in link_type):
            pdf_url = href

    return {
        "arxiv_id": arxiv_id,
        "title": title or arxiv_id,
        "abstract": abstract,
        "authors": authors,
        "categories": categories,
        "published_at": published,
        "updated_at": updated,
        "url": url,
        "pdf_url": pdf_url,
    }


@router.post("/arxiv/search")
def search_arxiv(request: ArxivSearchRequest) -> Dict[str, Any]:
    query = _build_arxiv_query(request.description, request.category)

    try:
        response = requests.get(
            ARXIV_API_URL,
            params={
                "search_query": query,
                "start": 0,
                "max_results": request.max_results,
                "sortBy": _sort_by(request.sort_by),
                "sortOrder": "descending",
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        root = ET.fromstring(response.text)
    except (requests.RequestException, ET.ParseError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to search arXiv: {exc}",
        ) from exc

    papers = [
        _entry_to_paper(entry)
        for entry in root.findall("atom:entry", ATOM_NAMESPACE)
    ]

    return {
        "query": query,
        "papers": papers,
    }

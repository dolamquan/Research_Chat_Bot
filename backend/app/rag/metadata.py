import json
import re
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_DOMAIN = "research"
DEFAULT_CATEGORY = "uncategorized"


ALLOWED_DOCUMENT_TYPES = {
    "research_paper",
    "tutorial",
    "notes",
    "documentation",
    "visual_asset",
    "unknown",
}

ALLOWED_SECTION_TYPES = {
    "abstract",
    "introduction",
    "background",
    "method",
    "experiment",
    "result",
    "discussion",
    "conclusion",
    "figure",
    "reference",
    "unknown",
}


def _get_llm_text(response: Any) -> str:
    """
    Supports LangChain AIMessage objects and plain string responses.
    """
    if hasattr(response, "content"):
        return response.content
    return str(response)


def _extract_json(text: str) -> Dict[str, Any]:
    """
    Extract the first valid JSON object from an LLM response.
    """
    text = text.strip()

    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).strip()
        text = re.sub(r"```$", "", text).strip()

    start = text.find("{")
    if start == -1:
        raise ValueError(f"No JSON object found in LLM response: {text}")

    decoder = json.JSONDecoder()
    json_obj, _ = decoder.raw_decode(text[start:])

    if not isinstance(json_obj, dict):
        raise ValueError(f"Expected JSON object in LLM response: {text}")

    return json_obj


def _clean_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize metadata so Qdrant payloads stay predictable.
    """
    topic = str(metadata.get("topic", "unknown")).strip().lower()
    summary = str(metadata.get("summary", "")).strip()

    document_type = str(metadata.get("document_type", "unknown")).strip().lower()
    if document_type not in ALLOWED_DOCUMENT_TYPES:
        document_type = "unknown"

    section_type = str(metadata.get("section_type", "unknown")).strip().lower()
    if section_type not in ALLOWED_SECTION_TYPES:
        section_type = "unknown"

    keywords = metadata.get("keywords", [])
    if not isinstance(keywords, list):
        keywords = []

    keywords = [
        str(keyword).strip().lower()
        for keyword in keywords
        if str(keyword).strip()
    ]

    title = str(metadata.get("title", "")).strip()
    url = str(metadata.get("url", "")).strip()
    abstract = str(metadata.get("abstract", "")).strip()
    article_id = str(metadata.get("article_id", "")).strip()
    domain = str(metadata.get("domain", DEFAULT_DOMAIN)).strip().lower()
    category = str(metadata.get("category", DEFAULT_CATEGORY)).strip().lower()

    tags = metadata.get("tags", [])
    if not isinstance(tags, list):
        tags = []

    tags = [
        str(tag).strip().lower()
        for tag in tags
        if str(tag).strip()
    ]

    authors = metadata.get("authors", [])
    if not isinstance(authors, list):
        authors = []

    authors = [
        str(author).strip()
        for author in authors
        if str(author).strip()
    ]

    return {
        "article_id": article_id,
        "title": title,
        "url": url,
        "abstract": abstract,
        "authors": authors[:20],
        "domain": domain or DEFAULT_DOMAIN,
        "category": category or DEFAULT_CATEGORY,
        "tags": tags[:12],
        "topic": topic or "unknown",
        "document_type": document_type,
        "section_type": section_type,
        "keywords": keywords[:8],
        "summary": summary,
    }


def _title_from_source(source: str) -> str:
    stem = Path(source).stem
    stem = re.sub(r"^\d{4}\.\d+(?:v\d+)?_", "", stem)
    stem = stem.replace("_", " ").replace("-", " ")
    return " ".join(stem.split()).strip()


def _article_id_from_source(source: str, document_id: str = "") -> str:
    source_name = Path(source).name
    match = re.match(r"^(\d{4}\.\d+(?:v\d+)?)", source_name)

    if match:
        return f"arxiv:{match.group(1)}"

    return document_id or Path(source).stem


def build_article_metadata(
    source: str,
    document_id: str = "",
    article_metadata: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """
    Build document-level metadata used for domains/categories and article display.
    """
    overrides = article_metadata or {}

    return _clean_metadata(
        {
            "article_id": overrides.get(
                "article_id",
                _article_id_from_source(source, document_id=document_id),
            ),
            "title": overrides.get("title", _title_from_source(source)),
            "url": overrides.get("url", ""),
            "abstract": overrides.get("abstract", ""),
            "authors": overrides.get("authors", []),
            "domain": overrides.get("domain", DEFAULT_DOMAIN),
            "category": overrides.get("category", DEFAULT_CATEGORY),
            "tags": overrides.get("tags", []),
            "topic": overrides.get("topic", Path(source).stem if source else "unknown"),
            "document_type": overrides.get("document_type", "research_paper"),
            "section_type": overrides.get("section_type", "unknown"),
            "keywords": overrides.get("keywords", []),
            "summary": overrides.get("summary", ""),
        }
    )


def build_default_metadata(
    parent_record: Dict[str, Any],
    article_metadata: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """
    Create cheap local metadata without calling an LLM.

    This keeps large ingestions from making one API request per chunk. The richer
    topic labels can be added later at the cluster level with far fewer LLM calls.
    """
    source = str(parent_record.get("source") or parent_record.get("document_id") or "")
    document_id = str(parent_record.get("document_id") or "")
    text = str(parent_record.get("text") or "").strip()
    first_sentence = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0]
    base_metadata = build_article_metadata(
        source=source,
        document_id=document_id,
        article_metadata=article_metadata,
    )

    return _clean_metadata(
        {
            **base_metadata,
            "topic": base_metadata.get("topic") or Path(source).stem if source else "unknown",
            "document_type": "research_paper",
            "section_type": "unknown",
            "keywords": base_metadata.get("keywords", []),
            "summary": first_sentence[:240],
        }
    )


def tag_parent_metadata(parent_text: str, llm: Any) -> Dict[str, Any]:
    """
    Uses an LLM to create metadata for one parent chunk.
    """
    prompt = f"""
You are a metadata extraction system.

Return only valid JSON with this exact schema:

{{
  "topic": "short lowercase topic label",
  "document_type": "research_paper | tutorial | notes | documentation | unknown",
  "section_type": "abstract | introduction | background | method | experiment | result | discussion | conclusion | reference | unknown",
  "keywords": ["3 to 8 important lowercase keywords"],
  "summary": "one short sentence describing this chunk"
}}

Rules:
- Return exactly one JSON object.
- Do not include markdown.
- Do not include explanations.
- Do not include text before or after the JSON.
- Use "unknown" when unsure.
- Keep keywords short and useful for search/filtering.

Text chunk:
{parent_text}
"""

    response = llm.invoke(prompt)
    raw_text = _get_llm_text(response)
    metadata = _extract_json(raw_text)

    return _clean_metadata(metadata)


def tag_parent_records(
    parent_records: List[Dict[str, Any]],
    llm: Any = None,
    use_llm_metadata: bool = False,
    article_metadata: Dict[str, Any] | None = None,
) -> List[Dict[str, Any]]:
    """
    Adds metadata to each parent record.

    By default this does not call an LLM, which is important for large corpora.
    """
    tagged_parents = []

    for parent in parent_records:
        if use_llm_metadata:
            if llm is None:
                raise ValueError("llm is required when use_llm_metadata=True")
            metadata = tag_parent_metadata(parent["text"], llm)
            metadata = {
                **build_article_metadata(
                    source=str(parent.get("source") or ""),
                    document_id=str(parent.get("document_id") or ""),
                    article_metadata=article_metadata,
                ),
                **metadata,
            }
        else:
            metadata = build_default_metadata(
                parent,
                article_metadata=article_metadata,
            )

        tagged_parent = {
            **parent,
            "metadata": metadata,
        }

        tagged_parents.append(tagged_parent)

    return tagged_parents


def attach_parent_metadata_to_children(
    parent_records: List[Dict[str, Any]],
    child_records: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Copies parent metadata onto child chunks.

    This is useful because child chunks are usually what you store in Qdrant,
    but parent chunks are better for LLM metadata tagging.
    """
    parent_metadata_by_id = {
        parent["parent_id"]: parent.get("metadata", {})
        for parent in parent_records
    }

    enriched_children = []

    for child in child_records:
        parent_metadata = parent_metadata_by_id.get(child["parent_id"], {})

        enriched_child = {
            **child,
            "metadata": parent_metadata,
        }

        enriched_children.append(enriched_child)

    return enriched_children


def build_qdrant_payload(child_record: Dict[str, Any]) -> Dict[str, Any]:
    """
    Flattens a child record into a Qdrant-friendly payload.
    """
    metadata = child_record.get("metadata", {})

    return {
        "text": child_record["text"],
        "child_id": child_record["child_id"],
        "parent_id": child_record["parent_id"],
        "document_id": child_record["document_id"],
        "parent_index": child_record.get("parent_index"),
        "child_index": child_record["child_index"],
        "source": child_record.get("source"),
        "article_id": metadata.get("article_id", ""),
        "title": metadata.get("title", ""),
        "url": metadata.get("url", ""),
        "abstract": metadata.get("abstract", ""),
        "authors": metadata.get("authors", []),
        "domain": metadata.get("domain", DEFAULT_DOMAIN),
        "category": metadata.get("category", DEFAULT_CATEGORY),
        "tags": metadata.get("tags", []),
        "topic": metadata.get("topic", "unknown"),
        "document_type": metadata.get("document_type", "unknown"),
        "section_type": metadata.get("section_type", "unknown"),
        "keywords": metadata.get("keywords", []),
        "summary": metadata.get("summary", ""),
        "asset_id": metadata.get("asset_id", ""),
        "image_url": metadata.get("image_url", ""),
        "image_path": metadata.get("image_path", ""),
        "page": metadata.get("page"),
    }

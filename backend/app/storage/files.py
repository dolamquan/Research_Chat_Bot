"""Where the PDFs live: Supabase Storage when configured, with `uploaded_docs` as a local cache.

Every reader keeps opening a local path through `pdf_path()`. When Storage is
configured and the file is not on disk yet, it is fetched once into the cache;
ingestion writes locally as before and then `store_pdf()` uploads the copy
that outlives this machine. Without `SUPABASE_SERVICE_ROLE_KEY` nothing
changes: the folder is the only store, exactly as it was.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Iterator, List
from urllib.parse import quote

import httpx

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
UPLOAD_FOLDER = DATA_DIR / "uploaded_docs"
DEFAULT_BUCKET = "papers"


def storage_configured() -> bool:
    return bool(_url() and _service_key())


def bucket_name() -> str:
    return os.getenv("SUPABASE_STORAGE_BUCKET", "").strip() or DEFAULT_BUCKET


def _url() -> str:
    return os.getenv("SUPABASE_URL", "").strip().rstrip("/")


def _service_key() -> str:
    return os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()


def _headers(**extra: str) -> Dict[str, str]:
    key = _service_key()
    return {"Authorization": f"Bearer {key}", "apikey": key, **extra}


def _object_url(name: str) -> str:
    return f"{_url()}/storage/v1/object/{bucket_name()}/{quote(name, safe='')}"


def _client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0))


def safe_pdf_name(source: str) -> str:
    """The bare filename a caller may read; anything path-like is refused."""
    name = Path(source).name
    if name != source or not name.lower().endswith(".pdf") or name in {".", ".."}:
        raise ValueError(f"Invalid PDF filename: {source!r}")
    return name


def local_pdf_path(source: str) -> Path:
    return UPLOAD_FOLDER / safe_pdf_name(source)


def pdf_exists(source: str) -> bool:
    """On disk, or in Storage when configured (one HEAD request)."""
    try:
        path = local_pdf_path(source)
    except ValueError:
        return False
    if path.exists():
        return True
    if not storage_configured():
        return False
    with _client() as client:
        response = client.head(_object_url(path.name), headers=_headers())
    return response.status_code == 200


def pdf_path(source: str) -> Path:
    """A local file for this PDF, downloading it into the cache when only Storage has it.

    Raises FileNotFoundError when neither has it.
    """
    path = local_pdf_path(source)
    if path.exists():
        return path
    if not storage_configured():
        raise FileNotFoundError(path)
    UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".part")
    with _client() as client, client.stream("GET", _object_url(path.name), headers=_headers()) as response:
        if response.status_code == 404:
            raise FileNotFoundError(path)
        response.raise_for_status()
        with partial.open("wb") as handle:
            for chunk in response.iter_bytes():
                handle.write(chunk)
    partial.replace(path)
    return path


def store_pdf(path: Path, name: str | None = None) -> bool:
    """Upload (or overwrite) one local PDF. Returns False when Storage is not configured."""
    if not storage_configured():
        return False
    object_name = safe_pdf_name(name or path.name)
    with path.open("rb") as handle, _client() as client:
        response = client.post(
            _object_url(object_name),
            headers=_headers(**{"Content-Type": "application/pdf", "x-upsert": "true"}),
            content=handle.read(),
        )
    response.raise_for_status()
    return True


def ensure_bucket() -> bool:
    """Create the private bucket if it does not exist yet."""
    if not storage_configured():
        return False
    with _client() as client:
        existing = client.get(f"{_url()}/storage/v1/bucket/{bucket_name()}", headers=_headers())
        if existing.status_code == 200:
            return True
        created = client.post(
            f"{_url()}/storage/v1/bucket",
            headers=_headers(**{"Content-Type": "application/json"}),
            json={"id": bucket_name(), "name": bucket_name(), "public": False},
        )
    if created.status_code not in (200, 201):
        raise RuntimeError(f"Could not create bucket {bucket_name()}: {created.status_code} {created.text[:200]}")
    return True


def list_stored(prefix: str = "") -> List[Dict[str, Any]]:
    """Objects in the bucket (name, size, updated_at), paging through Storage's 1000 cap."""
    if not storage_configured():
        return []
    items: List[Dict[str, Any]] = []
    offset = 0
    with _client() as client:
        while True:
            response = client.post(
                f"{_url()}/storage/v1/object/list/{bucket_name()}",
                headers=_headers(**{"Content-Type": "application/json"}),
                json={"prefix": prefix, "limit": 1000, "offset": offset, "sortBy": {"column": "name", "order": "asc"}},
            )
            response.raise_for_status()
            page = response.json()
            for entry in page:
                if entry.get("id") is None:  # folders come back without an id
                    continue
                meta = entry.get("metadata") or {}
                items.append({"name": entry["name"], "size": meta.get("size"), "updated_at": entry.get("updated_at")})
            if len(page) < 1000:
                return items
            offset += len(page)


def local_pdfs() -> Iterator[Path]:
    if not UPLOAD_FOLDER.exists():
        return iter(())
    return (path for path in sorted(UPLOAD_FOLDER.glob("*.pdf")) if path.is_file())

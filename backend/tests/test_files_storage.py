"""PDFs behind a local cache with Supabase Storage as the durable copy (Storage is faked)."""

from __future__ import annotations

import json

import httpx
import pytest

from app.storage import files


class FakeStorage:
    """Just enough of the Storage REST API: bucket, object PUT/GET/HEAD, list."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.bucket_created = False
        self.requests: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(f"{request.method} {request.url.path}")
        assert request.headers.get("apikey") == "service-key"
        assert request.headers.get("authorization") == "Bearer service-key"
        path = request.url.path
        if path == "/storage/v1/bucket/papers":
            return httpx.Response(200 if self.bucket_created else 404, json={})
        if path == "/storage/v1/bucket":
            self.bucket_created = True
            return httpx.Response(200, json={"name": "papers"})
        if path == "/storage/v1/object/list/papers":
            body = json.loads(request.content)
            names = sorted(self.objects)[body["offset"]: body["offset"] + body["limit"]]
            return httpx.Response(200, json=[{"id": f"id-{n}", "name": n, "metadata": {"size": len(self.objects[n])}} for n in names])
        if path.startswith("/storage/v1/object/papers/"):
            name = httpx.URL(request.url).path.split("/storage/v1/object/papers/", 1)[1]
            name = httpx.URL(f"http://x/{name}").path[1:]  # percent-decoded
            if request.method == "POST":
                assert request.headers.get("x-upsert") == "true"
                self.objects[name] = request.content
                return httpx.Response(200, json={"Key": f"papers/{name}"})
            if name not in self.objects:
                return httpx.Response(404, json={"error": "not found"})
            if request.method == "HEAD":
                return httpx.Response(200)
            return httpx.Response(200, content=self.objects[name])
        return httpx.Response(500, text=f"unexpected {path}")


@pytest.fixture
def storage(monkeypatch, tmp_path):
    fake = FakeStorage()
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    monkeypatch.delenv("SUPABASE_STORAGE_BUCKET", raising=False)
    monkeypatch.setattr(files, "UPLOAD_FOLDER", tmp_path / "uploaded_docs")
    monkeypatch.setattr(files, "_client", lambda: httpx.Client(transport=httpx.MockTransport(fake.handler), timeout=5))
    return fake


def test_without_credentials_only_the_folder_exists(monkeypatch, tmp_path):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setattr(files, "UPLOAD_FOLDER", tmp_path)
    assert not files.storage_configured()
    (tmp_path / "a.pdf").write_bytes(b"%PDF")
    assert files.pdf_path("a.pdf") == tmp_path / "a.pdf"
    assert files.pdf_exists("a.pdf") and not files.pdf_exists("b.pdf")
    with pytest.raises(FileNotFoundError):
        files.pdf_path("b.pdf")
    assert files.store_pdf(tmp_path / "a.pdf") is False
    assert files.list_stored() == []


def test_filenames_are_validated():
    for bad in ("../x.pdf", "dir/x.pdf", "x.txt", "", ".."):
        with pytest.raises(ValueError):
            files.safe_pdf_name(bad)
    assert files.safe_pdf_name("2502.07223v1_Graph_RAG.pdf") == "2502.07223v1_Graph_RAG.pdf"


def test_upload_then_fetch_into_cache(storage, tmp_path):
    local = tmp_path / "uploaded_docs"
    local.mkdir()
    (local / "paper one.pdf").write_bytes(b"%PDF-1.4 one")
    assert files.ensure_bucket() and storage.bucket_created
    assert files.store_pdf(local / "paper one.pdf") is True
    assert storage.objects == {"paper one.pdf": b"%PDF-1.4 one"}

    (local / "paper one.pdf").unlink()
    assert files.pdf_exists("paper one.pdf")
    fetched = files.pdf_path("paper one.pdf")
    assert fetched == local / "paper one.pdf" and fetched.read_bytes() == b"%PDF-1.4 one"
    assert not (local / "paper one.pdf.part").exists()
    # Second read is served from the cache: no new Storage request.
    before = len(storage.requests)
    assert files.pdf_path("paper one.pdf") == fetched
    assert len(storage.requests) == before

    with pytest.raises(FileNotFoundError):
        files.pdf_path("missing.pdf")


def test_listing_pages_through_storage(storage):
    storage.objects = {f"p{i:04d}.pdf": b"x" * i for i in range(1005)}
    listed = files.list_stored()
    assert len(listed) == 1005
    assert listed[0] == {"name": "p0000.pdf", "size": 0, "updated_at": None}
    assert sum(1 for r in storage.requests if r.endswith("/object/list/papers")) == 2

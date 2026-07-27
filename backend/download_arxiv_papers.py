import argparse
import json
import re
import ssl
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List


UPLOAD_FOLDER = Path(__file__).resolve().parent / "app" / "data" / "uploaded_docs"
MANIFEST_PATH = UPLOAD_FOLDER / "arxiv_manifest.json"
ARXIV_API_URL = "https://export.arxiv.org/api/query"
DEFAULT_QUERY = (
    'all:"retrieval augmented generation" OR '
    'all:"dense retrieval" OR '
    'all:"neural information retrieval" OR '
    'all:"open-domain question answering" OR '
    'all:"large language models retrieval" OR '
    'all:"retrieval augmented"'
)


def sanitize_filename(value: str, max_length: int = 90) -> str:
    value = re.sub(r"[^a-zA-Z0-9._-]+", "_", value.strip().lower())
    value = re.sub(r"_+", "_", value).strip("_")
    return value[:max_length].strip("_") or "paper"


def existing_pdf_count(folder: Path) -> int:
    return len(list(folder.glob("*.pdf")))


def load_manifest() -> Dict[str, Dict[str, str]]:
    if not MANIFEST_PATH.exists():
        return {}

    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def save_manifest(manifest: Dict[str, Dict[str, str]]) -> None:
    MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def arxiv_id_from_entry_id(entry_id: str) -> str:
    return entry_id.rstrip("/").split("/")[-1]


def get_pdf_url(entry: ET.Element, namespace: Dict[str, str]) -> str:
    for link in entry.findall("atom:link", namespace):
        if link.attrib.get("title") == "pdf":
            return link.attrib["href"]

    entry_id = entry.findtext("atom:id", default="", namespaces=namespace)
    return entry_id.replace("/abs/", "/pdf/")


def make_ssl_context(insecure: bool) -> ssl.SSLContext | None:
    if not insecure:
        return None

    return ssl._create_unverified_context()


def fetch_entries(
    query: str,
    start: int,
    max_results: int,
    ssl_context: ssl.SSLContext | None,
) -> List[ET.Element]:
    params = urllib.parse.urlencode(
        {
            "search_query": query,
            "start": start,
            "max_results": max_results,
            "sortBy": "relevance",
            "sortOrder": "descending",
        }
    )
    url = f"{ARXIV_API_URL}?{params}"

    with urllib.request.urlopen(url, timeout=60, context=ssl_context) as response:
        xml_data = response.read()

    root = ET.fromstring(xml_data)
    namespace = {"atom": "http://www.w3.org/2005/Atom"}
    return root.findall("atom:entry", namespace)


def download_pdf(
    url: str,
    destination: Path,
    ssl_context: ssl.SSLContext | None,
) -> bool:
    temp_destination = destination.with_suffix(".download")

    try:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "mini-chatbot-rag-dataset/1.0"},
        )
        with urllib.request.urlopen(request, timeout=120, context=ssl_context) as response:
            data = response.read()

        if not data.startswith(b"%PDF"):
            return False

        temp_destination.write_bytes(data)
        temp_destination.replace(destination)
        return True
    finally:
        if temp_destination.exists():
            temp_destination.unlink()


def build_filename(arxiv_id: str, title: str) -> str:
    clean_id = sanitize_filename(arxiv_id, max_length=24)
    clean_title = sanitize_filename(title, max_length=80)
    return f"{clean_id}_{clean_title}.pdf"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download open-access arXiv PDFs into uploaded_docs."
    )
    parser.add_argument("--target-count", type=int, default=200)
    parser.add_argument("--query", default=DEFAULT_QUERY)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--sleep", type=float, default=3.0)
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable TLS certificate verification for machines with broken local CA chains.",
    )
    args = parser.parse_args()

    UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest()
    current_count = existing_pdf_count(UPLOAD_FOLDER)
    ssl_context = make_ssl_context(args.insecure)

    print(f"Existing PDFs: {current_count}")
    print(f"Target PDFs: {args.target_count}")

    start = 0
    downloaded = 0
    namespace = {"atom": "http://www.w3.org/2005/Atom"}

    while current_count < args.target_count:
        entries = fetch_entries(
            args.query,
            start=start,
            max_results=args.batch_size,
            ssl_context=ssl_context,
        )

        if not entries:
            print("No more arXiv results returned.")
            break

        for entry in entries:
            if current_count >= args.target_count:
                break

            entry_id = entry.findtext("atom:id", default="", namespaces=namespace)
            title = " ".join(
                entry.findtext("atom:title", default="untitled", namespaces=namespace).split()
            )
            arxiv_id = arxiv_id_from_entry_id(entry_id)

            if arxiv_id in manifest:
                continue

            filename = build_filename(arxiv_id, title)
            destination = UPLOAD_FOLDER / filename

            if destination.exists():
                manifest[arxiv_id] = {
                    "title": title,
                    "pdf_url": get_pdf_url(entry, namespace),
                    "filename": filename,
                }
                continue

            pdf_url = get_pdf_url(entry, namespace)
            print(f"Downloading {arxiv_id}: {title}")

            ok = download_pdf(
                pdf_url,
                destination,
                ssl_context=ssl_context,
            )

            if not ok:
                print(f"Skipped non-PDF response: {pdf_url}")
                continue

            manifest[arxiv_id] = {
                "title": title,
                "pdf_url": pdf_url,
                "filename": filename,
            }
            save_manifest(manifest)
            current_count += 1
            downloaded += 1

        start += args.batch_size
        time.sleep(args.sleep)

    save_manifest(manifest)
    print(f"Downloaded new PDFs: {downloaded}")
    print(f"Final PDF count: {existing_pdf_count(UPLOAD_FOLDER)}")
    print(f"Manifest: {MANIFEST_PATH}")


if __name__ == "__main__":
    main()

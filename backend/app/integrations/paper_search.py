import json
import os
import re
import shutil
import subprocess
from typing import Any, Dict, List


PAPER_SEARCH_COMMAND = "paper-search"
PAPER_SEARCH_DOCKER_IMAGE = "mcp/paper-search"
PAPER_SEARCH_DOCKER_ENTRYPOINT = "python"
PAPER_SEARCH_DOCKER_MODULE = "paper_search_mcp.cli"
DEFAULT_SOURCES = ["arxiv", "pubmed", "biorxiv", "medrxiv", "semantic_scholar"]


def _clean_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def _string_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [_clean_text(item) for item in value if _clean_text(item)]
    return [item.strip() for item in re.split(r"[,;]", str(value)) if item.strip()]


def _paper_id_from_url(url: str) -> str:
    match = re.search(r"arxiv\.org/(?:abs|pdf)/([^/?#]+)", url)
    if match:
        return match.group(1).removesuffix(".pdf")
    return ""


def _extract_json(stdout: str) -> Any:
    text = stdout.strip()
    if not text:
        return []

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    start = min(
        [index for index in [text.find("["), text.find("{")] if index >= 0],
        default=-1,
    )
    if start < 0:
        raise ValueError("paper-search did not return JSON")

    return json.loads(text[start:])


def _paper_search_available() -> bool:
    command = os.getenv("PAPER_SEARCH_COMMAND", PAPER_SEARCH_COMMAND).strip()
    return shutil.which(command) is not None


def _docker_available() -> bool:
    command = os.getenv("PAPER_SEARCH_DOCKER_COMMAND", "docker").strip()
    return shutil.which(command) is not None


def _search_backend() -> str:
    backend = os.getenv("PAPER_SEARCH_BACKEND", "auto").strip().lower()
    if backend in {"auto", "cli", "docker"}:
        return backend
    return "auto"


def _build_cli_command(
    description: str,
    *,
    max_results: int,
    selected_sources: List[str],
    category: str | None,
    sort_by: str,
    include_json: bool,
) -> List[str]:
    command = os.getenv("PAPER_SEARCH_COMMAND", PAPER_SEARCH_COMMAND).strip()
    args = [
        command,
        "search",
        description,
        "-n",
        str(max_results),
        "-s",
        ",".join(selected_sources),
    ]
    if include_json:
        args.append("--json")
    if category:
        args.extend(["--category", category])
    if sort_by:
        args.extend(["--sort-by", sort_by])
    return args


def _build_docker_command(
    description: str,
    *,
    max_results: int,
    selected_sources: List[str],
    category: str | None,
    sort_by: str,
    include_json: bool,
) -> List[str]:
    docker_command = os.getenv("PAPER_SEARCH_DOCKER_COMMAND", "docker").strip()
    image = os.getenv("PAPER_SEARCH_DOCKER_IMAGE", PAPER_SEARCH_DOCKER_IMAGE).strip()
    entrypoint = os.getenv(
        "PAPER_SEARCH_DOCKER_ENTRYPOINT",
        PAPER_SEARCH_DOCKER_ENTRYPOINT,
    ).strip()
    module = os.getenv("PAPER_SEARCH_DOCKER_MODULE", PAPER_SEARCH_DOCKER_MODULE).strip()
    args = [
        docker_command,
        "run",
        "--rm",
        "-i",
    ]
    if entrypoint:
        args.extend(["--entrypoint", entrypoint])

    env_names = [
        "SEMANTIC_SCHOLAR_API_KEY",
        "CROSSREF_MAILTO",
        "PUBMED_EMAIL",
        "NCBI_API_KEY",
        "OPENALEX_EMAIL",
        "CORE_API_KEY",
        "DOAJ_API_KEY",
        "UNPAYWALL_EMAIL",
        "PAPER_SEARCH_MCP_UNPAYWALL_EMAIL",
    ]
    for name in env_names:
        if os.getenv(name):
            args.extend(["-e", name])

    args.append(image)
    if module:
        args.extend(["-m", module])
    args.extend(
        [
            "search",
            description,
            "-n",
            str(max_results),
            "-s",
            ",".join(selected_sources),
        ]
    )
    return args


def _run_search_command(args: List[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _candidate_commands(
    description: str,
    *,
    max_results: int,
    selected_sources: List[str],
    category: str | None,
    sort_by: str,
) -> List[tuple[str, List[str], List[str]]]:
    backend = _search_backend()
    candidates: List[tuple[str, List[str], List[str]]] = []

    if backend in {"auto", "cli"} and _paper_search_available():
        candidates.append(
            (
                "paper_search_cli",
                _build_cli_command(
                    description,
                    max_results=max_results,
                    selected_sources=selected_sources,
                    category=category,
                    sort_by=sort_by,
                    include_json=True,
                ),
                _build_cli_command(
                    description,
                    max_results=max_results,
                    selected_sources=selected_sources,
                    category=None,
                    sort_by="",
                    include_json=False,
                ),
            )
        )

    if backend in {"auto", "docker"} and _docker_available():
        candidates.append(
            (
                "paper_search_docker",
                _build_docker_command(
                    description,
                    max_results=max_results,
                    selected_sources=selected_sources,
                    category=None,
                    sort_by="",
                    include_json=False,
                ),
                _build_docker_command(
                    description,
                    max_results=max_results,
                    selected_sources=selected_sources,
                    category=None,
                    sort_by="",
                    include_json=False,
                ),
            )
        )

    return candidates


def _normalize_paper(raw: Dict[str, Any], source_hint: str = "") -> Dict[str, Any]:
    url = _clean_text(
        raw.get("url")
        or raw.get("paper_url")
        or raw.get("abstract_url")
        or raw.get("html_url")
        or raw.get("doi_url")
    )
    pdf_url = _clean_text(raw.get("pdf_url") or raw.get("pdf") or raw.get("download_url"))
    paper_id = _clean_text(
        raw.get("paper_id")
        or raw.get("id")
        or raw.get("arxiv_id")
        or raw.get("pmid")
        or raw.get("doi")
        or _paper_id_from_url(url)
        or _paper_id_from_url(pdf_url)
    )
    source = _clean_text(raw.get("source") or raw.get("provider") or source_hint or "paper_search")
    categories = _string_list(raw.get("categories") or raw.get("category"))

    if source and source not in categories:
        categories.append(source)

    return {
        "paper_id": paper_id,
        "arxiv_id": paper_id or url or pdf_url,
        "source_provider": source,
        "title": _clean_text(raw.get("title")) or paper_id or "Untitled paper",
        "abstract": _clean_text(raw.get("abstract") or raw.get("summary")),
        "authors": _string_list(raw.get("authors")),
        "categories": categories,
        "published_at": _clean_text(raw.get("published_at") or raw.get("published_date") or raw.get("published") or raw.get("year")),
        "updated_at": _clean_text(raw.get("updated_at") or raw.get("updated_date") or raw.get("updated")),
        "url": url or pdf_url,
        "pdf_url": pdf_url,
        "doi": _clean_text(raw.get("doi")),
        "venue": _clean_text(raw.get("venue") or raw.get("journal")),
    }


def search_papers(
    description: str,
    *,
    max_results: int = 10,
    sources: List[str] | None = None,
    category: str | None = None,
    sort_by: str = "relevance",
) -> Dict[str, Any]:
    selected_sources = [source.strip() for source in (sources or DEFAULT_SOURCES) if source.strip()]
    if not selected_sources:
        selected_sources = DEFAULT_SOURCES

    candidates = _candidate_commands(
        description,
        max_results=max_results,
        selected_sources=selected_sources,
        category=category,
        sort_by=sort_by,
    )
    if not candidates:
        raise RuntimeError(
            "Paper Search is not available. Install the paper-search CLI, or install Docker "
            f"and set PAPER_SEARCH_BACKEND=docker with PAPER_SEARCH_DOCKER_IMAGE={PAPER_SEARCH_DOCKER_IMAGE}."
        )

    timeout = int(os.getenv("PAPER_SEARCH_TIMEOUT_SECONDS", "90"))
    completed: subprocess.CompletedProcess[str] | None = None
    provider = ""
    errors = []

    for candidate_provider, primary_args, fallback_args in candidates:
        provider = candidate_provider
        completed = _run_search_command(primary_args, timeout)
        if completed.returncode != 0:
            completed = _run_search_command(fallback_args, timeout)
        if completed.returncode == 0:
            break
        detail = completed.stderr.strip() or completed.stdout.strip() or "paper search failed"
        errors.append(f"{candidate_provider}: {detail[:400]}")
        completed = None

    if completed is None:
        raise RuntimeError("; ".join(errors)[:800] or "paper search failed")

    data = _extract_json(completed.stdout)
    if isinstance(data, dict):
        raw_papers = (
            data.get("papers")
            or data.get("results")
            or data.get("items")
            or data.get("data")
            or []
        )
        query = _clean_text(data.get("query") or description)
    else:
        raw_papers = data
        query = description

    papers = [
        _normalize_paper(item if isinstance(item, dict) else {"title": item}, source_hint="")
        for item in raw_papers[:max_results]
    ]

    return {
        "provider": provider or "paper_search",
        "query": query,
        "sources": selected_sources,
        "papers": papers,
    }

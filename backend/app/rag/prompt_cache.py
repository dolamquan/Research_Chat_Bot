import hashlib
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Callable

from dotenv import load_dotenv
from langsmith import traceable


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DEFAULT_CACHE_PATH = DATA_DIR / "llm_prompt_cache.sqlite"
DEFAULT_TTL_SECONDS = 60 * 60 * 24


def _enabled() -> bool:
    load_dotenv()
    return os.getenv("LLM_RESPONSE_CACHE_ENABLED", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _cache_path() -> Path:
    load_dotenv()
    raw_path = os.getenv("LLM_RESPONSE_CACHE_PATH", "").strip()
    return Path(raw_path) if raw_path else DEFAULT_CACHE_PATH


def _ttl_seconds() -> int:
    load_dotenv()
    try:
        return max(0, int(os.getenv("LLM_RESPONSE_CACHE_TTL_SECONDS", DEFAULT_TTL_SECONDS)))
    except ValueError:
        return DEFAULT_TTL_SECONDS


def _llm_name(llm: Any) -> str:
    return str(
        getattr(llm, "model_name", None)
        or getattr(llm, "model", None)
        or getattr(llm, "deployment_name", None)
        or llm.__class__.__name__
    )


def _llm_temperature(llm: Any) -> str:
    return str(getattr(llm, "temperature", "unknown"))


def _response_text(response: Any) -> str:
    if hasattr(response, "content"):
        return str(response.content)
    return str(response)


def _cache_key(namespace: str, model: str, temperature: str, prompt: str) -> str:
    raw_key = "\n".join([namespace, model, temperature, prompt])
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def _connect() -> sqlite3.Connection:
    path = _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS llm_prompt_cache (
            cache_key TEXT PRIMARY KEY,
            namespace TEXT NOT NULL,
            model TEXT NOT NULL,
            temperature TEXT NOT NULL,
            prompt_hash TEXT NOT NULL,
            response TEXT NOT NULL,
            created_at REAL NOT NULL,
            accessed_at REAL NOT NULL,
            hit_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    return conn


def _get(cache_key: str, ttl_seconds: int) -> str | None:
    now = time.time()
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT response, created_at
            FROM llm_prompt_cache
            WHERE cache_key = ?
            """,
            (cache_key,),
        ).fetchone()

        if row is None:
            return None

        response, created_at = row
        if ttl_seconds and now - float(created_at) > ttl_seconds:
            conn.execute("DELETE FROM llm_prompt_cache WHERE cache_key = ?", (cache_key,))
            return None

        conn.execute(
            """
            UPDATE llm_prompt_cache
            SET accessed_at = ?, hit_count = hit_count + 1
            WHERE cache_key = ?
            """,
            (now, cache_key),
        )
        return str(response)


def _set(
    cache_key: str,
    namespace: str,
    model: str,
    temperature: str,
    prompt: str,
    response: str,
) -> None:
    now = time.time()
    prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    with _connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO llm_prompt_cache (
                cache_key,
                namespace,
                model,
                temperature,
                prompt_hash,
                response,
                created_at,
                accessed_at,
                hit_count
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(
                (SELECT hit_count FROM llm_prompt_cache WHERE cache_key = ?),
                0
            ))
            """,
            (
                cache_key,
                namespace,
                model,
                temperature,
                prompt_hash,
                response,
                now,
                now,
                cache_key,
            ),
        )


@traceable(name="cached_llm_text", run_type="chain")
def cached_llm_text(
    llm: Any,
    prompt: str,
    namespace: str,
    invoke: Callable[[str], Any] | None = None,
) -> str:
    """
    Return a cached LLM text response for identical prompt/model calls.

    This is an exact-response cache. It does not replace provider-side prompt
    caching, but it prevents repeated local eval/tool/debug calls from paying
    for the same deterministic prompt again.
    """
    model = _llm_name(llm)
    temperature = _llm_temperature(llm)

    if not _enabled() or temperature not in {"0", "0.0", "None", "unknown"}:
        response = invoke(prompt) if invoke else llm.invoke(prompt)
        return _response_text(response).strip()

    key = _cache_key(namespace=namespace, model=model, temperature=temperature, prompt=prompt)
    cached_response = _get(cache_key=key, ttl_seconds=_ttl_seconds())
    if cached_response is not None:
        return cached_response

    response = invoke(prompt) if invoke else llm.invoke(prompt)
    text = _response_text(response).strip()
    _set(
        cache_key=key,
        namespace=namespace,
        model=model,
        temperature=temperature,
        prompt=prompt,
        response=text,
    )
    return text

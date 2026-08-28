"""Provider-independent chat-model construction.

Model construction used to be a single `ChatOpenAI(...)` call inside
`generator.get_llm`, which meant the provider was decided at the import site
and could not be varied per request or stubbed in a test. This module owns that
decision instead: callers ask for a model, optionally naming a provider, and
get back a LangChain chat model that behaves identically whichever backend
answers.

`generator.get_llm` still exists and still returns the same thing it always
did, so no existing caller has to change.

Nothing here reads or logs a key beyond checking that one is present. A missing
key raises `ProviderNotConfigured`, which routes translate into a 502 rather
than leaking the underlying client's exception text.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Literal

from dotenv import load_dotenv

Provider = Literal["openai", "anthropic"]

SUPPORTED_PROVIDERS: tuple[str, ...] = ("openai", "anthropic")

# Kept as the historical default so behaviour is unchanged when nothing is set.
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5"

_PROVIDER_KEY_ENV: Dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}

_PROVIDER_MODEL_ENV: Dict[str, str] = {
    "openai": "OPENAI_MODEL",
    "anthropic": "ANTHROPIC_MODEL",
}

_PROVIDER_DEFAULT_MODEL: Dict[str, str] = {
    "openai": DEFAULT_OPENAI_MODEL,
    "anthropic": DEFAULT_ANTHROPIC_MODEL,
}


class ProviderNotConfigured(RuntimeError):
    """A provider was requested but its credentials or package are missing."""


class UnknownProvider(ValueError):
    """A provider name outside the supported set was requested."""


def resolve_provider(provider: str | None = None) -> str:
    """Which provider to use: explicit argument, then env, then OpenAI."""
    load_dotenv()
    name = (provider or os.getenv("LLM_PROVIDER") or "openai").strip().lower()
    if name not in SUPPORTED_PROVIDERS:
        raise UnknownProvider(
            f"Unsupported LLM provider {name!r}. "
            f"Supported: {', '.join(SUPPORTED_PROVIDERS)}"
        )
    return name


def resolve_model(provider: str, model: str | None = None) -> str:
    """Which model to use for a provider: explicit, then env, then default."""
    if model:
        return model
    load_dotenv()
    return os.getenv(_PROVIDER_MODEL_ENV[provider]) or _PROVIDER_DEFAULT_MODEL[provider]


def provider_is_available(provider: str) -> bool:
    """True when the provider's key is present and its package importable."""
    try:
        name = resolve_provider(provider)
    except UnknownProvider:
        return False
    if not os.getenv(_PROVIDER_KEY_ENV[name]):
        return False
    try:
        _import_chat_class(name)
    except ProviderNotConfigured:
        return False
    return True


def available_providers() -> list[str]:
    return [name for name in SUPPORTED_PROVIDERS if provider_is_available(name)]


def _import_chat_class(provider: str) -> Any:
    """Import a provider's chat class lazily.

    Lazy so that a missing optional dependency only matters when that provider
    is actually selected -- installing `langchain-anthropic` stays optional for
    anyone running on OpenAI.
    """
    if provider == "openai":
        try:
            from langchain_openai import ChatOpenAI
        except ImportError as error:  # pragma: no cover - dependency guard
            raise ProviderNotConfigured(
                "langchain-openai is not installed. Install it to use the "
                "openai provider."
            ) from error
        return ChatOpenAI

    if provider == "anthropic":
        try:
            from langchain_anthropic import ChatAnthropic
        except ImportError as error:
            raise ProviderNotConfigured(
                "langchain-anthropic is not installed. Install it to use the "
                "anthropic provider."
            ) from error
        return ChatAnthropic

    raise UnknownProvider(f"Unsupported LLM provider {provider!r}")


def build_chat_model(
    provider: str | None = None,
    model: str | None = None,
    temperature: float = 0,
    **kwargs: Any,
) -> Any:
    """Construct a LangChain chat model for the selected provider.

    Both providers expose `.invoke` and `.with_structured_output`, so callers
    downstream of this function never branch on which one they were given.
    """
    name = resolve_provider(provider)
    chat_class = _import_chat_class(name)
    resolved_model = resolve_model(name, model)

    key_env = _PROVIDER_KEY_ENV[name]
    if not os.getenv(key_env):
        raise ProviderNotConfigured(
            f"{key_env} is not set, so the {name} provider cannot be used."
        )

    if name == "anthropic":
        # ChatAnthropic requires an explicit token ceiling; ChatOpenAI does not.
        kwargs.setdefault("max_tokens", 8192)

    return chat_class(model=resolved_model, temperature=temperature, **kwargs)


def describe_model(chat_model: Any, provider: str | None = None) -> Dict[str, str]:
    """Provider and model name for a constructed client, for persistence.

    Read defensively: the attribute holding the model name differs between
    LangChain integrations, and a test double may have neither.
    """
    name = provider or ""
    if not name:
        class_name = type(chat_model).__name__.lower()
        if "anthropic" in class_name:
            name = "anthropic"
        elif "openai" in class_name:
            name = "openai"
        else:
            name = "unknown"

    model = (
        getattr(chat_model, "model_name", None)
        or getattr(chat_model, "model", None)
        or "unknown"
    )
    return {"provider": name, "model": str(model)}

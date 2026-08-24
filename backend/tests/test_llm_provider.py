"""Provider selection, and that existing callers keep working."""

from __future__ import annotations

import pytest

from app.rag import llm_provider
from app.rag.llm_provider import (
    DEFAULT_ANTHROPIC_MODEL,
    DEFAULT_OPENAI_MODEL,
    ProviderNotConfigured,
    UnknownProvider,
    build_chat_model,
    describe_model,
    resolve_model,
    resolve_provider,
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Isolate from the developer's real .env for every test in this module."""
    for name in (
        "LLM_PROVIDER",
        "OPENAI_MODEL",
        "ANTHROPIC_MODEL",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    # `resolve_provider` calls load_dotenv(), which would put the real file's
    # values back; neutralise it so the environment above is what is read.
    monkeypatch.setattr(llm_provider, "load_dotenv", lambda *a, **k: False)


def test_default_provider_is_openai():
    assert resolve_provider() == "openai"


def test_env_selects_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    assert resolve_provider() == "anthropic"


def test_explicit_argument_beats_env(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    assert resolve_provider("openai") == "openai"


def test_provider_name_is_case_insensitive():
    assert resolve_provider("OpenAI") == "openai"


def test_unknown_provider_raises():
    with pytest.raises(UnknownProvider, match="Unsupported LLM provider"):
        resolve_provider("cohere")


def test_model_defaults_per_provider():
    assert resolve_model("openai") == DEFAULT_OPENAI_MODEL
    assert resolve_model("anthropic") == DEFAULT_ANTHROPIC_MODEL


def test_model_env_override(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o")
    assert resolve_model("openai") == "gpt-4o"


def test_explicit_model_beats_env(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o")
    assert resolve_model("openai", "gpt-4.1") == "gpt-4.1"


def test_missing_key_raises_provider_not_configured():
    with pytest.raises(ProviderNotConfigured, match="OPENAI_API_KEY"):
        build_chat_model(provider="openai")


def test_missing_key_message_names_the_variable_not_its_value(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    with pytest.raises(ProviderNotConfigured) as excinfo:
        build_chat_model(provider="anthropic")
    message = str(excinfo.value)
    assert "ANTHROPIC_API_KEY" in message
    assert "sk-" not in message


def test_openai_client_is_constructed(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-real")
    client = build_chat_model(provider="openai", model="gpt-4o-mini")
    assert type(client).__name__ == "ChatOpenAI"
    assert describe_model(client, "openai") == {
        "provider": "openai",
        "model": "gpt-4o-mini",
    }


def test_anthropic_client_is_constructed_when_available(monkeypatch):
    pytest.importorskip("langchain_anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    client = build_chat_model(provider="anthropic", model="claude-sonnet-4-5")
    assert type(client).__name__ == "ChatAnthropic"
    assert describe_model(client, "anthropic")["provider"] == "anthropic"


def test_describe_model_infers_provider_from_class():
    class ChatOpenAILike:
        model_name = "gpt-4o"

    assert describe_model(ChatOpenAILike())["provider"] == "openai"

    class ChatAnthropicLike:
        model = "claude-sonnet-4-5"

    assert describe_model(ChatAnthropicLike())["provider"] == "anthropic"


def test_describe_model_tolerates_a_bare_stub():
    class Bare:
        pass

    described = describe_model(Bare())
    assert described == {"provider": "unknown", "model": "unknown"}


def test_get_llm_keeps_its_historical_behaviour(monkeypatch):
    """The 12 existing call sites must be unaffected by the refactor."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-real")
    from app.rag.generator import DEFAULT_MODEL, get_llm

    client = get_llm()
    assert type(client).__name__ == "ChatOpenAI"
    assert client.model_name == DEFAULT_MODEL


def test_get_llm_accepts_a_provider(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-real")
    from app.rag.generator import get_llm

    client = get_llm(provider="openai", temperature=0.5)
    assert type(client).__name__ == "ChatOpenAI"


def test_available_providers_reports_only_configured_ones(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-real")
    assert "openai" in llm_provider.available_providers()
    assert "anthropic" not in llm_provider.available_providers()

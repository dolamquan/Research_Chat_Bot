"""Model selection for the agent loop and its workers."""

from __future__ import annotations

import pytest

from app.agents import models


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    # Empty strings (not deletions): `load_dotenv` would otherwise repopulate
    # these from backend/.env behind the test's back.
    for name in ("AGENT_MODEL", "AGENT_WORKER_MODEL", "AGENT_REASONING_EFFORT", "AGENT_WORKER_REASONING_EFFORT", "LLM_PROVIDER"):
        monkeypatch.setenv(name, "")


def test_openai_defaults_to_gpt5_for_the_loop_and_mini_for_workers():
    assert models.agent_model_name() == "gpt-5"
    assert models.worker_model_name() == "gpt-5-mini"


def test_environment_overrides_both(monkeypatch):
    monkeypatch.setenv("AGENT_MODEL", "gpt-4.1")
    monkeypatch.setenv("AGENT_WORKER_MODEL", "gpt-4.1-mini")
    assert models.agent_model_name() == "gpt-4.1"
    assert models.worker_model_name() == "gpt-4.1-mini"


def test_other_providers_defer_to_their_own_default(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    assert models.agent_model_name() is None
    assert models.worker_model_name() is None
    monkeypatch.setenv("AGENT_MODEL", "claude-sonnet-4-5")
    assert models.worker_model_name() == "claude-sonnet-4-5"  # workers fall back to the agent's model


def test_reasoning_effort_only_reaches_reasoning_models(monkeypatch):
    assert models.model_kwargs("gpt-5") == {"reasoning_effort": "low"}
    assert models.model_kwargs("gpt-5-mini") == {"reasoning_effort": "low"}
    assert models.model_kwargs("o3") == {"reasoning_effort": "low"}
    assert models.model_kwargs("gpt-4o-mini") == {}
    assert models.model_kwargs("gpt-5-chat-latest") == {}
    assert models.model_kwargs(None) == {}
    monkeypatch.setenv("AGENT_REASONING_EFFORT", "medium")
    assert models.model_kwargs("gpt-5") == {"reasoning_effort": "medium"}
    monkeypatch.setenv("AGENT_REASONING_EFFORT", "off")
    assert models.model_kwargs("gpt-5") == {}


def test_worker_effort_falls_back_to_the_agents(monkeypatch):
    monkeypatch.setenv("AGENT_REASONING_EFFORT", "high")
    assert models.model_kwargs("gpt-5-mini", "AGENT_WORKER_REASONING_EFFORT", fallback_env="AGENT_REASONING_EFFORT") == {"reasoning_effort": "high"}
    monkeypatch.setenv("AGENT_WORKER_REASONING_EFFORT", "minimal")
    assert models.model_kwargs("gpt-5-mini", "AGENT_WORKER_REASONING_EFFORT", fallback_env="AGENT_REASONING_EFFORT") == {"reasoning_effort": "minimal"}

"""Which models drive the agent loop and its workers.

The main loop plans, recovers from tool errors and writes the final answer,
so it gets the strong model: gpt-5 by default on OpenAI. Workers each run one
focused sub-task and only their conclusions come back to the main loop, so
they default to the faster gpt-5-mini. Both are overridable per deployment
(AGENT_MODEL / AGENT_WORKER_MODEL); on other providers the provider's own
default applies unless a model is named.

Reasoning models take a `reasoning_effort` knob that non-reasoning models
reject outright, so it is only attached when the model name says it applies.
"""
from __future__ import annotations

import os
import re
from typing import Any, Dict

from app.rag.llm_provider import resolve_provider

DEFAULT_AGENT_MODELS: Dict[str, str] = {"openai": "gpt-5"}
DEFAULT_WORKER_MODELS: Dict[str, str] = {"openai": "gpt-5-mini"}

# Model families that accept reasoning_effort. "gpt-5-chat" variants do not.
REASONING_MODEL_PREFIXES = ("gpt-5", "o1", "o3", "o4")
DEFAULT_REASONING_EFFORT = "low"
_EFFORT_OFF = {"", "off", "none", "default"}


def _provider() -> str:
    try:
        return resolve_provider()
    except Exception:  # unsupported LLM_PROVIDER: let the provider layer report it later
        return "openai"


def agent_model_name() -> str | None:
    """The main loop's model: AGENT_MODEL, else the provider's strong default."""
    return (os.getenv("AGENT_MODEL") or "").strip() or DEFAULT_AGENT_MODELS.get(_provider())


def worker_model_name() -> str | None:
    """A worker's model: AGENT_WORKER_MODEL, else the fast default, else the agent's model."""
    return (
        (os.getenv("AGENT_WORKER_MODEL") or "").strip()
        or DEFAULT_WORKER_MODELS.get(_provider())
        or agent_model_name()
    )


def is_reasoning_model(name: str | None) -> bool:
    lowered = (name or "").strip().lower()
    if not lowered or "chat" in lowered:
        return False
    return lowered.startswith(REASONING_MODEL_PREFIXES)


def model_kwargs(name: str | None, env: str = "AGENT_REASONING_EFFORT", fallback_env: str | None = None) -> Dict[str, Any]:
    """Extra constructor arguments for a model: reasoning effort when it applies.

    `env` names the setting; `fallback_env` is consulted when it is unset, so
    workers inherit the agent's effort unless told otherwise. "off" restores
    the model's own default.
    """
    raw = os.getenv(env)
    if raw is None or not raw.strip():
        raw = os.getenv(fallback_env) if fallback_env else None
    effort = (raw or DEFAULT_REASONING_EFFORT).strip().lower()
    if effort in _EFFORT_OFF or not is_reasoning_model(name):
        return {}
    return {"reasoning_effort": effort}


def _is_gpt5(name: str | None) -> bool:
    return is_reasoning_model(name) and (name or "").strip().lower().startswith("gpt-5")


# The original gpt-5 family (optionally date-suffixed) accepts "minimal"; later
# releases such as gpt-5.1 use "none" instead and reject "minimal" outright.
_MINIMAL_EFFORT_MODELS = re.compile(r"^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$")


def followup_kwargs(name: str | None) -> Dict[str, Any]:
    """Effort for the steps after the first: AGENT_FOLLOWUP_REASONING_EFFORT, else
    "minimal" on the original gpt-5 family, else the agent's own effort."""
    raw = (os.getenv("AGENT_FOLLOWUP_REASONING_EFFORT") or "").strip().lower()
    if not raw:
        if _MINIMAL_EFFORT_MODELS.match((name or "").strip().lower()):
            return {"reasoning_effort": "minimal"}
        return model_kwargs(name, "AGENT_REASONING_EFFORT")
    if raw in _EFFORT_OFF or not is_reasoning_model(name):
        return {}
    return {"reasoning_effort": raw}


def verbosity_kwargs(name: str | None) -> Dict[str, Any]:
    """gpt-5's answer length knob (low/medium/high), only when AGENT_VERBOSITY is set."""
    raw = (os.getenv("AGENT_VERBOSITY") or "").strip().lower()
    if raw in ("low", "medium", "high") and _is_gpt5(name):
        return {"verbosity": raw}
    return {}

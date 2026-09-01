"""Shared fixtures.

No test in this suite reaches a network, a vector store, or a model provider.
Anything that would is either injected as a stub or exercised through its
fallback path, so the suite runs offline and deterministically.
"""

from __future__ import annotations

import os

# The RAG modules are decorated with `@traceable`, which otherwise tries to
# reach LangSmith during every test and floods the output with connection
# errors. Tracing is a production concern, not a test one.
os.environ.setdefault("LANGSMITH_TRACING", "false")
os.environ.setdefault("LANGCHAIN_TRACING_V2", "false")
os.environ.pop("LANGSMITH_API_KEY", None)
os.environ.pop("LANGCHAIN_API_KEY", None)
from typing import Any, Dict, List

import pytest


class StubChatModel:
    """A LangChain-shaped chat model that replays canned responses.

    Mimics enough of the interface that `scene_coder` cannot tell it from a
    real client: `with_structured_output` either returns a model instance or
    raises to force the JSON path, and `invoke` returns an object with
    `.content` like both providers do.
    """

    def __init__(
        self,
        *,
        structured: Any = None,
        structured_raises: bool = False,
        responses: List[str] | None = None,
        model_name: str = "stub-model",
    ) -> None:
        self.structured = structured
        self.structured_raises = structured_raises
        self.responses = list(responses or [])
        self.model_name = model_name
        self.prompts: List[str] = []
        self.structured_calls = 0

    # --- structured path ---
    def with_structured_output(self, _schema: Any, **_kwargs: Any) -> "StubChatModel":
        self.structured_calls += 1
        if self.structured_raises:
            raise RuntimeError("structured output unsupported by this stub")
        return self

    # --- both paths ---
    def invoke(self, prompt: str) -> Any:
        self.prompts.append(prompt)
        if self.structured is not None and self.structured_calls > 0:
            return self.structured
        if not self.responses:
            raise AssertionError("StubChatModel ran out of canned responses")
        text = self.responses.pop(0)
        return type("Response", (), {"content": text})()


@pytest.fixture
def stub_chat_model():
    return StubChatModel


@pytest.fixture
def sample_visualization() -> Dict[str, Any]:
    """A minimal visualization record shaped like `visualization_store` returns."""
    return {
        "viz_id": "viz_test_1",
        "article_id": "article_test_1",
        "document_source": "test_paper.pdf",
        "diagram_kind": "method_flow",
        "diagram": {
            "title": "Test Method",
            "nodes": [
                {"id": "input", "label": "Input", "kind": "input", "detail": ""},
                {"id": "encoder", "label": "Encoder", "kind": "operation", "detail": ""},
                {"id": "output", "label": "Output", "kind": "output", "detail": ""},
            ],
            "edges": [
                {"source": "input", "target": "encoder", "kind": "flow", "label": ""},
                {"source": "encoder", "target": "output", "kind": "flow", "label": ""},
            ],
            "groups": [],
        },
        "summary": "A test method.",
        "algorithm_name": "Test Method",
    }

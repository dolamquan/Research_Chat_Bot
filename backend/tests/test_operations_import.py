"""Bounded, idempotent LangSmith imports with no network."""
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.ops import store
from app.ops import langsmith_import


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("OPS_DB_PATH", str(tmp_path / "operations.sqlite3"))
    monkeypatch.setenv("LANGSMITH_API_KEY", "test-key")


def run(id, *, parent=None, children=None, cost=None, metadata=None):
    return SimpleNamespace(id=id, trace_id="trace", parent_run_id=parent, child_run_ids=children,
        name="ChatOpenAI", extra={"metadata": {"ls_provider": "openai", "ls_model_name": "gpt-5", **(metadata or {})}},
        start_time=datetime.now(timezone.utc), end_time=datetime.now(timezone.utc),
        prompt_tokens=100, completion_tokens=10, total_cost=cost, error=None,
        url="https://smith.langchain.com/o/test/projects/p/test/r/" + id)


def test_import_leaves_only_idempotent_and_missing_cost_unknown(monkeypatch):
    runs = [run("wrapper", children=["leaf"]), run("leaf", parent="wrapper", cost=.004, metadata={"user_id": "alice"}), run("unknown", cost=None)]
    closed = []
    class FakeClient:
        def __init__(self, **kwargs):
            pass
        def list_runs(self, **kwargs):
            assert kwargs["run_type"] == "llm" and kwargs["limit"] == 1000
            return iter(runs)
        def close(self):
            closed.append(True)
    monkeypatch.setattr(langsmith_import, "Client", FakeClient)
    assert langsmith_import.import_history()["imported"] == 2
    assert langsmith_import.import_history()["imported"] == 0
    summary = store.overview()["stats"]
    assert summary["cost"] == .004 and summary["calls"] == 2 and summary["unpriced"] == 1
    assert store.event_detail("leaf")["event"]["user_id"] == "alice"
    assert store.event_detail("unknown")["event"]["cost_usd"] is None
    assert store.event_detail("wrapper") is None
    assert len(closed) == 2


def test_local_run_id_not_imported_twice(monkeypatch):
    store.begin({"id": "leaf", "request_id": "local-request", "kind": "llm", "name": "gpt-5", "provider": "openai", "model": "gpt-5"})
    store.finish("leaf", usage={"input_tokens": 100, "output_tokens": 10})
    class FakeClient:
        def __init__(self, **kwargs):
            pass
        def list_runs(self, **kwargs):
            return iter([run("leaf", cost=10)])
        def close(self):
            pass
    monkeypatch.setattr(langsmith_import, "Client", FakeClient)
    result = langsmith_import.import_history()
    assert result["imported"] == 0 and result["skipped"] == 1
    assert store.overview()["stats"]["cost"] == pytest.approx(.000225)

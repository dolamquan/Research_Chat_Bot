"""Optional, bounded import of historical LLM leaf runs. Keys stay on the server."""
import os
from datetime import datetime, timedelta, timezone

from langsmith import Client

from app.ops import store


def import_history(days: int = 7, limit: int = 1000) -> dict:
    project = os.getenv("LANGSMITH_PROJECT") or os.getenv("LANGCHAIN_PROJECT") or "default"
    key = os.getenv("LANGSMITH_API_KEY") or os.getenv("LANGCHAIN_API_KEY")
    if not key:
        raise ValueError("LangSmith is not configured on this backend.")
    client = Client(api_key=key, timeout_ms=15000)
    imported, skipped = 0, 0
    try:
        runs = list(client.list_runs(project_name=project, run_type="llm", start_time=datetime.now(timezone.utc) - timedelta(days=days), limit=limit))
        # Some @traceable LLM wrappers contain another LLM run. Parent token
        # aggregates must not be counted again alongside their model leaf.
        parent_ids = {str(run.parent_run_id) for run in runs if run.parent_run_id}
        for run in runs:
            event_id = str(run.id)
            if event_id in parent_ids or getattr(run, "child_run_ids", None):
                skipped += 1
                continue
            if store.get_event(event_id):
                skipped += 1
                continue
            metadata = ((run.extra or {}).get("metadata") or {})
            params = (run.extra or {}).get("invocation_params") or {}
            model = str(metadata.get("ls_model_name") or params.get("model") or params.get("model_name") or run.name)
            provider = str(metadata.get("ls_provider") or ("openai" if model.startswith(("gpt-", "o1", "o3", "o4")) else "anthropic" if "claude" in model else "unknown"))
            store.begin({"id": event_id, "request_id": str(run.trace_id or run.id), "parent_id": str(run.parent_run_id) if run.parent_run_id else None,
                "kind": "llm", "name": str(run.name), "model": model, "provider": provider,
                "user_id": str(metadata.get("user_id") or metadata.get("owner_id") or ""),
                "user_email": "", "started_at": run.start_time.timestamp(), "source": "langsmith",
                "metadata": {"project": project, "historical": True, "trace_url": run.url or ""}})
            if run.end_time:
                usage = None
                if run.prompt_tokens is not None and run.completion_tokens is not None:
                    usage = {"input_tokens": run.prompt_tokens, "output_tokens": run.completion_tokens, "cached_tokens": 0}
                cost = getattr(run, "total_cost", None)
                store.finish(event_id, status="error" if run.error else "success", error=run.error, error_type="LangSmithError" if run.error else "",
                    usage=usage, service_tier="historical-unknown" if cost is None else "", reported_cost=float(cost) if cost is not None else None,
                    ended_at=run.end_time.timestamp())
            imported += 1
    finally:
        client.close()
    return {"imported": imported, "skipped": skipped, "limit": limit, "capped": imported + skipped >= limit, "project": project}

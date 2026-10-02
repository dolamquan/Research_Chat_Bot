"""ASGI tracing and LangChain callbacks. Telemetry must never break a request."""
from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
from contextvars import ContextVar
from uuid import uuid4

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.tracers.context import register_configure_hook

from app.auth.context import current_user, reset_current_user, set_current_user
from app.ops import store

logger = logging.getLogger(__name__)
request_id: ContextVar[str] = ContextVar("ops_request_id", default="")
parent_id: ContextVar[str] = ContextVar("ops_parent_id", default="")
_callback: ContextVar[BaseCallbackHandler | None] = ContextVar("ops_callback", default=None)
_installed = False


def safe(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception:
        # Do not include exception text, which may contain database credentials.
        logger.warning("Research Ops could not record telemetry (%s)", fn.__name__)
        return None


def enabled() -> bool:
    return os.getenv("OPS_TELEMETRY_ENABLED", "true").lower() in ("true", "1", "yes")


def start(kind: str, name: str, *, event_id="", provider="", model="", parent="", metadata=None) -> str:
    event_id = event_id or str(uuid4())
    user = current_user()
    safe(store.begin, {"id": event_id, "request_id": request_id.get() or event_id,
        "parent_id": parent or parent_id.get() or None, "kind": kind, "name": name,
        "provider": provider, "model": model, "user_id": user.id if user else "",
        "user_email": user.email if user else "", "metadata": metadata or {}})
    return event_id


class OperationsMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if not enabled() or scope["type"] not in ("http", "websocket") or path.startswith(("/ops", "/health", "/auth", "/docs", "/openapi", "/redoc")) or scope.get("method") == "OPTIONS":
            return await self.app(scope, receive, send)
        event_id = str(uuid4())
        outer = request_id.get()
        request_marker = request_id.set(outer or event_id)
        # A nested ASGI call keeps the original request and user context.
        user_marker = set_current_user(current_user() if outer else None)
        kind = "websocket" if scope["type"] == "websocket" else "http"
        method = scope.get("method", "WS")
        start(kind, f"{method} {path}", event_id=event_id)
        parent_marker = parent_id.set(event_id)
        status_code, error_body, ws_code = 200, bytearray(), 1000

        async def tracked_send(message):
            nonlocal status_code, ws_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                message = {**message, "headers": [*message.get("headers", []), (b"x-ops-request-id", (outer or event_id).encode())]}
            elif message["type"] == "http.response.body" and status_code >= 400 and len(error_body) < 2000:
                error_body.extend(message.get("body", b"")[:2000 - len(error_body)])
            elif message["type"] == "websocket.close":
                ws_code = message.get("code", 1000)
            await send(message)

        def final_name():
            route = scope.get("route")
            return f"{method} {getattr(route, 'path', path)}"

        def actor():
            return (scope.get("state") or {}).get("user") or current_user()

        try:
            await self.app(scope, receive, tracked_send)
            failed = status_code >= 400 or ws_code not in (1000, 1001)
            detail = ""
            if error_body:
                try:
                    payload = json.loads(error_body)
                    # Validation errors contain request inputs. Keep only validation types.
                    value = payload.get("detail", "") if isinstance(payload, dict) else ""
                    detail = "; ".join(str(x.get("type", "validation_error")) for x in value if isinstance(x, dict)) if isinstance(value, list) else str(value)
                except (ValueError, UnicodeDecodeError):
                    detail = "Request failed; inspect backend logs for details."
            safe(store.finish, event_id, status="error" if failed else "success", http_status=status_code if kind == "http" else ws_code,
                 error=detail or (f"HTTP {status_code}" if failed else ""), error_type=f"HTTP {status_code}" if kind == "http" and failed else "WebSocketClosed" if failed else "",
                 user=actor(), name=final_name())
        except asyncio.CancelledError:
            safe(store.finish, event_id, status="cancelled", user=actor(), name=final_name())
            raise
        except Exception as exc:
            safe(store.finish, event_id, status="error", error=exc, error_type=type(exc).__name__, http_status=500, user=actor(), name=final_name())
            raise
        finally:
            parent_id.reset(parent_marker)
            request_id.reset(request_marker)
            reset_current_user(user_marker)


def traced_tool(fn):
    """Track catalog tools without recording their arguments or results."""
    @functools.wraps(fn)
    def sync(name, *args, **kwargs):
        if not enabled():
            return fn(name, *args, **kwargs)
        event = start("tool", name)
        token = parent_id.set(event)
        try:
            result = fn(name, *args, **kwargs)
            safe(store.finish, event, user=current_user())
            return result
        except Exception as exc:
            safe(store.finish, event, status="error", error=exc, error_type=type(exc).__name__, user=current_user())
            raise
        finally:
            parent_id.reset(token)

    @functools.wraps(fn)
    async def async_wrapper(name, *args, **kwargs):
        if not enabled():
            return await fn(name, *args, **kwargs)
        event = start("tool", name)
        token = parent_id.set(event)
        try:
            result = await fn(name, *args, **kwargs)
            safe(store.finish, event, user=current_user())
            return result
        except asyncio.CancelledError:
            safe(store.finish, event, status="cancelled", user=current_user())
            raise
        except Exception as exc:
            safe(store.finish, event, status="error", error=exc, error_type=type(exc).__name__, user=current_user())
            raise
        finally:
            parent_id.reset(token)
    return async_wrapper if asyncio.iscoroutinefunction(fn) else sync


class OperationsCallback(BaseCallbackHandler):
    run_inline = True  # Preserve request context in async LangChain invocations.

    def on_chat_model_start(self, serialized, messages, *, run_id, parent_run_id=None, **kwargs):
        params = kwargs.get("invocation_params") or {}
        metadata = kwargs.get("metadata") or {}
        model = str(params.get("model") or params.get("model_name") or metadata.get("ls_model_name") or (serialized or {}).get("kwargs", {}).get("model_name") or "unknown")
        provider = str(metadata.get("ls_provider") or ("anthropic" if "claude" in model else "openai" if model.startswith(("gpt-", "o1", "o3", "o4")) else "unknown"))
        start("llm", model, event_id=str(run_id), provider=provider, model=model,
              metadata={"service_tier": str(params.get("service_tier") or ""), "langchain_parent_id": str(parent_run_id or "")})

    def on_llm_start(self, serialized, prompts, *, run_id, **kwargs):
        self.on_chat_model_start(serialized, [], run_id=run_id, **kwargs)

    def on_llm_end(self, response, *, run_id, **kwargs):
        usage, actual_model, tier = None, None, ""
        generations = response.generations or []
        # llm_output is aggregated for a batched request. Prefer it when present.
        output = response.llm_output or {}
        raw = output.get("token_usage") or {}
        if "prompt_tokens" in raw and "completion_tokens" in raw:
            usage = {"input_tokens": raw["prompt_tokens"], "output_tokens": raw["completion_tokens"], "cached_tokens": (raw.get("prompt_tokens_details") or {}).get("cached_tokens", 0)}
        for group in generations:
            for generation in group[:1]:
                message = getattr(generation, "message", None)
                meta = getattr(message, "response_metadata", {}) or {}
                actual_model = meta.get("model_name") or meta.get("model") or actual_model
                tier = meta.get("service_tier") or tier
        if usage is None:
            parts = [getattr(getattr(g, "message", None), "usage_metadata", None) for group in generations for g in group[:1]]
            if parts and all(p is not None and "input_tokens" in p and "output_tokens" in p for p in parts):
                # Cache-write and audio prices need separate rates. Leave them unpriced.
                unsupported = any((p.get("input_token_details") or {}).get("cache_creation") or (p.get("input_token_details") or {}).get("audio") or (p.get("output_token_details") or {}).get("audio") for p in parts)
                tier = "unsupported-modality" if unsupported else tier
                usage = {"input_tokens": sum(p["input_tokens"] for p in parts), "output_tokens": sum(p["output_tokens"] for p in parts),
                         "cached_tokens": sum((p.get("input_token_details") or {}).get("cache_read", 0) for p in parts)}
        # Respect nonstandard service tiers supplied at construction too.
        detail = safe(store.get_event, str(run_id))
        configured_tier = detail["metadata"].get("service_tier", "") if detail else ""
        safe(store.finish, str(run_id), usage=usage, model=actual_model, service_tier=tier or configured_tier, user=current_user())

    def on_llm_error(self, error, *, run_id, **kwargs):
        safe(store.finish, str(run_id), status="cancelled" if isinstance(error, asyncio.CancelledError) else "error", error=error, error_type=type(error).__name__, user=current_user())

    def on_tool_start(self, serialized, input_str, *, run_id, **kwargs):
        start("tool", (serialized or {}).get("name", "Tool"), event_id=str(run_id))

    def on_tool_end(self, output, *, run_id, **kwargs):
        safe(store.finish, str(run_id), user=current_user())

    def on_tool_error(self, error, *, run_id, **kwargs):
        self.on_llm_error(error, run_id=run_id)

    def on_retriever_start(self, serialized, query, *, run_id, **kwargs):
        start("retrieval", (serialized or {}).get("name", "Document retrieval"), event_id=str(run_id))

    def on_retriever_end(self, documents, *, run_id, **kwargs):
        safe(store.finish, str(run_id), user=current_user())

    def on_retriever_error(self, error, *, run_id, **kwargs):
        self.on_llm_error(error, run_id=run_id)


def install_callbacks():
    global _installed
    if _installed:
        return
    os.environ.setdefault("OPS_TELEMETRY_ENABLED", "true")
    register_configure_hook(_callback, True, OperationsCallback, "OPS_TELEMETRY_ENABLED")
    _installed = True

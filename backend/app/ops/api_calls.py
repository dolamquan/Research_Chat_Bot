"""Small SDK-independent adapter for current and future API integrations."""
from __future__ import annotations

import asyncio
import math
from uuid import uuid4

from app.auth.context import current_user
from app.ops import services, store
from app.ops.telemetry import parent_id, request_id, safe


class api_call:
    """Use with `with` or `async with`; call measure() with provider usage.

    Operation is a static label, never a URL, prompt, user input or payload.
    Do not wrap an already traced LangChain chat invocation (double counting).
    """

    def __init__(self, api_id: str, operation: str, *, model: str = ""):
        self.id = str(uuid4())
        self.api_id, self.operation, self.model = api_id, operation, model
        self.units = self.cost = self.usage = self.http_status = None
        self.service_tier = ""
        self.marker = None

    def __enter__(self):
        user = current_user()
        services.admit({"id": self.id, "api_id": self.api_id, "request_id": request_id.get() or self.id,
                        "parent_id": parent_id.get() or None, "kind": "api", "name": self.operation,
                        "model": self.model, "user_id": user.id if user else "", "user_email": user.email if user else ""})
        self.marker = parent_id.set(self.id)
        return self

    def measure(self, *, units=None, reported_cost=None, usage=None, http_status=None, service_tier=""):
        for number in (units, reported_cost):
            if number is not None and (not math.isfinite(number) or number < 0):
                raise ValueError("Usage and cost must be finite and nonnegative.")
        if usage is not None:
            if any(not math.isfinite(v) or v < 0 for v in usage.values()):
                raise ValueError("Token usage must be finite and nonnegative.")
            if "input_tokens" not in usage or "output_tokens" not in usage:
                raise ValueError("Provide input_tokens and output_tokens (zero when unused).")
        self.units, self.cost, self.usage, self.http_status = units, reported_cost, usage, http_status
        self.service_tier = service_tier

    def __exit__(self, exc_type, exc, tb):
        failed = exc is not None or (self.http_status is not None and self.http_status >= 400)
        status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "error" if failed else "success"
        try:
            safe(store.finish, self.id, status=status, error=exc or (f"HTTP {self.http_status}" if failed else ""),
                 error_type=exc_type.__name__ if exc_type else f"HTTP {self.http_status}" if failed else "",
                 usage=self.usage, units=self.units, reported_cost=self.cost, http_status=self.http_status,
                 service_tier=self.service_tier, cost_source="provider" if self.cost is not None else "", user=current_user())
        finally:
            parent_id.reset(self.marker)
        return False

    async def __aenter__(self):
        return self.__enter__()

    async def __aexit__(self, *args):
        return self.__exit__(*args)


def call_api(api_id, operation, fn, *args, **kwargs):
    """Instrument one requests/SDK invocation; keep its return type intact.

    With streaming responses this records time to response headers. Wrap the
    entire consumption in api_call instead when duration/units matter.
    """
    with api_call(api_id, operation) as call:
        response = fn(*args, **kwargs)
        status = getattr(response, "status_code", None)
        call.measure(http_status=status if isinstance(status, int) else None)
        return response

"""Coalesce simultaneous scene builds in this server process."""
import json
from concurrent.futures import Future
from functools import wraps
from inspect import signature
from threading import Lock


def _freeze(name, value):
    """A hashable stand-in for one argument.

    The model client is identified by object, and structured arguments such
    as a layout report (a dict of overlapping label pairs) by their canonical
    JSON, so two identical repair requests still share one model call.
    """
    if name == "llm":
        return id(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, default=str)
    return value


def share_scene_request(build):
    pending = {}
    lock = Lock()
    parameters = signature(build)

    @wraps(build)
    def shared(*args, **kwargs):
        bound = parameters.bind(*args, **kwargs)
        bound.apply_defaults()
        key = tuple((name, _freeze(name, value))
                    for name, value in bound.arguments.items())
        with lock:
            future = pending.get(key)
            owner = future is None
            if owner:
                future = pending[key] = Future()
        if not owner:
            return future.result()
        try:
            result = build(*args, **kwargs)
            future.set_result(result)
            return result
        except BaseException as error:
            future.set_exception(error)
            raise
        finally:
            with lock:
                pending.pop(key, None)

    return shared

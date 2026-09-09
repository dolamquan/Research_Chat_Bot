"""Coalesce simultaneous scene builds in this server process."""
from concurrent.futures import Future
from functools import wraps
from inspect import signature
from threading import Lock


def share_scene_request(build):
    pending = {}
    lock = Lock()
    parameters = signature(build)

    @wraps(build)
    def shared(*args, **kwargs):
        bound = parameters.bind(*args, **kwargs)
        bound.apply_defaults()
        key = tuple((name, id(value) if name == "llm" else value)
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

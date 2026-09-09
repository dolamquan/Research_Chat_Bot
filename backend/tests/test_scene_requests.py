from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, Lock
import time

import pytest

from app.rag.scene_requests import share_scene_request


def test_simultaneous_builds_share_one_call():
    start = Barrier(5)
    release = Event()
    entered = Event()
    count = 0
    lock = Lock()

    @share_scene_request
    def build(viz_id, node_id, force=False):
        nonlocal count
        with lock:
            count += 1
        entered.set()
        assert release.wait(2)
        return {'node': node_id}

    def caller():
        start.wait()
        return build('viz', 'norm')

    with ThreadPoolExecutor(max_workers=5) as pool:
        jobs = [pool.submit(caller) for _ in range(5)]
        assert entered.wait(2)
        time.sleep(0.05)
        release.set()
        results = [job.result() for job in jobs]
    assert count == 1
    assert all(result is results[0] for result in results)


def test_failed_build_does_not_poison_retry():
    calls = 0

    @share_scene_request
    def build(node_id):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ValueError('provider failed')
        return node_id

    with pytest.raises(ValueError):
        build('norm')
    assert build('norm') == 'norm'
    assert calls == 2

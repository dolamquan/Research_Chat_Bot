"""Offline live transcription transport tests."""
import asyncio
import base64
import json
import threading
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from app.agents.assistant import transcription as stt


class Provider:
    def __init__(self):
        self.events = asyncio.Queue()
        self.sent = []
        self.closed = threading.Event()
        self.started = threading.Event()
        self.error = None

    async def send(self, data):
        event = json.loads(data)
        self.sent.append(event)
        if event["type"] == "session.update":
            await self.events.put(self.error or {"type": "session.updated"})
        elif event["type"] == "input_audio_buffer.commit":
            for event in [
                {"type": "input_audio_buffer.committed", "item_id": "i1"},
                {"type": "conversation.item.input_audio_transcription.delta", "item_id": "i1", "delta": "Hello"},
                {"type": "conversation.item.input_audio_transcription.completed", "item_id": "i1", "transcript": "Hello."},
            ]:
                await self.events.put(event)

    async def recv(self):
        return json.dumps(await self.events.get())

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.recv()


@pytest.fixture
def bridge(monkeypatch):
    provider = Provider()
    monkeypatch.setenv("AUTH_MODE", "disabled")
    monkeypatch.setenv("OPENAI_API_KEY", "server-secret")

    @asynccontextmanager
    async def connect(url, **kwargs):
        assert url == stt.REALTIME_URL
        assert kwargs["additional_headers"]["Authorization"] == "Bearer server-secret"
        provider.started.set()
        try:
            yield provider
        finally:
            provider.closed.set()

    monkeypatch.setattr(stt, "connect", connect)
    app = FastAPI()

    @app.websocket("/transcribe")
    async def endpoint(ws: WebSocket):
        await ws.accept()
        await stt.TranscriptionConnection(ws).serve()

    with TestClient(app) as client:
        yield client, provider


def test_audio_commit_transcripts_and_disconnect(bridge):
    client, provider = bridge
    audio = b"\x01\x00" * 2400
    with client.websocket_connect("/transcribe") as ws:
        ws.send_json({"type": "hello", "token": ""})
        assert ws.receive_json() == {"type": "ready", "model": "gpt-live-transcribe"}
        ws.send_json({"type": "ping"})
        ws.send_bytes(audio)
        ws.send_json({"type": "commit"})
        assert ws.receive_json()["type"] == "input_audio_buffer.committed"
        assert ws.receive_json()["delta"] == "Hello"
        assert ws.receive_json()["transcript"] == "Hello."
    assert provider.closed.wait(2)
    assert base64.b64decode(provider.sent[1]["audio"]) == audio
    config = provider.sent[0]["session"]["audio"]["input"]
    assert config["turn_detection"] is None
    assert config["transcription"]["model"] == "gpt-live-transcribe"
    assert "language" not in config["transcription"]


def test_authentication_before_paid_connection(bridge, monkeypatch):
    client, provider = bridge
    monkeypatch.setenv("AUTH_MODE", "supabase")
    with client.websocket_connect("/transcribe") as ws:
        ws.send_json({"type": "hello", "token": ""})
        assert ws.receive_json()["code"] == "unauthorized"
    assert not provider.started.is_set()


def test_missing_key_stops_retries(bridge, monkeypatch):
    client, provider = bridge
    monkeypatch.delenv("OPENAI_API_KEY")
    with client.websocket_connect("/transcribe") as ws:
        ws.send_json({"type": "hello"})
        error = ws.receive_json()
        assert error["code"] == "provider" and error["retryable"] is False
    assert not provider.started.is_set()


@pytest.mark.parametrize("payload", [b"\x00", bytes(stt.MAX_AUDIO_BYTES + 2), b""], ids=["odd", "oversized", "empty"])
def test_invalid_pcm_is_rejected(bridge, payload):
    client, provider = bridge
    with client.websocket_connect("/transcribe") as ws:
        ws.send_json({"type": "hello"})
        ws.receive_json()
        ws.send_bytes(payload)
        assert ws.receive_json()["code"] == "bad_message"
    assert not any(e["type"] == "input_audio_buffer.append" for e in provider.sent)


def test_provider_error_is_sanitized(bridge):
    client, provider = bridge
    provider.error = {"type": "error", "error": {"code": "invalid_api_key", "message": "server-secret"}}
    with client.websocket_connect("/transcribe") as ws:
        ws.send_json({"type": "hello"})
        error = ws.receive_json()
        assert error["retryable"] is False
        assert "server-secret" not in json.dumps(error)
    assert provider.closed.wait(2)


def test_disconnect_cancels_provider_setup(bridge, monkeypatch):
    client, provider = bridge

    @asynccontextmanager
    async def blocked(*args, **kwargs):
        provider.started.set()
        try:
            await asyncio.Event().wait()
            yield provider
        finally:
            provider.closed.set()

    monkeypatch.setattr(stt, "connect", blocked)
    with client.websocket_connect("/transcribe") as ws:
        ws.send_json({"type": "hello"})
        assert provider.started.wait(2)
    assert provider.closed.wait(2)

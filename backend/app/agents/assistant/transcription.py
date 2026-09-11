"""Authenticated PCM audio bridge to OpenAI's live transcription session.

Audio and transcripts are relayed in memory only. The browser supplies its
application token, never a provider key or arbitrary provider configuration.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from contextlib import suppress

from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from app.auth.deps import AuthError, authenticate_token

logger = logging.getLogger(__name__)
MODEL = "gpt-live-transcribe"
REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription"
MAX_AUDIO_BYTES = 24000  # Half a second of PCM16 mono at 24 kHz.


class TranscriptionError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool = False):
        self.code, self.message, self.retryable = code, message, retryable


def session_update() -> dict:
    delay = os.getenv("ASSISTANT_TRANSCRIPTION_DELAY", "low").strip() or "low"
    if delay not in {"minimal", "low", "medium", "high", "xhigh"}:
        delay = "low"
    languages = [s.strip() for s in os.getenv("ASSISTANT_TRANSCRIPTION_LANGUAGES", "en").split(",") if s.strip()]
    return {
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {"input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "transcription": {
                    "model": MODEL, "delay": delay, "languages": languages,
                    "prompt": "Commands to a research assistant named Zoetrope. Research papers, machine learning and scientific terminology.",
                    "keywords": ["Zoetrope", "Zoe", "RAG", "arXiv", "Qdrant"],
                },
                "turn_detection": None,
            }},
        },
    }


class TranscriptionConnection:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.upstream = None

    async def serve(self) -> None:
        tasks: list[asyncio.Task] = []
        try:
            hello = await asyncio.wait_for(self.ws.receive_json(), 10)
            if not isinstance(hello, dict) or hello.get("type") != "hello" or not isinstance(hello.get("token", ""), str):
                raise TranscriptionError("bad_message", "Expected an authentication hello.")
            await authenticate_token(hello.get("token", ""))
            key = os.getenv("OPENAI_API_KEY", "").strip()
            if not key:
                raise TranscriptionError("provider", "Voice transcription is not configured on the server.")
            # Receiving starts during provider setup so disconnect/mute cancels it.
            tasks = [asyncio.create_task(self._receive_audio()), asyncio.create_task(self._transcribe(key))]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except AuthError:
            await self._error("unauthorized", "Sign in again to use voice input.")
        except TranscriptionError as exc:
            await self._error(exc.code, exc.message, exc.retryable)
        except (WebSocketDisconnect, RuntimeError):
            pass
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            await self._error("bad_message", "Invalid transcription message.")
        except InvalidStatus as exc:
            status = exc.response.status_code
            logger.warning("Transcription provider rejected connection (HTTP %s)", status)
            await self._error("provider", "Voice service is unavailable. Check the server's OpenAI access and billing.", status >= 500)
        except Exception as exc:
            # Do not log raw exception bodies, tokens, transcripts or audio.
            logger.warning("Transcription connection failed (%s)", type(exc).__name__)
            await self._error("network", "Speech recognition lost its connection.", True)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            with suppress(Exception):
                await self.ws.close()

    async def _error(self, code: str, message: str, retryable: bool = False) -> None:
        with suppress(Exception):
            await self.ws.send_json({"type": "error", "code": code, "message": message, "retryable": retryable})

    async def _receive_audio(self) -> None:
        buffered_bytes = 0
        while True:
            message = await asyncio.wait_for(self.ws.receive(), 30)
            if message["type"] == "websocket.disconnect":
                return
            text = message.get("text")
            if text is not None:
                if len(text) > 128:
                    raise TranscriptionError("bad_message", "Transcription control message is too large.")
                frame = json.loads(text)
                if isinstance(frame, dict) and frame.get("type") == "ping":
                    continue
                if isinstance(frame, dict) and frame.get("type") == "commit" and self.upstream is not None and buffered_bytes >= 4800:
                    await self.upstream.send(json.dumps({"type": "input_audio_buffer.commit"}))
                    buffered_bytes = 0
                    continue
                raise TranscriptionError("bad_message", "Invalid transcription control message.")
            audio = message.get("bytes")
            if not isinstance(audio, bytes) or not audio or len(audio) > MAX_AUDIO_BYTES or len(audio) % 2:
                raise TranscriptionError("bad_message", "Expected a small PCM16 audio chunk.")
            if self.upstream is None:
                raise TranscriptionError("bad_message", "Wait for the transcription session to be ready.")
            await self.upstream.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(audio).decode("ascii")}))
            buffered_bytes += len(audio)
            if buffered_bytes > 48000 * 30:
                raise TranscriptionError("bad_message", "Audio turns must be committed within 30 seconds.")

    async def _transcribe(self, key: str) -> None:
        async with connect(REALTIME_URL, additional_headers={"Authorization": f"Bearer {key}"},
                           open_timeout=10, close_timeout=2, max_size=1_000_000, max_queue=16) as upstream:
            await upstream.send(json.dumps(session_update()))
            async with asyncio.timeout(10):
                while True:
                    event = json.loads(await upstream.recv())
                    self._check_error(event)
                    if event.get("type") == "session.updated":
                        break
            self.upstream = upstream
            await self.ws.send_json({"type": "ready", "model": MODEL})
            async for raw in upstream:
                event = json.loads(raw)
                self._check_error(event)
                kind = event.get("type", "")
                # Keep IDs so clients can reconcile partials and out-of-order finals.
                if kind in {
                    "input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped",
                    "input_audio_buffer.committed", "conversation.item.input_audio_transcription.delta",
                    "conversation.item.input_audio_transcription.completed",
                }:
                    await self.ws.send_json({k: event[k] for k in (
                        "type", "item_id", "previous_item_id", "delta", "transcript",
                    ) if k in event})
            raise TranscriptionError("network", "Speech recognition lost its connection.", retryable=True)

    @staticmethod
    def _check_error(event: dict) -> None:
        if event.get("type") in {"error", "conversation.item.input_audio_transcription.failed"}:
            code = (event.get("error") or {}).get("code", "unknown")
            logger.warning("Transcription provider error code: %s", code)
            raise TranscriptionError("provider", "Voice service could not transcribe audio. Check the server's OpenAI access, billing and transcription settings.")

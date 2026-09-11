"""The always-present assistant's websocket.

Mounted without the router-level sign-in dependency (that dependency takes a
`Request`; websockets do not have one). The connection authenticates the
first frame instead, so the rule "no route ships unprotected" still holds.
"""
from fastapi import APIRouter, WebSocket

from app.agents.assistant.connection import AssistantConnection
from app.agents.assistant.transcription import TranscriptionConnection

router = APIRouter(prefix="/agent", tags=["agent"])


@router.websocket("/ws")
async def assistant_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    await AssistantConnection(websocket).serve()


@router.websocket("/transcribe")
async def transcription_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    await TranscriptionConnection(websocket).serve()

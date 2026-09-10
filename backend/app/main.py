import os

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from app.auth import routes as auth_routes
from app.auth.deps import get_current_user
from app.routes import (
    agent_chat,
    annotations,
    articles,
    chat,
    clusters,
    crawler,
    documents,
    evaluate,
    graph_rag,
    ingest,
    mcp_bridge,
    notes,
    upload,
    variants,
    visualizer,
    visuals,
)


load_dotenv()

app = FastAPI(
    title="Mini Chatbot API",
    description="A document-grounded RAG chatbot backed by Qdrant.",
    version="0.1.0",
)

# In development the Vite proxy makes API calls same-origin; these origins
# cover a browser talking to :8002 directly. Bearer tokens, not cookies, carry
# identity, so credentials support is only needed for that header.
_cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Every feature router requires a signed-in user. Applying it here, rather
# than per route, means a new endpoint cannot ship unprotected by accident.
SIGNED_IN = [Depends(get_current_user)]

for router in (
    chat.router,
    agent_chat.router,
    annotations.router,
    articles.router,
    clusters.router,
    crawler.router,
    documents.router,
    evaluate.router,
    graph_rag.router,
    ingest.router,
    mcp_bridge.router,
    notes.router,
    upload.router,
    variants.router,
    visualizer.router,
    visuals.router,
):
    app.include_router(router, dependencies=SIGNED_IN)

app.include_router(auth_routes.router)


@app.get("/health")
def health_check():
    return {"status": "ok"}


from app.agents.catalog import configure_application_tools

configure_application_tools(app)

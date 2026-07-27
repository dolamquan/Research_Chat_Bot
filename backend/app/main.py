from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import chat, clusters, documents, evaluate, upload


app = FastAPI(
    title="Mini Chatbot API",
    description="A document-grounded RAG chatbot backed by Qdrant.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(clusters.router)
app.include_router(documents.router)
app.include_router(evaluate.router)
app.include_router(upload.router)


@app.get("/health")
def health_check():
    return {"status": "ok"}

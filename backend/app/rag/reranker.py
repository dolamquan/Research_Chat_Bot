from typing import Any, Dict, List

import torch
from sentence_transformers import CrossEncoder


MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
CROSS_ENCODER_BATCH_SIZE = 16

_model = None


def get_device() -> str:
    """
    Use GPU when CUDA is available, otherwise fall back to CPU.
    """
    return "cuda" if torch.cuda.is_available() else "cpu"


def get_model() -> CrossEncoder:
    """
    Load the cross-encoder only when reranking is first used.
    """
    global _model

    if _model is None:
        _model = CrossEncoder(MODEL_NAME, device=get_device())

    return _model


def rerank_chunks(
    query: str,
    chunks: List[Dict[str, Any]],
    top_n: int = 5,
) -> List[Dict[str, Any]]:
    """
    Rerank retrieved chunks using a local cross-encoder relevance model.
    """
    if not chunks:
        return []

    pairs = [
        (query, chunk.get("text", ""))
        for chunk in chunks
    ]

    scores = get_model().predict(
        pairs,
        batch_size=CROSS_ENCODER_BATCH_SIZE,
    )

    reranked_chunks = [
        {
            **chunk,
            "rerank_score": float(score),
        }
        for chunk, score in zip(chunks, scores)
    ]

    reranked_chunks.sort(
        key=lambda chunk: chunk["rerank_score"],
        reverse=True,
    )

    return reranked_chunks[:top_n]


def rerank_chunks_parallel(
    query: str,
    chunks: List[Dict[str, Any]],
    top_n: int = 5,
    max_workers: int = 3,
) -> List[Dict[str, Any]]:
    """
    Compatibility wrapper.

    Cross-encoders score pairs in efficient batches, so thread-level parallelism
    is not needed here.
    """
    return rerank_chunks(
        query=query,
        chunks=chunks,
        top_n=top_n,
    )

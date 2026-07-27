from typing import List

import torch
from sentence_transformers import SentenceTransformer


MODEL_NAME = "all-MiniLM-L6-v2"

_model = None


def get_device() -> str:
    """
    Use GPU when CUDA is available, otherwise fall back to CPU.
    """
    return "cuda" if torch.cuda.is_available() else "cpu"


def get_model() -> SentenceTransformer:
    """
    Load the embedding model only when it is first needed.
    """
    global _model

    if _model is None:
        _model = SentenceTransformer(MODEL_NAME, device=get_device())

    return _model


def embed_text(text: str) -> List[float]:
    """
    Convert one text string into one embedding vector.
    """
    vector = get_model().encode(text)
    return vector.tolist()


def embed_texts(texts: List[str]) -> List[List[float]]:
    """
    Convert multiple text strings into embedding vectors.
    """
    vectors = get_model().encode(texts)
    return vectors.tolist()


def get_embedding_dimension() -> int:
    """
    Return the vector size for the embedding model.

    all-MiniLM-L6-v2 returns 384-dimensional vectors.
    """
    return get_model().get_sentence_embedding_dimension()

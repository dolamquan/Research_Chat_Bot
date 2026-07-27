import re
from pathlib import Path
from typing import List
from uuid import uuid4

from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.rag.embedder import get_model


SEMANTIC_MIN_CHUNK_CHARS = 500
SEMANTIC_MAX_CHUNK_CHARS = 1800
SEMANTIC_SIMILARITY_THRESHOLD = 0.5


child_splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=75,
    separators=["\n\n", "\n", ". ", " ", ""],
)

fallback_parent_splitter = RecursiveCharacterTextSplitter(
    chunk_size=SEMANTIC_MAX_CHUNK_CHARS,
    chunk_overlap=200,
    separators=["\n\n", "\n", ". ", " ", ""],
)


def load_pdf(file_path):
    loader = PyPDFLoader(file_path)
    return loader.load()


def _clean_text(text: str) -> str:
    """
    Normalize whitespace from PDF extraction while preserving paragraph breaks.
    """
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _split_sentences(text: str) -> List[str]:
    """
    Split text into sentence-ish units for semantic grouping.
    """
    text = _clean_text(text)

    if not text:
        return []

    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", text)

    clean_sentences = []

    for sentence in sentences:
        sentence = str(sentence).replace("\x00", " ").strip()

        if sentence:
            clean_sentences.append(sentence)

    return clean_sentences


def _cosine_similarity(vector_a, vector_b) -> float:
    """
    Embeddings are normalized before this is called, so dot product is cosine.
    """
    return float(vector_a @ vector_b)


def semantic_parent_chunks(document_text: str) -> List[str]:
    """
    Create parent chunks by grouping neighboring sentences with similar meaning.
    """
    sentences = _split_sentences(document_text)

    if not sentences:
        return []

    if len(sentences) == 1:
        return fallback_parent_splitter.split_text(sentences[0])

    try:
        embeddings = get_model().encode(
            sentences,
            batch_size=32,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
    except TypeError as error:
        print(f"Semantic chunking failed, using fallback chunking: {error}")
        return fallback_parent_splitter.split_text(document_text)

    chunks = []
    current_sentences = []
    current_length = 0

    for index, sentence in enumerate(sentences):
        current_sentences.append(sentence)
        current_length += len(sentence) + 1

        is_last_sentence = index == len(sentences) - 1
        next_similarity = 1.0

        if not is_last_sentence:
            next_similarity = _cosine_similarity(
                embeddings[index],
                embeddings[index + 1],
            )

        should_split_for_size = current_length >= SEMANTIC_MAX_CHUNK_CHARS
        should_split_for_topic = (
            current_length >= SEMANTIC_MIN_CHUNK_CHARS
            and next_similarity < SEMANTIC_SIMILARITY_THRESHOLD
        )

        if is_last_sentence or should_split_for_size or should_split_for_topic:
            chunk_text = " ".join(current_sentences).strip()

            if len(chunk_text) > SEMANTIC_MAX_CHUNK_CHARS:
                chunks.extend(fallback_parent_splitter.split_text(chunk_text))
            else:
                chunks.append(chunk_text)

            current_sentences = []
            current_length = 0

    return [
        chunk
        for chunk in chunks
        if chunk.strip()
    ]


def parent_child_chunks(
    document_text: str,
    document_id: str,
    source: str | None = None,
):
    parent_texts = semantic_parent_chunks(document_text)
    parent_records = []
    child_records = []

    for parent_index, parent_text in enumerate(parent_texts):
        parent_id = str(uuid4())
        parent_records.append({
            "parent_id": parent_id,
            "document_id": document_id,
            "parent_index": parent_index,
            "source": source,
            "text": parent_text,
        })

        child_texts = child_splitter.split_text(parent_text)

        for child_index, child_text in enumerate(child_texts):
            child_records.append({
                "child_id": str(uuid4()),
                "parent_id": parent_id,
                "document_id": document_id,
                "parent_index": parent_index,
                "child_index": child_index,
                "source": source,
                "text": child_text,
            })

    return parent_records, child_records


def load_and_chunk_pdf(file_path):
    documents = load_pdf(file_path)
    full_text = "\n\n".join(
        doc.page_content
        for doc in documents
    )
    source = Path(file_path).name
    document_id = str(uuid4())

    return parent_child_chunks(
        document_text=full_text,
        document_id=document_id,
        source=source,
    )

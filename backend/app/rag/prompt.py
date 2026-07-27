from typing import Any, Dict, List


SYSTEM_INSTRUCTIONS = """
You are a helpful research assistant for a document-based chatbot.

Answer the user's question using only the provided source context.
If the user selected or pinned sources, treat those sources as the most important context.
For follow-up questions such as "this source", "these things", "it", or "they", use the selected sources and recent conversation to resolve what the user means.
If the source context does not contain enough information, say what is missing instead of guessing.
Do not invent facts or cite information that is not in the context.
Keep the answer clear, concise, and grounded in the documents.
""".strip()


def _chunk_label(index: int) -> str:
    return f"Chunk {index + 1}"


def format_chunk(chunk: Dict[str, Any], index: int) -> str:
    """
    Format one retrieved chunk for the prompt context.
    """
    label = _chunk_label(index)
    text = chunk.get("text", "").strip()
    score = chunk.get("rerank_score", chunk.get("score"))
    topic = chunk.get("topic", "unknown")
    section_type = chunk.get("section_type", "unknown")
    summary = chunk.get("summary", "")

    metadata_lines = [
        f"topic: {topic}",
        f"section_type: {section_type}",
    ]

    if score is not None:
        metadata_lines.append(f"score: {score}")

    if summary:
        metadata_lines.append(f"summary: {summary}")

    metadata = "\n".join(metadata_lines)

    return f"""
[{label}]
{metadata}

text:
{text}
""".strip()


def format_context(chunks: List[Dict[str, Any]], label: str = "Retrieved source") -> str:
    """
    Format retrieved/reranked chunks into one context block.
    """
    if not chunks:
        return f"No {label.lower()}s were provided."

    formatted_chunks = [
        format_chunk(chunk, index).replace("[Chunk", f"[{label}")
        for index, chunk in enumerate(chunks)
    ]

    return "\n\n---\n\n".join(formatted_chunks)


def format_pinned_sources(pinned_sources: List[Dict[str, Any]]) -> str:
    """
    Format sources the user explicitly pulled into the conversation.
    """
    if not pinned_sources:
        return "No pinned sources."

    return format_context(pinned_sources, label="Selected source")


def format_chat_history(chat_history: List[Dict[str, str]], max_turns: int = 6) -> str:
    """
    Format recent conversation turns for the final answer prompt.
    """
    if not chat_history:
        return "No prior conversation."

    recent_history = chat_history[-max_turns:]
    formatted_turns = []

    for turn in recent_history:
        role = turn.get("role", "user").strip().lower()
        content = turn.get("content", "").strip()

        if not content:
            continue

        if role not in {"user", "assistant"}:
            role = "user"

        formatted_turns.append(f"{role.title()}: {content}")

    if not formatted_turns:
        return "No prior conversation."

    return "\n".join(formatted_turns)


def build_rag_prompt(
    query: str,
    chunks: List[Dict[str, Any]],
    chat_history: List[Dict[str, str]] | None = None,
    pinned_sources: List[Dict[str, Any]] | None = None,
    context_label: str = "Retrieved source",
) -> str:
    """
    Build the final prompt sent to the answer-generating LLM.
    """
    context = format_context(chunks, label=context_label)
    history = format_chat_history(chat_history or [])
    pinned_context = format_pinned_sources(pinned_sources or [])

    return f"""
{SYSTEM_INSTRUCTIONS}

Recent conversation:
{history}

Pinned sources selected by the user:
{pinned_context}

Retrieved source context:
{context}

User question:
{query}

Answer:
""".strip()


def build_no_context_response() -> str:
    """
    Standard fallback when retrieval returns no usable chunks.
    """
    return "I do not know based on the provided documents."

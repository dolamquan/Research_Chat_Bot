import json
import re
import time
from datetime import datetime
from pathlib import Path
from statistics import mean
from typing import Any, Dict, List

from app.rag.generator import generate_answer, get_llm


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
DEFAULT_DATASET_PATH = BASE_DIR / "evaluation" / "eval_dataset.json"
EVALUATION_RUNS_DIR = DATA_DIR / "evaluation_runs"


def _get_llm_text(response: Any) -> str:
    if hasattr(response, "content"):
        return response.content
    return str(response)


def _extract_json(text: str) -> Dict[str, Any]:
    text = text.strip()

    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).strip()
        text = re.sub(r"```$", "", text).strip()

    start = text.find("{")
    if start == -1:
        raise ValueError(f"No JSON object found in LLM response: {text}")

    decoder = json.JSONDecoder()
    json_obj, _ = decoder.raw_decode(text[start:])

    if not isinstance(json_obj, dict):
        raise ValueError(f"Expected JSON object in LLM response: {text}")

    return json_obj


def _clamp_score(value: Any) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        score = 0.0

    return max(0.0, min(score, 1.0))


def load_eval_dataset(path: Path = DEFAULT_DATASET_PATH) -> List[Dict[str, str]]:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def build_context_text(sources: List[Dict[str, Any]]) -> str:
    context_blocks = []

    for index, source in enumerate(sources, start=1):
        context_blocks.append(
            f"[Context {index}]\n"
            f"topic: {source.get('topic', 'unknown')}\n"
            f"section_type: {source.get('section_type', 'unknown')}\n"
            f"text: {source.get('text', '')}"
        )

    return "\n\n---\n\n".join(context_blocks)


def judge_rag_answer(
    question: str,
    answer: str,
    expected_answer: str,
    sources: List[Dict[str, Any]],
    judge_llm: Any,
) -> Dict[str, Any]:
    """
    Use an LLM judge to score answer quality against expected answer and context.
    """
    context = build_context_text(sources)

    prompt = f"""
You are evaluating a retrieval-augmented generation system.

Return exactly one JSON object with this schema:
{{
  "answer_correctness": 0.0,
  "faithfulness": 0.0,
  "context_relevance": 0.0,
  "overall": 0.0,
  "feedback": "short explanation"
}}

Scoring:
- answer_correctness: Does the answer match the expected answer?
- faithfulness: Is the answer supported by the retrieved context?
- context_relevance: Are the retrieved contexts useful for the question?
- overall: Overall RAG quality for this example.

All scores must be between 0 and 1.
Return only JSON. Do not include markdown or extra text.

Question:
{question}

Expected answer:
{expected_answer}

Generated answer:
{answer}

Retrieved context:
{context}
"""

    response = judge_llm.invoke(prompt)
    data = _extract_json(_get_llm_text(response))

    return {
        "answer_correctness": _clamp_score(data.get("answer_correctness")),
        "faithfulness": _clamp_score(data.get("faithfulness")),
        "context_relevance": _clamp_score(data.get("context_relevance")),
        "overall": _clamp_score(data.get("overall")),
        "feedback": str(data.get("feedback", "")).strip(),
    }


def evaluate_case(
    case: Dict[str, str],
    rag_llm: Any,
    judge_llm: Any,
    retrieval_limit: int,
    context_limit: int,
    use_reranking: bool,
    parallel_reranking: bool,
    rerank_workers: int,
) -> Dict[str, Any]:
    start = time.perf_counter()

    rag_result = generate_answer(
        query=case["question"],
        llm=rag_llm,
        retrieval_limit=retrieval_limit,
        context_limit=context_limit,
        use_reranking=use_reranking,
        parallel_reranking=parallel_reranking,
        rerank_workers=rerank_workers,
    )

    latency_seconds = time.perf_counter() - start
    sources = rag_result.get("sources", [])

    judge_result = judge_rag_answer(
        question=case["question"],
        answer=rag_result["answer"],
        expected_answer=case["expected_answer"],
        sources=sources,
        judge_llm=judge_llm,
    )

    return {
        "id": case.get("id", case["question"]),
        "question": case["question"],
        "expected_answer": case["expected_answer"],
        "generated_answer": rag_result["answer"],
        "sources": sources,
        "latency_seconds": round(latency_seconds, 3),
        "source_count": len(sources),
        "judge": judge_result,
    }


def summarize_results(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not results:
        return {
            "case_count": 0,
            "average_latency_seconds": 0.0,
            "average_answer_correctness": 0.0,
            "average_faithfulness": 0.0,
            "average_context_relevance": 0.0,
            "average_overall": 0.0,
        }

    return {
        "case_count": len(results),
        "average_latency_seconds": round(mean(result["latency_seconds"] for result in results), 3),
        "average_answer_correctness": round(mean(result["judge"]["answer_correctness"] for result in results), 3),
        "average_faithfulness": round(mean(result["judge"]["faithfulness"] for result in results), 3),
        "average_context_relevance": round(mean(result["judge"]["context_relevance"] for result in results), 3),
        "average_overall": round(mean(result["judge"]["overall"] for result in results), 3),
    }


def save_evaluation_run(results: List[Dict[str, Any]], summary: Dict[str, Any]) -> Path:
    EVALUATION_RUNS_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = EVALUATION_RUNS_DIR / f"rag_eval_{timestamp}.json"

    payload = {
        "summary": summary,
        "results": results,
    }

    with output_path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, indent=2)

    return output_path


def run_evaluation(
    dataset_path: Path = DEFAULT_DATASET_PATH,
    model: str = "gpt-4o-mini",
    retrieval_limit: int = 8,
    context_limit: int = 5,
    use_reranking: bool = True,
    parallel_reranking: bool = True,
    rerank_workers: int = 3,
) -> Dict[str, Any]:
    cases = load_eval_dataset(dataset_path)
    rag_llm = get_llm(model=model, temperature=0)
    judge_llm = get_llm(model=model, temperature=0)

    results = [
        evaluate_case(
            case=case,
            rag_llm=rag_llm,
            judge_llm=judge_llm,
            retrieval_limit=retrieval_limit,
            context_limit=context_limit,
            use_reranking=use_reranking,
            parallel_reranking=parallel_reranking,
            rerank_workers=rerank_workers,
        )
        for case in cases
    ]

    summary = summarize_results(results)
    output_path = save_evaluation_run(results, summary)

    return {
        "summary": summary,
        "results": results,
        "output_path": str(output_path),
    }

import json
import math
import time
from datetime import datetime
from pathlib import Path
from statistics import mean
from typing import Any, Dict, List

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

from app.evaluation.evaluator import (
    DEFAULT_DATASET_PATH,
    EVALUATION_RUNS_DIR,
    load_eval_dataset,
)
from app.rag.generator import generate_answer


def _require_ragas():
    """
    Import RAGAS lazily so the backend can still run if eval deps are not installed.
    """
    try:
        from datasets import Dataset
        from ragas import evaluate
        from ragas.embeddings import LangchainEmbeddingsWrapper
        from ragas.llms import LangchainLLMWrapper
        from ragas.metrics import (
            answer_relevancy,
            context_precision,
            context_recall,
            faithfulness,
        )
    except ImportError as exc:
        raise RuntimeError(
            "RAGAS dependencies are not installed. Run: pip install ragas datasets"
        ) from exc

    return {
        "Dataset": Dataset,
        "evaluate": evaluate,
        "LangchainEmbeddingsWrapper": LangchainEmbeddingsWrapper,
        "LangchainLLMWrapper": LangchainLLMWrapper,
        "metrics": [
            faithfulness,
            answer_relevancy,
            context_precision,
            context_recall,
        ],
    }


def _source_texts(sources: List[Dict[str, Any]]) -> List[str]:
    contexts = []

    for source in sources:
        text = str(source.get("text") or "").strip()
        if text:
            contexts.append(text)

    return contexts


def _average_metric(rows: List[Dict[str, Any]], key: str) -> float | None:
    values = []

    for row in rows:
        value = row.get(key)
        if value is None:
            continue

        try:
            values.append(float(value))
        except (TypeError, ValueError):
            continue

    if not values:
        return None

    return round(mean(values), 3)


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}

    if isinstance(value, list):
        return [_json_safe(item) for item in value]

    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None

    try:
        import numpy as np

        if isinstance(value, np.generic):
            return _json_safe(value.item())
    except Exception:
        pass

    return value


def build_ragas_rows(
    dataset_path: Path = DEFAULT_DATASET_PATH,
    retrieval_limit: int = 20,
    context_limit: int = 5,
    use_reranking: bool = True,
    parallel_reranking: bool = True,
    rerank_workers: int = 3,
) -> List[Dict[str, Any]]:
    """
    Run the current RAG pipeline and convert outputs into RAGAS dataset rows.
    """
    rows = []

    for case in load_eval_dataset(dataset_path):
        start = time.perf_counter()
        result = generate_answer(
            query=case["question"],
            retrieval_limit=retrieval_limit,
            context_limit=context_limit,
            use_reranking=use_reranking,
            parallel_reranking=parallel_reranking,
            rerank_workers=rerank_workers,
            chat_history=[],
            pinned_sources=[],
        )
        latency_seconds = round(time.perf_counter() - start, 3)

        contexts = _source_texts(result.get("sources", []))

        rows.append(
            {
                "id": case.get("id", case["question"]),
                "question": case["question"],
                "answer": result["answer"],
                "contexts": contexts,
                "ground_truth": case["expected_answer"],
                "latency_seconds": latency_seconds,
                "source_count": len(contexts),
            }
        )

    return rows


def save_ragas_run(
    rows: List[Dict[str, Any]],
    scores: Dict[str, Any],
    summary: Dict[str, Any],
) -> Path:
    EVALUATION_RUNS_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = EVALUATION_RUNS_DIR / f"ragas_eval_{timestamp}.json"

    payload = {
        "summary": summary,
        "scores": scores,
        "rows": rows,
    }

    with output_path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, indent=2)

    return output_path


def run_ragas_evaluation(
    dataset_path: Path = DEFAULT_DATASET_PATH,
    retrieval_limit: int = 20,
    context_limit: int = 5,
    use_reranking: bool = True,
    parallel_reranking: bool = True,
    rerank_workers: int = 3,
) -> Dict[str, Any]:
    """
    Evaluate the current RAG pipeline with RAGAS metrics.
    """
    load_dotenv()
    ragas = _require_ragas()

    rows = build_ragas_rows(
        dataset_path=dataset_path,
        retrieval_limit=retrieval_limit,
        context_limit=context_limit,
        use_reranking=use_reranking,
        parallel_reranking=parallel_reranking,
        rerank_workers=rerank_workers,
    )

    Dataset = ragas["Dataset"]
    evaluate = ragas["evaluate"]
    LangchainEmbeddingsWrapper = ragas["LangchainEmbeddingsWrapper"]
    LangchainLLMWrapper = ragas["LangchainLLMWrapper"]
    metrics = ragas["metrics"]
    evaluator_llm = LangchainLLMWrapper(
        ChatOpenAI(model="gpt-4o-mini", temperature=0)
    )
    evaluator_embeddings = LangchainEmbeddingsWrapper(
        OpenAIEmbeddings(model="text-embedding-3-small")
    )

    dataset = Dataset.from_list(
        [
            {
                "question": row["question"],
                "answer": row["answer"],
                "contexts": row["contexts"],
                "ground_truth": row["ground_truth"],
            }
            for row in rows
        ]
    )

    result = evaluate(
        dataset=dataset,
        metrics=metrics,
        llm=evaluator_llm,
        embeddings=evaluator_embeddings,
        raise_exceptions=False,
    )

    result_rows = result.to_pandas().to_dict(orient="records")
    summary = {
        "case_count": len(rows),
        "average_latency_seconds": round(mean(row["latency_seconds"] for row in rows), 3)
        if rows
        else 0.0,
        "average_source_count": round(mean(row["source_count"] for row in rows), 3)
        if rows
        else 0.0,
        "faithfulness": _average_metric(result_rows, "faithfulness"),
        "answer_relevancy": _average_metric(result_rows, "answer_relevancy"),
        "context_precision": _average_metric(result_rows, "context_precision"),
        "context_recall": _average_metric(result_rows, "context_recall"),
    }
    scores = {
        key: value
        for key, value in summary.items()
        if key
        in {
            "faithfulness",
            "answer_relevancy",
            "context_precision",
            "context_recall",
        }
    }

    output_path = save_ragas_run(
        rows=_json_safe([
            {
                **row,
                "ragas": result_rows[index] if index < len(result_rows) else {},
            }
            for index, row in enumerate(rows)
        ]),
        scores=_json_safe(scores),
        summary=_json_safe(summary),
    )

    return {
        "summary": summary,
        "scores": scores,
        "rows": result_rows,
        "output_path": str(output_path),
    }

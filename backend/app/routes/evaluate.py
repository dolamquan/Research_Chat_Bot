import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.evaluation.evaluator import EVALUATION_RUNS_DIR, run_evaluation
from app.evaluation.ragas_evaluator import run_ragas_evaluation
from app.rag.generator import generate_answer


router = APIRouter(prefix="/evaluate", tags=["evaluate"])


class EvaluationRequest(BaseModel):
    question: str
    expected_answer: str


class EvaluationResponse(BaseModel):
    question: str
    generated_answer: str
    expected_answer: str


class BatchEvaluationRequest(BaseModel):
    retrieval_limit: int = 8
    context_limit: int = 5
    use_reranking: bool = True
    parallel_reranking: bool = True
    rerank_workers: int = 3


class RagasEvaluationRequest(BatchEvaluationRequest):
    retrieval_limit: int = 20


def _safe_float(value: Any) -> float | None:
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return None


def _file_created_at(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _run_kind(path: Path, payload: Dict[str, Any]) -> str:
    if path.name.startswith("ragas_") or "rows" in payload or "scores" in payload:
        return "ragas"
    return "llm_judge"


def _metric_summary(summary: Dict[str, Any], kind: str) -> Dict[str, float | None]:
    if kind == "ragas":
        return {
            "faithfulness": _safe_float(summary.get("faithfulness")),
            "answer_relevancy": _safe_float(summary.get("answer_relevancy")),
            "context_precision": _safe_float(summary.get("context_precision")),
            "context_recall": _safe_float(summary.get("context_recall")),
        }

    return {
        "answer_correctness": _safe_float(summary.get("average_answer_correctness")),
        "faithfulness": _safe_float(summary.get("average_faithfulness")),
        "context_relevance": _safe_float(summary.get("average_context_relevance")),
        "overall": _safe_float(summary.get("average_overall")),
    }


def _overall_score(metrics: Dict[str, float | None]) -> float | None:
    if metrics.get("overall") is not None:
        return metrics["overall"]

    values = [value for value in metrics.values() if value is not None]
    if not values:
        return None

    return round(sum(values) / len(values), 3)


def _normalize_case(row: Dict[str, Any], kind: str) -> Dict[str, Any]:
    if kind == "ragas":
        ragas = row.get("ragas") or {}
        metrics = {
            "faithfulness": _safe_float(ragas.get("faithfulness")),
            "answer_relevancy": _safe_float(ragas.get("answer_relevancy")),
            "context_precision": _safe_float(ragas.get("context_precision")),
            "context_recall": _safe_float(ragas.get("context_recall")),
        }
        return {
            "id": row.get("id") or row.get("question"),
            "question": row.get("question", ""),
            "answer": row.get("answer", ""),
            "expected_answer": row.get("ground_truth", ""),
            "latency_seconds": _safe_float(row.get("latency_seconds")) or 0,
            "source_count": int(row.get("source_count") or len(row.get("contexts") or [])),
            "metrics": metrics,
            "overall": _overall_score(metrics),
            "feedback": "",
        }

    judge = row.get("judge") or {}
    metrics = {
        "answer_correctness": _safe_float(judge.get("answer_correctness")),
        "faithfulness": _safe_float(judge.get("faithfulness")),
        "context_relevance": _safe_float(judge.get("context_relevance")),
        "overall": _safe_float(judge.get("overall")),
    }
    return {
        "id": row.get("id") or row.get("question"),
        "question": row.get("question", ""),
        "answer": row.get("generated_answer", ""),
        "expected_answer": row.get("expected_answer", ""),
        "latency_seconds": _safe_float(row.get("latency_seconds")) or 0,
        "source_count": int(row.get("source_count") or len(row.get("sources") or [])),
        "metrics": metrics,
        "overall": _overall_score(metrics),
        "feedback": str(judge.get("feedback") or ""),
    }


def _normalize_run(path: Path, include_cases: bool = False) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        payload = json.load(file)

    summary = payload.get("summary") or {}
    kind = _run_kind(path, payload)
    rows = payload.get("rows") if kind == "ragas" else payload.get("results")
    cases = [_normalize_case(row, kind) for row in rows or []]
    metrics = _metric_summary(summary, kind)

    run = {
        "run_id": path.stem,
        "filename": path.name,
        "kind": kind,
        "created_at": _file_created_at(path),
        "case_count": int(summary.get("case_count") or len(cases)),
        "average_latency_seconds": _safe_float(summary.get("average_latency_seconds")) or 0,
        "average_source_count": _safe_float(summary.get("average_source_count")),
        "metrics": metrics,
        "overall": _overall_score(metrics),
    }

    if include_cases:
        run["cases"] = sorted(
            cases,
            key=lambda case: case.get("overall") if case.get("overall") is not None else -1,
        )

    return run


def _run_paths() -> List[Path]:
    if not EVALUATION_RUNS_DIR.exists():
        return []

    return sorted(
        EVALUATION_RUNS_DIR.glob("*.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


@router.post("", response_model=EvaluationResponse)
def evaluate(request: EvaluationRequest) -> EvaluationResponse:
    """
    Simple evaluation helper that returns generated and expected answers.
    """
    result = generate_answer(request.question)

    return EvaluationResponse(
        question=request.question,
        generated_answer=result["answer"],
        expected_answer=request.expected_answer,
    )


@router.post("/batch")
def evaluate_batch(request: BatchEvaluationRequest) -> Dict[str, Any]:
    """
    Run the offline evaluation dataset through the current RAG pipeline.
    """
    try:
        return run_evaluation(
            retrieval_limit=request.retrieval_limit,
            context_limit=request.context_limit,
            use_reranking=request.use_reranking,
            parallel_reranking=request.parallel_reranking,
            rerank_workers=request.rerank_workers,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"LLM judge evaluation failed: {exc}",
        ) from exc


@router.post("/ragas")
def evaluate_ragas(request: RagasEvaluationRequest) -> Dict[str, Any]:
    """
    Run RAGAS over the offline evaluation dataset.
    """
    try:
        return run_ragas_evaluation(
            retrieval_limit=request.retrieval_limit,
            context_limit=request.context_limit,
            use_reranking=request.use_reranking,
            parallel_reranking=request.parallel_reranking,
            rerank_workers=request.rerank_workers,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"RAGAS evaluation failed: {exc}",
        ) from exc


@router.get("/runs")
def list_evaluation_runs() -> Dict[str, Any]:
    """
    Return saved evaluation runs in a dashboard-friendly format.
    """
    runs = [_normalize_run(path) for path in _run_paths()]
    latest = _normalize_run(_run_paths()[0], include_cases=True) if runs else None

    return {
        "runs": runs,
        "latest": latest,
    }


@router.get("/runs/{run_id}")
def get_evaluation_run(run_id: str) -> Dict[str, Any]:
    for path in _run_paths():
        if path.stem == run_id:
            return _normalize_run(path, include_cases=True)

    raise HTTPException(status_code=404, detail="Evaluation run not found.")

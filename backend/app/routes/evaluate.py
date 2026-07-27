from typing import Any, Dict

from fastapi import APIRouter
from pydantic import BaseModel

from app.evaluation.evaluator import run_evaluation
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
    return run_evaluation(
        retrieval_limit=request.retrieval_limit,
        context_limit=request.context_limit,
        use_reranking=request.use_reranking,
        parallel_reranking=request.parallel_reranking,
        rerank_workers=request.rerank_workers,
    )

import argparse
import os
from pathlib import Path

from dotenv import load_dotenv

from app.evaluation.evaluator import DEFAULT_DATASET_PATH
from app.evaluation.ragas_evaluator import run_ragas_evaluation


def parse_args():
    parser = argparse.ArgumentParser(description="Evaluate the current RAG pipeline with RAGAS.")
    parser.add_argument(
        "--dataset",
        default=str(DEFAULT_DATASET_PATH),
        help="Path to the evaluation dataset JSON file.",
    )
    parser.add_argument("--retrieval-limit", type=int, default=20)
    parser.add_argument("--context-limit", type=int, default=5)
    parser.add_argument("--rerank-workers", type=int, default=3)
    parser.add_argument("--no-reranking", action="store_true")
    parser.add_argument("--sequential-reranking", action="store_true")
    parser.add_argument(
        "--trace-langsmith",
        action="store_true",
        help="Send RAGAS evaluation traces to LangSmith. Disabled by default for cleaner eval runs.",
    )
    return parser.parse_args()


def main():
    load_dotenv()
    args = parse_args()

    if not args.trace_langsmith:
        os.environ["LANGSMITH_TRACING"] = "false"

    result = run_ragas_evaluation(
        dataset_path=Path(args.dataset),
        retrieval_limit=args.retrieval_limit,
        context_limit=args.context_limit,
        use_reranking=not args.no_reranking,
        parallel_reranking=not args.sequential_reranking,
        rerank_workers=args.rerank_workers,
    )

    summary = result["summary"]

    print("RAGAS evaluation complete")
    print(f"Saved results to: {result['output_path']}")
    print(f"Cases: {summary['case_count']}")
    print(f"Average latency: {summary['average_latency_seconds']}s")
    print(f"Average source count: {summary['average_source_count']}")
    print(f"Faithfulness: {summary['faithfulness']}")
    print(f"Answer relevancy: {summary['answer_relevancy']}")
    print(f"Context precision: {summary['context_precision']}")
    print(f"Context recall: {summary['context_recall']}")


if __name__ == "__main__":
    main()

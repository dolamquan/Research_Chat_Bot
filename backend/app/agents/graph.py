import os
import re
from typing import Any, Dict

from langgraph.graph import END, StateGraph
from langsmith import traceable

from app.agents.state import AgentIntent, AgentState
from app.agents.tools import ingest_paper_tool, rag_tool, rebuild_topology_tool
from app.rag.generator import get_llm


INTENTS: set[str] = {
    "rag_question",
    "ingest_paper",
    "rebuild_topology",
}


def _looks_like_paper_url(text: str) -> bool:
    lowered = text.lower()
    return bool(re.search(r"https?://", text)) and (
        "arxiv.org/" in lowered or ".pdf" in lowered
    )


def _heuristic_intent(question: str) -> AgentIntent | None:
    lowered = question.lower()

    if _looks_like_paper_url(question) and any(
        phrase in lowered
        for phrase in ["add", "ingest", "index", "save", "store", "database"]
    ):
        return "ingest_paper"

    if any(
        phrase in lowered
        for phrase in [
            "rebuild topology",
            "build topology",
            "update topology",
            "rebuild map",
            "update map",
            "refresh topology",
        ]
    ):
        return "rebuild_topology"

    return None


@traceable(name="agent_classify_intent", run_type="chain")
def classify_intent(state: AgentState) -> Dict[str, Any]:
    question = state["question"]
    heuristic = _heuristic_intent(question)

    if heuristic:
        return {"intent": heuristic}

    llm = get_llm(
        model=os.getenv("AGENT_MODEL", os.getenv("OPENAI_MODEL", "gpt-4o-mini")),
        temperature=0,
    )
    prompt = f"""
Classify the user request into exactly one intent.

Allowed intents:
- rag_question: answer a research question using the indexed papers
- ingest_paper: add/index/store an arXiv or PDF URL into the database
- rebuild_topology: rebuild/update/refresh the paper topology or cluster map

Return only one intent string.

User request:
{question}
"""

    response = llm.invoke(prompt)
    content = getattr(response, "content", str(response)).strip().lower()
    intent = content.split()[0] if content else "rag_question"

    if intent not in INTENTS:
        intent = "rag_question"

    return {"intent": intent}


def route_intent(state: AgentState) -> str:
    intent = state.get("intent", "rag_question")

    if intent == "ingest_paper":
        return "ingest_paper"

    if intent == "rebuild_topology":
        return "rebuild_topology"

    return "rag_question"


def build_agent_graph():
    graph = StateGraph(AgentState)

    graph.add_node("classify_intent", classify_intent)
    graph.add_node("rag_question", rag_tool)
    graph.add_node("ingest_paper", ingest_paper_tool)
    graph.add_node("rebuild_topology", rebuild_topology_tool)

    graph.set_entry_point("classify_intent")
    graph.add_conditional_edges(
        "classify_intent",
        route_intent,
        {
            "rag_question": "rag_question",
            "ingest_paper": "ingest_paper",
            "rebuild_topology": "rebuild_topology",
        },
    )
    graph.add_edge("rag_question", END)
    graph.add_edge("ingest_paper", END)
    graph.add_edge("rebuild_topology", END)

    return graph.compile()


agent_graph = build_agent_graph()

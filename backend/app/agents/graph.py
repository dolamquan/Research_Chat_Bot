import os
import re
from typing import Any, Dict

from langgraph.graph import END, StateGraph
from langsmith import traceable

from app.agents.state import AgentIntent, AgentState
from app.agents.tools import (
    create_github_issue_tool,
    export_notion_tool,
    export_visualization_notion_tool,
    generate_visualization_tool,
    ingest_paper_tool,
    rag_tool,
    rebuild_topology_tool,
    save_note_tool,
    search_arxiv_tool,
    search_papers_tool,
    search_github_tool,
    search_library_tool,
    search_reddit_tool,
    small_talk_tool,
    summarize_paper_tool,
)
from app.agents.workflow import is_workflow_request, workflow_agent_tool
from app.rag.generator import get_llm
from app.rag.prompt_cache import cached_llm_text


INTENTS: set[str] = {
    "small_talk",
    "rag_question",
    "search_papers",
    "search_arxiv",
    "search_library",
    "search_reddit",
    "ingest_paper",
    "save_note",
    "rebuild_topology",
    "export_notion",
    "create_github_issue",
    "search_github",
    "summarize_paper",
    "generate_visualization",
    "export_visualization_notion",
    "workflow_agent",
}


def _looks_like_paper_url(text: str) -> bool:
    lowered = text.lower()
    return bool(re.search(r"https?://", text)) and (
        "arxiv.org/" in lowered or ".pdf" in lowered
    )


def _looks_like_small_talk(text: str) -> bool:
    normalized = re.sub(r"[^a-z0-9\s']", " ", text.lower())
    normalized = " ".join(normalized.split())
    if not normalized:
        return True

    greetings = {
        "hi",
        "hello",
        "hey",
        "yo",
        "sup",
        "howdy",
        "good morning",
        "good afternoon",
        "good evening",
        "thanks",
        "thank you",
        "ok",
        "okay",
    }
    if normalized in greetings:
        return True

    casual_patterns = [
        r"^(hi|hello|hey)\s+(there|researchmind|agent|bot)?$",
        r"^how are you$",
        r"^what can you do$",
        r"^who are you$",
    ]
    return any(re.match(pattern, normalized) for pattern in casual_patterns)


def _heuristic_intent(question: str) -> AgentIntent | None:
    lowered = question.lower()

    if _looks_like_small_talk(question):
        return "small_talk"

    if is_workflow_request(question):
        return "workflow_agent"

    if _looks_like_paper_url(question) and any(
        phrase in lowered
        for phrase in ["add", "ingest", "index", "save", "store", "database"]
    ):
        return "ingest_paper"

    if "notion" in lowered and any(
        phrase in lowered
        for phrase in [
            "visualization",
            "diagram",
            "mermaid",
            "concept map",
            "method flow",
        ]
    ):
        return "export_visualization_notion"

    if any(
        phrase in lowered
        for phrase in [
            "export to notion",
            "send to notion",
            "save to notion",
            "create notion",
            "notion page",
        ]
    ):
        return "export_notion"

    if "github" in lowered and any(
        phrase in lowered
        for phrase in [
            "create issue",
            "open issue",
            "make issue",
            "issue for",
            "issue about",
        ]
    ):
        return "create_github_issue"

    if "github" in lowered and any(
        phrase in lowered
        for phrase in [
            "search",
            "find",
            "repositories",
            "repos",
            "implementation",
            "code",
        ]
    ):
        return "search_github"

    if ("reddit" in lowered or re.search(r"\br/[A-Za-z0-9_]+\b", question)) and any(
        phrase in lowered
        for phrase in [
            "search",
            "find",
            "discover",
            "look for",
            "posts",
            "threads",
            "discussions",
            "what are people saying",
        ]
    ):
        return "search_reddit"

    if any(
        phrase in lowered
        for phrase in [
            "summarize this paper",
            "summarize paper",
            "summary of this paper",
            "paper summary",
            "summarize the selected paper",
        ]
    ):
        return "summarize_paper"

    if any(
        phrase in lowered
        for phrase in [
            "generate visualization",
            "make visualization",
            "create visualization",
            "draw diagram",
            "generate diagram",
            "make diagram",
            "method diagram",
            "concept map",
            "architecture diagram",
            "mermaid",
        ]
    ):
        return "generate_visualization"

    if any(
        phrase in lowered
        for phrase in [
            "save note",
            "save this note",
            "remember this",
            "store this note",
            "create note",
        ]
    ):
        return "save_note"

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

    if any(source in lowered for source in ["pubmed", "biorxiv", "medrxiv", "semantic scholar", "crossref", "openalex"]) and any(
        phrase in lowered
        for phrase in ["search", "find", "discover", "look for", "papers about"]
    ):
        return "search_papers"

    if "arxiv" in lowered and any(
        phrase in lowered
        for phrase in ["search", "find", "discover", "look for", "papers about"]
    ):
        return "search_arxiv"

    if any(
        phrase in lowered
        for phrase in [
            "search papers",
            "find papers",
            "discover papers",
            "look for papers",
            "new papers about",
            "recent papers about",
            "latest papers about",
        ]
    ):
        return "search_papers"

    if any(
        phrase in lowered
        for phrase in [
            "my library",
            "indexed papers",
            "papers in the database",
            "papers in my database",
            "search library",
            "find in library",
            "find indexed",
        ]
    ):
        return "search_library"

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
- small_talk: greeting, thanks, help-like conversational message, or capability question that should not use tools
- rag_question: answer a research question using the indexed papers
- search_papers: search multiple academic sources for new external research papers
- search_arxiv: search arXiv only for new external research papers
- search_library: find papers already indexed in the local research library
- search_reddit: search Reddit posts/discussions for practitioner or community context
- ingest_paper: add/index/store an arXiv or PDF URL into the database
- save_note: save a note about a selected/pinned paper passage
- rebuild_topology: rebuild/update/refresh the paper topology or cluster map
- export_notion: create/export/save a research note or paper summary to Notion
- create_github_issue: create/open a GitHub issue for a research task or project follow-up
- search_github: search GitHub repositories for code, implementations, or related projects
- summarize_paper: summarize the selected/indexed paper or research context
- generate_visualization: generate a Mermaid diagram or visualization from a paper/topic
- export_visualization_notion: generate a visualization and save it to Notion
- workflow_agent: plan and run a multi-step research workflow that may combine local library search, Graph RAG, external paper search, ranking, ingestion, topology rebuilds, and summary reporting

Return only one intent string.

User request:
{question}
"""

    try:
        content = cached_llm_text(
            llm=llm,
            prompt=prompt,
            namespace="agent_intent_classifier",
        ).strip().lower()
        intent = content.split()[0] if content else "rag_question"
    except Exception:
        intent = "rag_question"

    if intent not in INTENTS:
        intent = "rag_question"

    if _looks_like_small_talk(question):
        intent = "small_talk"

    return {"intent": intent}


def route_intent(state: AgentState) -> str:
    intent = state.get("intent", "rag_question")

    if intent == "small_talk":
        return "small_talk"

    if intent == "ingest_paper":
        return "ingest_paper"

    if intent == "search_papers":
        return "search_papers"

    if intent == "search_arxiv":
        return "search_arxiv"

    if intent == "search_library":
        return "search_library"

    if intent == "search_reddit":
        return "search_reddit"

    if intent == "save_note":
        return "save_note"

    if intent == "rebuild_topology":
        return "rebuild_topology"

    if intent == "export_notion":
        return "export_notion"

    if intent == "create_github_issue":
        return "create_github_issue"

    if intent == "search_github":
        return "search_github"

    if intent == "summarize_paper":
        return "summarize_paper"

    if intent == "generate_visualization":
        return "generate_visualization"

    if intent == "export_visualization_notion":
        return "export_visualization_notion"

    if intent == "workflow_agent":
        return "workflow_agent"

    return "rag_question"


def build_agent_graph():
    graph = StateGraph(AgentState)

    graph.add_node("classify_intent", classify_intent)
    graph.add_node("small_talk", small_talk_tool)
    graph.add_node("rag_question", rag_tool)
    graph.add_node("search_papers", search_papers_tool)
    graph.add_node("search_arxiv", search_arxiv_tool)
    graph.add_node("search_library", search_library_tool)
    graph.add_node("search_reddit", search_reddit_tool)
    graph.add_node("ingest_paper", ingest_paper_tool)
    graph.add_node("save_note", save_note_tool)
    graph.add_node("rebuild_topology", rebuild_topology_tool)
    graph.add_node("export_notion", export_notion_tool)
    graph.add_node("create_github_issue", create_github_issue_tool)
    graph.add_node("search_github", search_github_tool)
    graph.add_node("summarize_paper", summarize_paper_tool)
    graph.add_node("generate_visualization", generate_visualization_tool)
    graph.add_node("export_visualization_notion", export_visualization_notion_tool)
    graph.add_node("workflow_agent", workflow_agent_tool)

    graph.set_entry_point("classify_intent")
    graph.add_conditional_edges(
        "classify_intent",
        route_intent,
        {
            "small_talk": "small_talk",
            "rag_question": "rag_question",
            "search_papers": "search_papers",
            "search_arxiv": "search_arxiv",
            "search_library": "search_library",
            "search_reddit": "search_reddit",
            "ingest_paper": "ingest_paper",
            "save_note": "save_note",
            "rebuild_topology": "rebuild_topology",
            "export_notion": "export_notion",
            "create_github_issue": "create_github_issue",
            "search_github": "search_github",
            "summarize_paper": "summarize_paper",
            "generate_visualization": "generate_visualization",
            "export_visualization_notion": "export_visualization_notion",
            "workflow_agent": "workflow_agent",
        },
    )
    graph.add_edge("small_talk", END)
    graph.add_edge("rag_question", END)
    graph.add_edge("search_papers", END)
    graph.add_edge("search_arxiv", END)
    graph.add_edge("search_library", END)
    graph.add_edge("search_reddit", END)
    graph.add_edge("ingest_paper", END)
    graph.add_edge("save_note", END)
    graph.add_edge("rebuild_topology", END)
    graph.add_edge("export_notion", END)
    graph.add_edge("create_github_issue", END)
    graph.add_edge("search_github", END)
    graph.add_edge("summarize_paper", END)
    graph.add_edge("generate_visualization", END)
    graph.add_edge("export_visualization_notion", END)
    graph.add_edge("workflow_agent", END)

    return graph.compile()


agent_graph = build_agent_graph()

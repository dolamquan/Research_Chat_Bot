# ResearchMind

ResearchMind is a research-paper chatbot with document retrieval, paper topology clustering, PDF reading, selectable PDF context, whole-paper chat mode, and persistent chat history.

## Features

- RAG over indexed research PDFs with Qdrant
- Paper topology view built from document-level embedding clusters
- Cluster-scoped and article-scoped chat
- Whole-paper context mode for selected articles
- PDF sidebar reader with selectable text context
- Local SQLite chat history
- React/Vite frontend and FastAPI backend

## Run Locally

Start Qdrant:

```powershell
docker compose up -d qdrant
```

Start the backend:

```powershell
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8002 --reload
```

Start the frontend:

```powershell
cd frontend
pnpm install
pnpm run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Environment

Create `backend/.env` from `backend/.env.example` and add your OpenAI API key.

For multi-source paper search, use the Docker-backed Paper Search runner:

```env
PAPER_SEARCH_BACKEND=docker
PAPER_SEARCH_DOCKER_IMAGE=mcp/paper-search
PAPER_SEARCH_DOCKER_ENTRYPOINT=python
PAPER_SEARCH_DOCKER_MODULE=paper_search_mcp.cli
PAPER_SEARCH_TIMEOUT_SECONDS=90
```

Pull the image once before using the crawler:

```powershell
docker pull mcp/paper-search
```

`PAPER_SEARCH_BACKEND=auto` also works: the backend tries a local `paper-search`
command first, then falls back to Docker if Docker is available.

For Reddit search in the research agent, configure the read-only Docker MCP bridge:

```env
REDDIT_MCP_BACKEND=docker
REDDIT_MCP_DOCKER_IMAGE=mcp/reddit
REDDIT_MCP_TIMEOUT_SECONDS=60
REDDIT_USERNAME=your_reddit_username
REDDIT_CLIENT_ID=your_reddit_app_client_id
REDDIT_CLIENT_SECRET=your_reddit_app_client_secret
REDDIT_PASSWORD=your_reddit_password
REDDIT_USER_AGENT=ResearchMind/0.1
```

Then pull the image once:

```powershell
docker pull mcp/reddit
```

The agent exposes this through `/search-reddit graph RAG` and through the MCP
bridge command `/mcp-call reddit.search_posts {"query":"graph rag","limit":5}`.

## Notes

- Uploaded PDFs live in `backend/app/data/uploaded_docs`.
- Qdrant vector storage is generated locally or stored in Docker and is not committed.
- Chat history is stored locally in `backend/app/data/chat_history.sqlite3` and is not committed.

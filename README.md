# Zoetrope

Zoetrope is a research-paper chatbot with document retrieval, paper topology clustering, PDF reading, selectable PDF context, whole-paper chat mode, and persistent chat history.

## Features

- RAG over indexed research PDFs with Qdrant
- Paper topology view built from document-level embedding clusters
- Cluster-scoped and article-scoped chat
- Whole-paper context mode for selected articles
- PDF sidebar reader with selectable text context
- Local SQLite chat history
- React/Vite frontend and FastAPI backend
- Algorithm visualizer: paper -> model-written Three.js animation, executed
  in a locked-down sandboxed iframe
  (see [docs/PAPER_TO_SCENE.md](docs/PAPER_TO_SCENE.md))
- Provider-independent LLM layer (OpenAI or Anthropic) behind one interface

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
REDDIT_USER_AGENT=Zoetrope/0.1
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

## Algorithm Visualizer

Turns an indexed paper into an interactive animation of its proposed method.

The language model writes a self-contained Three.js program for each paper.
The code executes only inside an iframe sandboxed to `allow-scripts` — an
opaque origin with no cookies, storage, network shortcuts to this app, or
handle on the parent page. Static contract checks (no imports, no network, no
DOM escape hatches, required `init`/`update` entry points) run at generation
time with one repair attempt, and again client-side before the frame mounts.

Scenes are model-written and illustrative: unlike the retired declarative
Scene IR pipeline, they are **not** verified against the paper's text, and the
UI says so. See [docs/PAPER_TO_SCENE.md](docs/PAPER_TO_SCENE.md) for the
trade-off and the full architecture.

```text
POST /visualizer/generate-scene           generate, check and persist scene code
GET  /visualizer/item/{viz_id}/scene      the stored code + check report
POST /visualizer/item/{viz_id}/verify-scene   re-run static checks, no LLM call
GET  /visualizer/providers                which providers are configured
```

Open a paper in the Visualizer, then the **Scene** tab.

### Provider configuration

```env
LLM_PROVIDER=openai        # or anthropic; unset keeps the previous default
OPENAI_API_KEY=
OPENAI_MODEL=              # default gpt-4o-mini
ANTHROPIC_API_KEY=         # needs `pip install langchain-anthropic`
ANTHROPIC_MODEL=           # default claude-sonnet-4-5
```

### Optional extras

```bash
pip install docling              # structured PDF parsing; falls back cleanly
pip install langchain-anthropic  # the anthropic provider
pip install onnx                 # ONNX model-graph verification evidence
```

## Tests

```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest

cd ../frontend
pnpm install
pnpm run test
pnpm run typecheck
pnpm run build
```

All tests run offline; none calls a model provider or a vector store.

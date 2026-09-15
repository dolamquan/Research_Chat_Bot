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

Voice input uses `gpt-live-transcribe` through the authenticated
`/agent/transcribe` WebSocket. It uses the backend's `OPENAI_API_KEY`, independently
of the chat model. The browser captures 24 kHz PCM with an AudioWorklet, detects
speech locally, and commits utterances after 700 ms of silence. Partial captions
are reconciled with final transcripts before sending commands. The same audio
stream drives the microphone orb; mute and sign-out close the audio connection.
Use HTTPS or localhost for microphone access, and allow WebSocket upgrades through
your proxy. `ASSISTANT_TRANSCRIPTION_LANGUAGES=en` and
`ASSISTANT_TRANSCRIPTION_DELAY=low` are the defaults; set the delay to `medium`
or `high` for more context at the cost of later partial captions.

Unmuted wake-word listening sends detected speech to OpenAI, including speech
before the wake word, and incurs transcription charges. Quiet periods are gated
locally. For occasional commands, keep the mic muted and use push-to-talk.

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

### Accounts

Sign-in is handled by Supabase Auth; all application data stays in the local
SQLite databases and Qdrant. The backend verifies each request's bearer token
against the project's public JWKS (`backend/app/auth/`), so it needs only
`SUPABASE_URL` — never a Supabase secret key. The frontend needs
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `frontend/.env.local`.
`AUTH_MODE=disabled` runs the backend as one local administrator for
development.

Data is divided by an `owner_id` column:

- Papers are **public** (`owner_id` NULL — everything indexed before accounts,
  plus anything an admin publishes) or **private** to the user who crawled
  them. Retrieval, clusters and the library list show `public ∪ own`.
- Notes, folders, Notion targets, chat sessions, agent sessions and ingestion
  jobs are personal. Rows from before accounts existed are adopted by the
  first administrator who signs in (`GET /auth/me`).
- Administrators (`app_metadata.role = "admin"` in Supabase) can publish a
  private paper with `POST /articles/{article_id}/visibility {"public": true}`.

Also per-user: diagrams, scenes and variants (each user generates their own
for a paper), evaluation runs (`evaluation_runs/users/<id>/`; the pre-account
archive is admin-only), topology and Graph RAG caches (`clusters/users/<id>/`,
`graph_rag/users/<id>/`, falling back to the shared library's until rebuilt),
uploaded images and captured regions, and Notion/GitHub credentials
(`user_integrations`, encrypted with `INTEGRATION_SECRET_KEY`; the env vars stay
the administrator's defaults). Figures extracted from a public paper stay public.

Still shared: the browser extension has no token path yet and gets 401s.

### The agent, and the Console

Zoe — the always-present assistant — runs a tool-calling loop
(`backend/app/agents/runtime.py`) over a catalog built from the running
application (`backend/app/agents/catalog.py`): every FastAPI route becomes an
`api.<area>.<function>` tool, every MCP bridge tool is included by name, and
`app.context` / `app.papers` give the model a live overview of the app and the
whole paper library. The system prompt carries the feature guide, paper
counts, the user's current selection and the full tool index, so
plain-language requests can reach notes, visualizations, variants, clusters,
Graph RAG, evaluation runs, ingestion and integrations without any
per-feature wiring. Destructive and external-write tools (deletes, Notion,
GitHub) wait for the user's confirmation.

The **Console** view is not a second chat. It is where you see and operate the
machine Zoe drives:

- **Tools** — the whole catalog, searchable and grouped by area, each with its
  effect (read / write / destructive / writes outside the app), its
  `input_schema`, and a form generated from that schema to run it. Destructive
  and external-write tools require an explicit acknowledgement.
- **Activity** — every session, Zoe's and the retired Agent tab's, with each
  turn's tool timeline and a summary of what the session changed.
- **Jobs** — ingestion jobs and evaluation runs, polled while anything runs.
- **Diagnostics** — reachable model providers, integration status, paper
  counts by domain, unavailable tools and why, and routes this frontend
  expects that the backend does not serve.
- A command line at the bottom runs a tool exactly as typed, with no model in
  the loop: `/call app.papers {"query":"graph rag"}`,
  `/mcp-call research.search_library {"query":"retrieval"}`,
  `/tool api.notes.create_note`.

The endpoints behind it: `GET /agent/tools?query=&category=`,
`GET /agent/tools/{name}`, `POST /agent/tools/call`, `GET /agent/context`,
`GET /agent/sessions?kind=agent|assistant|all`. `AGENT_MODEL`,
`AGENT_MAX_STEPS` and `AGENT_MODE=legacy` (the previous fixed intent router)
are documented in `backend/.env.example`.

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
                                          (+ runtime_error / layout_report with force = repair the stored code)
GET  /visualizer/item/{viz_id}/scene      the stored code + check report
POST /visualizer/item/{viz_id}/verify-scene   re-run static checks, no LLM call
POST /visualizer/item/{viz_id}/runtime    the browser's verdict after running the scene off-screen
POST /visualizer/item/{viz_id}/refine     apply a user-described change; 409 until a
                                          change to the method itself is acknowledged
GET  /visualizer/providers                which providers are configured
```

The same `runtime` and `refine` endpoints exist per stage under
`/visualizer/item/{viz_id}/stage-scenes/{node_id}/…`. A scene counts as ready
only once the browser has probed it through a full cycle without a crash;
see [docs/PAPER_TO_SCENE.md](docs/PAPER_TO_SCENE.md#verification-a-scene-is-ready-only-after-the-browser-has-run-it).

```text
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

## Cloud data (Supabase + Qdrant Cloud)

By default every store is a file on this machine: three SQLite databases under
`backend/app/data`, the PDFs in `backend/app/data/uploaded_docs`, and vectors in
the local Qdrant container. Three environment variables move each of them to a
managed service without changing any route or feature:

| Data | Local default | Cloud | Switch |
|---|---|---|---|
| Papers, notes, chats, sessions, visualizations (13 tables) | SQLite files | Supabase Postgres | `DATABASE_URL` (pooled connection string, port 6543) |
| PDFs | `uploaded_docs/` | Supabase Storage, private bucket `papers` | `SUPABASE_SERVICE_ROLE_KEY` (+ optional `SUPABASE_STORAGE_BUCKET`) |
| Vectors (`mini_chatbot_docs`, `research_notes`) | Docker Qdrant | Qdrant Cloud | `QDRANT_URL` + `QDRANT_API_KEY` |

The stores keep writing SQLite-flavoured SQL; `app/storage/db.py` rewrites the
handful of dialect differences for Postgres at execution time and pools
connections. `uploaded_docs/` becomes a read-through cache: a PDF missing on
disk is fetched from Storage once, and newly ingested PDFs are uploaded after
they are downloaded. Sign-in already uses Supabase Auth and is unaffected.

### Moving existing data

1. In Supabase: create the project's pooled connection string (Project Settings
   > Database > Connection pooling, transaction mode) and copy the service role
   key (Project Settings > API). In Qdrant Cloud: create a cluster and an API key.
2. Put the targets in `backend/.env`:
   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   SUPABASE_SERVICE_ROLE_KEY=<service role key>
   TARGET_QDRANT_URL=https://<cluster>.cloud.qdrant.io:6333
   TARGET_QDRANT_API_KEY=<qdrant api key>
   ```
   Leave `QDRANT_URL` pointing at the local container for now; it is the source.
3. Copy everything (re-runnable; sources are only read):
   ```powershell
   cd backend
   python -m scripts.migrate_to_cloud --all --dry-run   # counts only
   python -m scripts.migrate_to_cloud --all
   ```
   Tables copy in dependency order with `ON CONFLICT DO NOTHING`, PDFs already
   present with the same size are skipped, and a collection whose point count
   already matches is left alone (`--force` re-copies).
4. Switch `QDRANT_URL` / `QDRANT_API_KEY` to the cloud cluster, restart the
   backend, and check the Paper Library, a chat answer, and a PDF open. The
   local files and container are now a cold backup; the Qdrant container no
   longer needs to be running.

Postgres-specific behaviour is covered by `tests/test_postgres_storage.py`,
which runs only when `TEST_DATABASE_URL` points at a disposable database (it
drops the schema).

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

# Research Ops

A standalone management app for Zoetrope / Research Chatbot. Run it in a
second browser tab to see API spend, requests, model calls, tool timelines,
failures and user activity. React + TypeScript + Vite; the existing FastAPI
backend serves an administrator-only `/ops` API.

## Launch

From `Research-chatbot`:

```powershell
.\start-operations.ps1
```

Open **http://127.0.0.1:5174**. Restart the chatbot backend once to load its
new telemetry middleware and API routes. Use the existing backend launch
command in another terminal:

```powershell
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8002 --reload
```

The launcher reuses installed dependencies in `frontend/node_modules` when
this app has no installation of its own. It does not change the chatbot's
frontend or stop any running processes. For a separate dependency install:

```powershell
cd operations
npm install
npm run dev
```

An explicit sample-data preview is available at
**http://127.0.0.1:5174/?demo=1**. It makes no API calls. Its sample users,
operations and costs are examples; edits exist only for the preview session.

The live app shares the chatbot's public Supabase configuration from
`frontend/.env` (`VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`). Sign in with an account whose verified
`app_metadata.role` is `admin`. Regular users cannot access the operations
API. With the backend's existing `AUTH_MODE=disabled`, it uses the local
administrator. Provider and LangSmith keys stay on the backend.

To use another backend, set `OPS_API_TARGET` before launch:

```powershell
$env:OPS_API_TARGET = 'http://127.0.0.1:8004'
.\start-operations.ps1 -Port 5176
```

## Screens

- **Overview:** estimated spend, model calls, failures, users, spend charts,
  model distribution, recent activity, budget and outstanding issues.
- **Cost explorer:** token counts, cached input, model cost shares, average
  latency, endpoint activity and monthly budget monitoring.
- **Calls & traces:** search by operation/model/user/error/ID, filters,
  pagination, CSV export and a linked request timeline in a detail drawer.
- **Issues:** repeated failures grouped by operation and error type. Mark
  issues resolved; later failures reopen them automatically.
- **Users:** authenticated users observed in the selected time period, with
  their request counts, calls, failures, spend and last activity. Click a
  user to drill into their calls. This is activity monitoring rather than an
  account directory or subscription manager.
- **Settings:** monthly budget and alert threshold, model rates, source
  details and a bounded import of historical LangSmith calls.

Live views refresh every 15 seconds while visible. Reporting periods use UTC
calendar days; individual call timestamps use the browser's local timezone.
Today, 7, 30 and 90 days are available. Search and filters apply to call logs
and CSV exports; overview and cost charts cover the full selected period.
Exports contain the latest 10,000 matching operations; filter a larger result
set to export the remainder. Fields that could execute a spreadsheet formula
are escaped.

## How live capture works

The backend stores metadata in `backend/app/data/operations.sqlite3` using
SQLite WAL. `OperationsMiddleware` records HTTP requests and assistant
WebSocket connections. An inheritable LangChain callback records chat-model
usage, completion/error states and LangChain tool/retrieval calls. Catalog
executors also record the research assistant's application and MCP tools.
An internally generated request ID connects nested API/tool/model work and is
returned as `X-Ops-Request-ID`. Model callbacks record the authenticated user,
including work running in the thread pool or assistant connection.

Capture does not depend on LangSmith and does not change its existing tracing.
Dashboard polling, authentication plumbing, health checks and documentation
requests are excluded from local telemetry. Operations routes are excluded
from the agent tool catalog. Telemetry persistence errors are logged briefly
and do not fail the underlying chatbot request.

Model inputs/outputs, request bodies, query strings, authorization headers and
provider credentials are not recorded. Shortened error messages have common
credentials and email addresses redacted. User IDs and account emails are
recorded separately for administrator attribution. The local database contains
operational data and should be protected with the backend's normal filesystem
access controls.

Backend configuration (in the existing backend environment):

```env
OPS_TELEMETRY_ENABLED=true
# Optional, default is backend/app/data/operations.sqlite3:
# OPS_DB_PATH=/absolute/path/to/operations.sqlite3
```

The telemetry store is local even when the chatbot's application stores use
Supabase Postgres. Each backend instance has its own telemetry file. For a
container, mount that file's directory on persistent storage. Centralized
multi-instance aggregation is outside this implementation. Collection begins
after restarting the instrumented backend; interrupted processes can leave
unfinished operations marked Running.

## Costs and coverage

Only LLM leaf calls contribute to spend. Request and tool spans do not add
model costs again. Estimates use reported input and output tokens, subtract
cached input from ordinary input, and apply the configured cached rate.
Reasoning tokens are already part of the provider's output total.

The default standard processing rates were verified on **2026-10-01** using
the official model documentation:

| Model | Input / 1M | Cached input / 1M | Output / 1M |
| --- | ---: | ---: | ---: |
| [gpt-5](https://developers.openai.com/api/docs/models/gpt-5) | $1.25 | $0.125 | $10.00 |
| [gpt-5-mini](https://developers.openai.com/api/docs/models/gpt-5-mini) | $0.25 | $0.025 | $2.00 |
| [gpt-4o-mini](https://developers.openai.com/api/docs/models/gpt-4o-mini) | $0.15 | $0.075 | $0.60 |

Exact model names and their dated snapshots match these rates. Unknown models,
missing usage, nonstandard service tiers, audio and cache-write usage stay
unpriced. Add another provider/model's standard rates in Settings. Saved
estimates retain their captured rates; changes affect subsequent calls.
An unavailable cost is shown as **—**, never silently priced as zero.
Totals and budgets exclude unavailable costs, with their counts shown nearby.

The budget is a dashboard alert, **not an enforced spending cap**. It uses
estimated month-to-date usage. These estimates are not a provider invoice and
do not include taxes, negotiated discounts, infrastructure, external provider
SDK calls, scripts outside the app, hosted tool charges, or live transcription
audio charges. HTTP failures and model failures in the same request are
separate failed operations and can appear as separate issue groups.

## LangSmith history

If `LANGSMITH_API_KEY` (or `LANGCHAIN_API_KEY`) is configured, Settings can
import the last seven days of LLM calls from `LANGSMITH_PROJECT` (or
`LANGCHAIN_PROJECT`, default `default`). The backend reads up to 1,000 runs
per import. No history is imported automatically. Repeating an import skips
recorded run IDs, including calls already captured locally. Parent LLM
wrappers are excluded to avoid counting aggregate usage twice.

Imported calls retain LangSmith's reported cost estimates when available.
Missing historical costs stay unknown because their original pricing tier
and cache usage cannot reliably be reconstructed. Historical user attribution
requires `user_id` or `owner_id` metadata on the source run. Imported timelines
include the LLM leaves returned by this import. Detailed research request/tool
timelines are available for newly recorded local activity.

## Verify

```powershell
cd operations
npm run typecheck
npm run test
npm run build

cd ../backend
python -m pytest tests/test_operations.py
```

`operations/scripts/check-ui.mjs` checks the running frontend in headless
Chromium and saves screenshots to `operations/artifacts/` (ignored by Git).
It checks filters, pagination, details, search, exports, issue resolution,
user drill-down, settings, mobile overflow, administrator rejection and API
outages. Use `playwright-core` or set `PLAYWRIGHT_MODULE` to an existing
installation, then run `node scripts/check-ui.mjs`. `OPS_URL` selects another
frontend URL. All verification uses sample data or mocked responses and never
calls a model provider.

For deployment, `npm run build` creates `operations/dist`. Serve it as its own
site and proxy `/api` to the chatbot backend, stripping the `/api` prefix.
Configure SPA fallback to `index.html`. The bundled admin UI still depends on
the server's verified administrator role; public site access alone never
grants access to telemetry.

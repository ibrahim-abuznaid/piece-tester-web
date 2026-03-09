# Piece Tester Web - Project Summary & Continuation Guide

## What This App Does

A standalone **React + Node.js web application** for automated testing of Activepieces community pieces. It connects to the Activepieces Cloud API, creates temporary flows, runs each piece action, and reports pass/fail results — all from a web UI.

**Key features:**
- Browse all pieces from Activepieces Cloud
- Manage piece credentials (manual entry or import from your AP dashboard)
- Auto-generate test configurations for any piece's actions
- Run tests manually or on a schedule (daily/weekly via cron)
- View test history with drill-down into individual action results
- Uses SQLite for local persistence (no external DB needed)

**Tech stack:** React 18, Vite, Tailwind CSS, Express.js, SQLite (`better-sqlite3`), TypeScript throughout.

---

## Architecture

```
piece-tester-web/
├── client/              # React frontend (Vite)
│   └── src/
│       ├── App.tsx          # React Router setup
│       ├── lib/api.ts       # Typed fetch wrapper for all backend calls
│       ├── pages/           # Dashboard, Pieces, PieceDetail, Connections, TestRunner, History, Settings
│       └── components/      # Layout (sidebar), TestResultBadge
├── server/              # Express backend
│   └── src/
│       ├── index.ts         # Express entry point (port 4000)
│       ├── db/
│       │   ├── schema.ts    # SQLite table creation + migrations
│       │   └── queries.ts   # All CRUD operations
│       ├── routes/          # REST API endpoints
│       │   ├── settings.ts      # GET/PUT settings, POST sign-in/save-token/sign-out
│       │   ├── pieces.ts        # Proxy to AP Cloud piece metadata
│       │   ├── connections.ts   # CRUD credentials + import from AP
│       │   ├── tests.ts         # POST run tests, GET status
│       │   ├── history.ts       # GET past runs + details
│       │   └── schedules.ts     # CRUD cron schedules
│       └── services/
│           ├── ap-client.ts           # Activepieces API wrapper (API key + JWT auth)
│           ├── test-engine.ts         # Core: creates flows, runs actions, polls results
│           ├── test-config-generator.ts # Auto-generates test input values from piece schemas
│           ├── connection-builder.ts  # Builds AP connection payloads from stored credentials
│           └── scheduler.ts           # node-cron job registration
├── data/                # SQLite DB file (gitignored)
└── diagnostic.ts        # Standalone API debugging script
```

---

## How Test Execution Works

There are **two strategies**, chosen automatically:

### Primary: `test-step` via JWT (recommended, required for AP Cloud)
1. Create a temporary flow with an EMPTY trigger
2. Add the piece action step with test input + connection
3. Call `POST /v1/sample-data/test-step` (requires JWT auth with a real user ID)
4. Poll `GET /v1/flow-runs/:id` until terminal status
5. Delete the temporary flow

### Fallback: Production webhook (API key only, unreliable on AP Cloud)
1. Create flow with webhook trigger + piece action
2. Publish and enable the flow
3. Trigger the production webhook
4. Poll `GET /v1/flow-runs?flowId=...` for results
5. Disable and delete the flow

The webhook approach is unreliable on AP Cloud because:
- `GET /v1/flow-runs` filters for `PRODUCTION` environment only (misses `TESTING` runs)
- Runs go through a Redis metadata queue before being written to Postgres (30-120s delay)
- If the flow is deleted before the queue flushes, the run is silently discarded
- Cloudflare's 30s proxy timeout kills synchronous webhook calls

**That's why JWT auth is required for AP Cloud.**

---

## Database Schema (SQLite)

5 tables in `data/piece-tester.db`:

| Table | Purpose |
|-------|---------|
| `settings` | Single-row config: `base_url`, `api_key`, `project_id`, `test_timeout_ms`, `jwt_token` |
| `piece_connections` | Stored credentials per piece: `piece_name`, `display_name`, `connection_type`, `connection_value` (JSON), `actions_config` (JSON) |
| `test_runs` | Test execution batches: `trigger_type`, `status`, timestamps, pass/fail/error counts |
| `test_results` | Individual action results: FK to `test_runs`, `piece_name`, `action_name`, `status`, `duration_ms`, `flow_run_id`, `error_message` |
| `schedules` | Cron schedules: `piece_name` (nullable = all), `cron_expression`, `enabled`, `last_run_at` |

---

## Authentication

The app uses **two types of auth** with the AP API:

1. **API Key** (stored in settings) — used for most API calls: listing pieces, managing flows, connections, flow runs. This is a service-level key.

2. **JWT Token** (stored in settings) — required specifically for `POST /v1/sample-data/test-step` because that endpoint needs a real user ID (`triggeredBy` field has a foreign key to the users table). API keys provide a service principal, not a user principal, so they cause a FK constraint error.

**How to get the JWT token:**
- Open the AP dashboard in your browser
- DevTools (F12) → Application → Local Storage → `https://cloud.activepieces.com`
- Copy the value of the `token` key
- Paste it in Settings → User Authentication → "Paste Token" tab

Email/password sign-in is also available but **does not work for Google SSO accounts** (they don't have a password stored in AP's database).

---

## Running the App

```bash
cd c:\AP_work\piece-tester-web
npm run dev          # Starts both server (port 4000) + Vite client (port 5173)
```

- **Frontend dev server:** http://localhost:5173 (hot reload via Vite)
- **API server:** http://localhost:4000/api (Express, auto-reloads via `tsx watch`)
- In production, the Express server serves the built client from `client/dist/`

Scripts:
- `npm run dev` — concurrently runs server + client
- `npm run dev:server` — server only (`tsx watch`)
- `npm run dev:client` — Vite dev server only
- `npm run build` — builds client (`vite build`)

---

## Key Files to Know

| File | What it does |
|------|-------------|
| `server/src/services/ap-client.ts` | All Activepieces API calls. Has both API key (`this.http`) and JWT (`this.jwtHttp()`) axios instances. Key methods: `listPieces`, `getPieceMetadata`, `createFlow`, `applyFlowOperation`, `testStep`, `getFlowRun`, `listFlowRuns`, `deleteFlow`, `upsertConnection`, `listConnections`, `triggerWebhookProduction`. Static methods: `signIn`, `formatError`. |
| `server/src/services/test-engine.ts` | Core test orchestration. `runTests()` kicks off a batch. `testSingleActionViaTestStep()` is the primary strategy. `pollFlowRunById()` waits for completion. |
| `server/src/services/test-config-generator.ts` | Generates default test input values by inspecting a piece's action property schemas (SHORT_TEXT, NUMBER, CHECKBOX, DROPDOWN, etc.). |
| `server/src/routes/settings.ts` | Settings CRUD + `POST /sign-in` (email/password), `POST /save-token` (manual JWT paste), `POST /sign-out`. |
| `client/src/pages/PieceDetail.tsx` | Main testing workflow page: select a piece → see its actions → configure connection → auto-generate test config → run tests. |
| `client/src/pages/Settings.tsx` | API connection config + User Authentication (two tabs: paste token / email+password). |
| `client/src/lib/api.ts` | Typed fetch wrapper with all API methods the frontend uses. |

---

## What Was Done (Chronological)

1. **Project scaffolding** — package.json, tsconfig, Vite, Tailwind, directory structure
2. **SQLite schema + queries** — 5 tables with full CRUD
3. **AP API client** — ported from CLI tool, extended with JWT support
4. **Connection builder** — handles OAUTH2, SECRET_TEXT, BASIC_AUTH, CUSTOM_AUTH, API_KEY types
5. **Test engine** — evolved through 4 iterations:
   - v1: `test-step` with API key → failed (FK constraint on `triggeredBy`)
   - v2: async draft webhook + polling → failed (TESTING runs invisible to list endpoint)
   - v3: sync draft webhook → failed (Cloudflare 504 timeout)
   - v4: production webhook → failed (metadata queue delays, runs discarded on cleanup)
   - **v5 (current): `test-step` with JWT** → works!
6. **Test config auto-generator** — inspects piece schemas, generates sensible defaults
7. **All backend routes** — settings, pieces, connections, tests, history, schedules
8. **All frontend pages** — Dashboard, Pieces, PieceDetail, Connections, TestRunner, History, Settings
9. **Scheduler** — node-cron based, loads from DB on startup
10. **JWT authentication** — sign-in (email/password) + manual token paste + sign-out
11. **Diagnostic script** — standalone step-by-step API debugging tool

---

## Known Issues / Limitations

- **JWT tokens expire** — if tests start failing with 401, re-paste a fresh token from the AP dashboard
- **Webhook fallback is unreliable on AP Cloud** — only useful for self-hosted AP instances
- **Test config auto-generation** produces placeholder values — for actions that need real resource IDs (e.g., a specific spreadsheet ID), you need to edit the generated config manually
- **No OAuth flow in-app** — you can't do "Connect with Google" inside this tool; import connections from your AP dashboard instead

---

## How to Continue Development

1. Open `C:\AP_work\piece-tester-web` as a Cursor workspace
2. Run `npm run dev` to start the app
3. Visit http://localhost:5173

**Potential next steps:**
- Add bulk test running from the Pieces page
- Add retry logic for flaky tests
- Add email/Slack notifications for scheduled test failures
- Improve test config generation with smarter defaults
- Add a "Test All Pieces" button on the Dashboard
- Handle JWT token refresh automatically
- Add export/import of test configurations

# Vendor Watch: bulk-safe — implementation plan

**Goal:** let the team start watchers for ~230 pieces (top 200 by Cloud usage + 69 Enterprise pieces) from the UI without hurting the live tester. Today a big batch would: take all 3 shared AI slots for hours, hit GitHub's unauthenticated 60 requests/hour limit and silently build weaker watchers (and degrade the existing test-config generator), hammer Cloud for 5 min on a catalog refresh, and flood an inbox that silently caps at 500 rows and hides its File/Dismiss buttons off-screen.

**Spec:** none separate; this plan is the spec. Parent design: `docs/superpowers/specs/2026-10-06-vendor-watch-design.md` and `docs/superpowers/specs/2026-10-07-vendor-watch-importance-design.md`.

**Repo:** piece-tester-web, worktree `/home/ibrahim/AP_work/Activepieces_v/ptw-vw-bulksafe`, branch `feat/vendor-watch-bulk-safe` off `origin/main` 3d1104c.

## Global Constraints

- Tests: `npx vitest run <files>` for touched areas while working; `npm test` (whole suite) once at the end of each task. Typecheck: `npx tsc --noEmit -p .`. Client build: `npm run build:client` only in the final task. Memory on this machine is tight: never run two of these at once.
- Commit messages: Conventional Commits, scope `vendor-watch` (or `settings` for the GitHub token card). End every commit message with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Match the surrounding code: comment density, naming, Tailwind classes, React Query patterns, `getDb().run/all/get` query style, guarded `ALTER TABLE` migrations in `server/src/db/schema.ts`.
- Nothing may start on its own at boot: no AI call, no GitHub call, no Cloud call, no queue resume. Existing features must behave exactly as before when no GitHub token is set, except where this plan says so.
- Never log or return a secret. The GitHub token is stored like `linear_api_key` (plain column in `settings`, masked in `maskedSettings`, never returned raw).
- Database changes are additive only: new column with a default via the guarded ALTER pattern, `CREATE INDEX IF NOT EXISTS`. No table rebuilds, no CHECK constraints.

## Task 1: GitHub API helper with optional token (server)

Files: new `server/src/services/github-api.ts` (+ `github-api.test.ts`); `server/src/db/schema.ts`; `server/src/db/queries.ts`; `server/src/routes/settings-view.ts` (+ its test); `server/src/routes/settings.ts`; `server/src/agents/v2/tools/fetch-source.ts`; `server/src/services/ai-config-generator.ts`.

1. Settings column `github_token TEXT NOT NULL DEFAULT ''` via the guarded-ALTER list pattern next to `linear_api_key`. Add to the `Settings` type, `updateSettings` (same `?? current` pattern), and `maskedSettings`: `has_github_token: boolean`, `github_token_masked: maskLong(token, 4, 12)`-style (reuse `maskLong` like the Linear key; the raw token is never in the output).
2. `github-api.ts`:
   - `githubApiGet(url: string, opts?: { timeout?: number })` → axios GET with `Accept: application/vnd.github.v3+json`, `User-Agent: piece-tester`, and `Authorization: Bearer <token>` only when `getSettings().github_token` is non-empty. Returns the axios response.
   - Rate-limit detection: a response or error with status 403 or 429 AND header `x-ratelimit-remaining` === `'0'` is a rate-limit hit. On a hit, record `rateLimitedUntil = Number(x-ratelimit-reset) * 1000` (fallback `Date.now() + 60 * 60_000` if the header is missing/invalid), log once per hit `[github] rate limit reached; resets at <ISO>` and throw `GitHubRateLimitError` (exported class, `name = 'GitHubRateLimitError'`, carries `resetAt: number`).
   - `getGitHubRateLimitedUntil(): number` (0 when not limited or already past) and `githubRateLimitHitsSince(ts: number): boolean` (true if a hit was recorded at or after `ts`; keep the timestamp of the last hit).
   - `validateGitHubToken(token)` → GET `https://api.github.com/rate_limit` with that token; resolves `{ limit: number }` when status 200 and `resources.core.limit > 60`; otherwise throws an Error with a human message ("GitHub rejected the token" / "Token accepted but still on the 60/hour limit").
   - Export a test seam (injectable axios or `__setHttpForTests`) consistent with how nearby services are tested.
3. Routes in `settings.ts`, next to the Linear ones: `POST /save-github-token` (body `{ token }`, trims, 400 when empty, validates with `validateGitHubToken`, 400 with the message on failure, then saves; responds `{ success: true, limit }`) and `POST /remove-github-token` (clears; `{ success: true }`).
4. `fetch-source.ts` and `ai-config-generator.ts`: replace the direct `axios.get('https://api.github.com/...')` actions-dir listing with `githubApiGet`. Raw file downloads (`raw.githubusercontent.com`, `download_url`) stay as they are. In `fetchPieceSourceFromGitHub` (fetch-source.ts) a `GitHubRateLimitError` must not be swallowed silently: still return whatever files were read, plus a final section `=== NOTE ===\nGitHub API rate limit reached: the action files under src/lib/actions were not read.` In `ai-config-generator.ts` keep its existing fallback behavior but log the rate-limit hit (the helper already logs).
5. Tests: token header present/absent; rate-limit detection on 403+remaining 0 and on 429; 403 with remaining > 0 is NOT a rate-limit hit; `rateLimitedUntil` from the reset header and the fallback; `validateGitHubToken` success and both failure messages; masked settings never contain the raw token; fetch-source adds the NOTE on a rate-limit hit and still returns index.ts content.

## Task 2: GitHub token card on the Settings page (client)

Files: new `client/src/components/GitHubTokenCard.tsx`; `client/src/pages/Settings.tsx` (mount it directly after `<LinearBugTrendCard />`); `client/src/lib/api.ts`.

- `api.saveGitHubToken(token)` → `POST /settings/save-github-token` (same base path the Linear calls use), `api.removeGitHubToken()`.
- Card modeled on `LinearBugTrendCard` (same layout, classes, saving/removing states, error text in red, success text). Title "GitHub token". One-line help: "Optional. Used to read piece source code from GitHub. Without a token the server is limited to 60 GitHub API requests per hour, shared by test setup and Vendor Watch. A fine-grained token with no extra permissions (public repositories, read-only) is enough." Shows `github_token_masked` when set, with a Remove button; otherwise a password input + Save. After save show "Saved — GitHub allows <limit> requests per hour with this token."
- No new tests required beyond what exists for similar cards, but the client must typecheck.

## Task 3: Vendor Watch generation queue (server)

Files: new `server/src/services/vendor-watch/generation-queue.ts` (+ test); `server/src/services/vendor-watch/generate.ts` (+ its test); `server/src/services/vendor-watch/types.ts`; `server/src/db/vendor-watch-queries.ts` (+ test); `server/src/routes/vendor-watch.ts`.

1. New plan status `'queued'` in `PlanStatus`. New query `queuePlanGeneration(pieceName): WatchPlanRow` — like `beginPlanGeneration` but sets `status = 'queued'` (insert or update the existing row for that piece; keep existing generated data on regenerate exactly as `beginPlanGeneration` does).
2. `generation-queue.ts`: an in-memory FIFO, concurrency `VW_GENERATION_CONCURRENCY = 1` (exported constant). API:
   - `enqueueGeneration(pieceName, run: () => Promise<void>, opts?: { front?: boolean }): void` — `front: true` puts it at the head (single "Generate watcher" clicks).
   - Before starting each job: if `getGitHubRateLimitedUntil()` is in the future, wait until then plus 5 s (one timer, no busy loop), then start.
   - `getGenerationQueueState(): { pending: number; running: number; github_wait_until: string | null }`.
   - `resetGenerationQueueForTests()`.
   - A job that throws is logged and the queue moves on. Nothing is persisted; nothing resumes on boot.
3. `generate.ts`:
   - `generateWatchPlansInBackground(names)` no longer uses `submitPieceUnit`. For each unique trimmed name: if the existing plan is `generating` or `queued`, return its id and skip; else `queuePlanGeneration(name)` and `enqueueGeneration(name, () => generateWatchPlan(name, deps).then(() => {}))`.
   - The single-piece background path (the function the `POST /plans/generate` route calls) also goes through the queue with `{ front: true }`, setting the plan to `queued` first.
   - `generateWatchPlan` keeps calling `beginPlanGeneration` (→ `generating`) when it actually starts. Record `const startedAt = Date.now()` before the worker runs; if `githubRateLimitHitsSince(startedAt)` is true when completing, append the line `GitHub rate limit was hit while reading the piece source; action files may be missing. Add a GitHub token in Settings and regenerate.` to `generation_note`.
   - Drop the now-unused `submitPieceUnit` import. Do not change `batch-scheduler.ts`.
4. `reconcileVendorWatch()`: plans in `queued` become `failed` with `generation_note = 'interrupted by restart (was queued)'`; existing `generating` handling unchanged. Return counts unchanged in shape.
5. Routes: `MAX_BATCH` 100 → 300 in `routes/vendor-watch.ts`. New `GET /generation-queue` → `getGenerationQueueState()`. `DELETE /plans/:id` on a `queued` plan is allowed (the queued job must then be skipped: when a queued job starts and its plan no longer exists or is no longer `queued`, it does nothing).
6. Tests: concurrency is 1 (second job starts only after the first settles); `front` ordering; GitHub wait honored (fake timers); queued → generating → active flow via `generateWatchPlansInBackground`; duplicate names and already-queued pieces are not enqueued twice; reconcile turns queued into failed; a deleted queued plan's job is a no-op; the rate-limit note is appended only when a hit happened during that generation.

## Task 4: Indexes, findings paging, gentler catalog refresh (server)

Files: `server/src/db/schema.ts`; `server/src/db/vendor-watch-queries.ts` (+ tests); `server/src/routes/vendor-watch.ts`; `server/src/services/vendor-watch/piece-usage.ts` (+ test if it asserts the constant).

1. Indexes (`CREATE INDEX IF NOT EXISTS`, created right after the vendor tables): `idx_watch_sources_plan ON watch_sources(plan_id)`, `idx_watch_runs_plan ON watch_runs(plan_id)`, `idx_vendor_findings_plan ON vendor_findings(plan_id)`, `idx_vendor_findings_status ON vendor_findings(status)`, `idx_vendor_findings_signature ON vendor_findings(signature)`, `idx_vendor_findings_source ON vendor_findings(source_id)`, `idx_vendor_findings_run ON vendor_findings(run_id)`.
2. Findings paging: `listFindings` takes `limit` (default 100, clamp 1..200) and `offset` (default 0, min 0) instead of the hard `LIMIT 500`, and a new `countFindings(filter)` returns the total for the same filter (including importance). `GET /findings` reads `?limit=&offset=` (non-numeric → defaults) and responds `{ findings, counts, total, limit, offset }` (existing keys unchanged).
3. `piece-usage.ts`: `VERSION_CONCURRENCY` 8 → 3.
4. Tests: paging boundaries (offset past the end → empty list, total unchanged), clamp, total respects the importance filter, indexes exist after `getDb()` init and a second init is a no-op.

## Task 5: Inbox table — always-visible actions + paging (client)

Files: `client/src/components/vendor-watch/FindingsTable.tsx`; `client/src/lib/api.ts`; `client/src/lib/vendorWatch.ts` (+ test) if helpers are added.

1. The File… / Dismiss column must be visible without horizontal scrolling at a 1280 px wide window: make the actions `<th>`/`<td>` sticky on the right (`sticky right-0` with the row's background so text doesn't show through, plus a left border/shadow), and let the Affects cell wrap long snake_case names (`max-w-[16rem] break-words` or equivalent) instead of widening the table.
2. Paging: page size 100. Below the table: "Showing <from>–<to> of <total>" and Previous / Next buttons (disabled at the ends). Changing tab, piece or importance filter resets to the first page. Use the new `total/limit/offset` from the API; React Query key includes the offset.
3. Keep every existing behavior (modal, dismiss, filed tab, importance chips, piece filter).

## Task 6: Bulk selection in Generate watchers + paste Enterprise list + refresh text (client)

Files: `client/src/components/vendor-watch/GenerateWatchersModal.tsx`; `client/src/components/vendor-watch/VendorWatchConfigCard.tsx`; `client/src/lib/vendorWatch.ts` (+ `vendorWatch.test.ts`); `client/src/lib/api.ts` if needed.

1. Pure helpers in `vendorWatch.ts` (unit-tested):
   - `pickTopByUsage(pieces, n, watched: Set<string>)` → names of the `n` pieces with the highest `usage_projects`, skipping pieces whose `categories` include `'CORE'`, pieces with `usage_projects === null`, and pieces in `watched`. Ties broken by name.
   - `pickEnterprise(pieces, watched)` → names with `enterprise === 1` (or truthy) not in `watched`.
   - `parsePieceList(text, knownNames: Set<string>)` → `{ names: string[]; unknown: string[] }`. Split on newlines, commas and semicolons; trim; drop empties; dedupe; an entry without `/` becomes `@activepieces/piece-<entry lowercased, spaces → '-'>`; an entry already starting with `@` is kept as is; entries not in `knownNames` go to `unknown`.
   - "watched" = pieces with a plan whose status is not `failed` (failed ones may be re-selected).
2. Generate modal: `MAX_BATCH` 100 → 300. Add a row above the list: a number input "Top N by usage" (default 50, 1–300) with a "Select" button, a "Select all Enterprise" button, and "Clear". Selecting adds to the current selection (capped at 300). The footer shows the estimate before the submit button: `<N> selected · about $<N × 0.35, 0 decimals> · runs one at a time, about <ceil(N × 1.5 / 60)> h` (under 60 minutes show minutes). The submit confirm (`window.confirm`) repeats that estimate. The modal needs the plans list to know what is watched (reuse the existing plans query key).
3. Config card, Enterprise list: add a "Paste a list" disclosure with a textarea and an "Add" button using `parsePieceList` against the catalog (`api.listPieces`, same query key as the modal). Valid names merge into the chips (deduped, max 200 total, existing max rule); unknown entries are listed in red under the textarea ("Not found: …"). Saving still goes through the existing Save flow.
4. Whole-catalog refresh confirm text: "About 13,000 requests to cloud.activepieces.com, roughly 15–20 minutes." (was "roughly 5 minutes").
5. Watchers tab: show the queue when non-empty — a one-line note above the table "Generating one at a time: <running> running, <pending> queued" (poll `GET /generation-queue` every 30 s like the plans list) and, when `github_wait_until` is set, "waiting for GitHub rate limit until <local time>". Status badge for `queued` (neutral gray, label "queued").

## Task 7: Final verification

- `npm test` (whole suite), `npx tsc --noEmit -p .`, `npm run build:client` — one at a time.
- Update `CONTEXT.md` only if it defines plan statuses (add `queued`).
- Report counts.

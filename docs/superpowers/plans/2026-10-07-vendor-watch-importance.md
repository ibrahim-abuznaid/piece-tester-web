# Vendor Watch Importance Filter: Implementation Plan

**Goal:** rate every watched piece High / Medium / Low / Unrated, from all-versions Cloud usage plus a hand-kept
Enterprise list, then filter and sort the Vendor Watch Inbox, Filed and Watchers tabs (and the Generate picker) by it.

**Spec:** `docs/superpowers/specs/2026-10-07-vendor-watch-importance-design.md`

**Global constraints:** the same as the Vendor Watch plan: ESM `.js` server imports, no live network in tests,
public repo (no customer data), comment density like the surrounding files, and the Co-Authored-By trailer on
commits. Run `npm test` and `npx tsc --noEmit -p tsconfig.json`.

## Tasks

- [ ] **1. Schema + config.** `schema.ts`: `piece_usage` table, plus guarded `ALTER TABLE vendor_watch_config`
  for `importance_high_min`, `importance_medium_min` and `enterprise_pieces`. `vendor-watch-queries.ts`:
  `WatchConfigRow` and `CONFIG_FIELDS` gain the three fields. `config.ts`: validate the thresholds (whole numbers,
  1–1,000,000, high > medium after merging with the saved values) and `enterprise_pieces` (array of piece-name
  strings, deduped, max 200, stored as JSON). `vendor-watch-test-utils.ts`: reset the new columns and wipe
  `piece_usage`. Tests: `config.test.ts`.
- [ ] **2. Tier rule + usage queries.** `importanceSelect(nameExpr)` (the one SQL `CASE`), `upsertPieceUsage`,
  `listPieceUsage`, `usageSummary`, and `stalePieces(names, maxAgeDays)`. `listFindings` gains `importance[]` and
  `sort`, and returns the four new fields. `countFindingsByImportance`. `listPlans` gains the fields and orders by
  importance. `getPieceImportance(name)` for the ticket. Tests: `vendor-watch-queries.importance.test.ts`.
- [ ] **3. Usage fetcher.** `services/vendor-watch/piece-usage.ts`: `fetchCloudUsage(names | 'all', deps)`
  (flags → registry → per-version, 8 at a time, 20 s timeout, failures counted), `refreshPieceUsage(scope, deps)`
  (single-flight, progress, writes rows, all-failed keeps the old row), `getUsageRefreshState()`, and
  `ensureWatchedUsage(deps)` (stale > 7 d or missing, 1 h back-off). Tests: `piece-usage.test.ts` with an injected
  `fetchJson`.
- [ ] **4. Routes.** `GET /findings` → `{ findings, counts }` with `importance` and inbox sort. `GET /plans` adds the
  fields. `GET /usage`, `POST /usage/refresh` (409 while running). Both GETs call `ensureWatchedUsage()`, fire and
  forget.
- [ ] **5. Ticket line.** `TicketContext.importance?`, then `buildTicketDraft` adds `**Importance:** …`.
  `filing.ts` fills it from `getPieceImportance`. Tests: `ticket-draft.test.ts`.
- [ ] **6. Client types + helpers.** `api.ts`: `VwImportance`, the new row fields, `vwFindings(status, piece,
  importance)` → `{ findings, counts }`, `vwUsage`, `vwRefreshUsage`, and the config fields. `lib/vendorWatch.ts`:
  `IMPORTANCE_ORDER`, `parseImportanceParam`, `importanceTitle()`. Tests: `client/src/lib/vendorWatch.test.ts`.
- [ ] **7. Components.** `ImportanceBadge.tsx` and `ImportanceFilter.tsx`. Wire them into `FindingsTable`
  (column + chips), `WatchersTab` (column + chips + client-side filter), `GenerateWatchersModal` (badges, sort by
  projects, chips), and `VendorWatch.tsx` (the `importance` URL param, shared across tabs).
- [ ] **8. Config section.** `VendorWatchConfigCard`: the thresholds, the Enterprise list editor with catalog
  type-ahead, usage status and the two refresh buttons with progress.
- [ ] **9. Verify.** Full suite, tsc, client build. Seed a scratch DB with watchers and findings for pieces of
  different usage, run a real `watched` refresh against Cloud (read-only public endpoints), and click through
  Inbox / Filed / Watchers / Generate / Config. Review the whole branch, then fold in the fixes.

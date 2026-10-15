# Separate out-of-credits failures from piece bugs

**Date:** 2026-10-14
**Branch:** `feat/quota-error-category` (off `main`)
**Status:** Design — approved, implementation not started

## Problem

A piece can fail because the vendor account behind its connection is out of
credits, over a plan limit, or has a billing problem. Nothing in the piece is
wrong and nothing in the tester can fix it. Example (Hugging Face):

```
Piece error{"status":"FAILED","errorMessage":"{\"__apErrorVersion\":1,\"message\":\"Failed to perform inference: You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers. ...
```

The deterministic classifier `classifyError` in
`server/src/services/plan-executor.ts` has no billing vocabulary. Only the
generic phrase "quota exceeded" is recognised, and it maps to `rate_limit`.
Everything else about credits falls through to `piece_error`, which the rest
of the app treats as the strongest piece-implicating signal:

- `getAttentionItems` puts it in the red `likely_broken` lane after two
  failures, with the reason "failed N× in a row · piece_error".
- `getPieceHealth` lists it as a failing action with a red `piece_error` chip.
- `ErrorPlaybook` shows the "likely piece bug" chip and suggests "Run the AI
  fixer".
- `categorySeverity` ranks it highest, so it becomes a wave's
  `worst_category` in the Scheduled Runs feed.
- The alert engine treats it as piece-implicating and pings Discord.
- The Reports "why tests fail" chart has a second classifier,
  `categorizeError` in `regression-classifier.ts`, which buckets it as
  `other`.

The user wants these failures separated so a red on the Health tab keeps
meaning "a real piece bug".

## Decision

Add a new error category, `quota`, with its own "Credits" column on the
Health board. Derive the category from the stored error text when the board is
read, so items already on the board move lanes without a migration.

Considered and rejected:

- A one-off migration rewriting `errorCategory` inside stored `step_results`.
  More code, edits history in place, no benefit over reclassifying on read.
- New runs only. Items already red would stay red until their next scheduled
  run, which with the monthly stagger can be weeks away.
- Folding credit errors into the existing transient / rate-limit lane. Cheapest,
  but billing and a flaky network error would be indistinguishable.

## Changes

### 1. Classifier moves to its own module

New pure module `server/src/services/error-category.ts`:

- `export type ErrorCategory = 'auth' | 'rate_limit' | 'transient' | 'bad_request' | 'not_found' | 'piece_error' | 'quota' | 'unknown'`
- `export function isQuotaError(raw: string): boolean` — the billing
  vocabulary plus HTTP 402, shared by both classifiers.
- `export function classifyError(raw: string): ErrorCategory` — moved from
  `plan-executor.ts`. Reads the error through `parseApError` (see below), checks
  `quota` first, then the HTTP status, then the old keyword rules.
- `export function categoryOfStep(step: { error?: string | null; errorCategory?: string | null }): string`
  — `classifyError(step.error)` when the step has error text and that yields
  something more specific than `piece_error`; else the stored `errorCategory`;
  else `piece_error`. The stored error is capped at 8 KB while the executor
  classified the full message, so a stored category is never thrown away for
  a weaker re-read.

`plan-executor.ts` imports `classifyError` and re-exports the `ErrorCategory`
type so existing imports keep working.

`isQuotaError` lowercases the message and matches any of (case-insensitive):

- `payment required`
- `(no remaining|out of|insufficient|not enough|exhausted) (pre-?paid |your |more |additional )?credits?\b`,
  `(purchase|buy|top.?up) (pre-?paid |your |more |additional )?credits\b` (plural, so "purchase credit card" does not match),
  `credits? (exhausted|depleted)`, `(not|n't) (have )?enough credits`,
  `max(imum)? credits (exceeded|reached)`
- `credit balance (is )?(too low|insufficient|exhausted|depleted|zero|negative)`,
  `insufficient_quota`, `insufficient (account )?(funds|balance|quota)`,
  `(reached|exceeded) your (current |monthly |usage |plan |spending )(limit|quota)\b`,
  `exceeded your quota\b`, `exceeds your (\w+ )?quota\b`
- `(check|update|add|verify) (your )?billing (details|account|information)`,
  `billing (issue|problem)`,
  `upgrade (your|to a|the) (plan|subscription|account)`,
  `not available on your (current )?plan`, `requires an? (\w+ )?plan\b`
- `(plan|usage|monthly|spending) (limit|quota) (reached|exceeded|hit)`,
  `(daily|monthly) (\w+ )?quota (reached|exceeded)`,
  `trial (has |is |has been )?(expired|ended)`,
  `subscription (has |is |has been |was )?(expired|ended|lapsed|inactive|not active)`,
  `account (is |has been |was )?suspended`

The exact regexes live in the module; the table-driven test is the contract.

**What the classifier reads.** The stored error is AP's wrapper: the vendor's
`message` and `responseBody`, plus the step's `requestBody`, `raw` stack and
output. Only the vendor's reply is evidence. Test input such as a Slack message
saying "Please upgrade your plan", or a Gmail subject "Your trial has expired",
must not turn a 404 into `quota`. So when the error is JSON, `parseApError`
extracts the message, the response body and the numeric status, and only the
message and response body are matched. A plain-string error is matched whole. Non-wrapper JSON is matched whole, but
its status comes only from a top-level numeric `status`, `statusCode` or
`status_code`. A wrapper cut at the 8 KB storage cap no longer parses, so it is
matched only up to its first `requestBody`, `apiMessage`, `raw` or `output`
key. AP writes the vendor's message, status and response body before those
keys. `categorizeError` passes the original (not lowercased) error to
`isQuotaError` so the wrapper still parses.

The status comes from the parsed `status`/`statusCode`. For a plain string, or
a parsed message with no status field, it comes from `status code NNN` in the
message (never the response body, where a batch item can carry its own 402).
402 → `quota`. Otherwise, after the quota words, a known status decides:
401/403 → `auth`, 429 → `rate_limit`, 500–504 → `transient`, 400/422 →
`bad_request`, 404 → `not_found`. With no known status, the old keyword rules
run on the same text.

Bare billing nouns that Stripe or Google Cloud Billing use as object names
(`credit balance transaction`, `billing account`, `subscription is canceled`)
do not match on their own, and "exceeded your limit" needs a billing qualifier
so a per-minute limit stays `rate_limit`. "Upgrade your plan" is treated as
`quota` even when it rides on a 429: an account-tier wall does not clear by
itself. Known limit: a vendor that reports a test-mode decline as
"insufficient funds" (Stripe's test card) reads as `quota`; that phrase is
genuinely ambiguous. A piece whose own action is about credits or plans
("Failed to buy credits for user: id is required") can also read as `quota`;
no such piece has shown up.

`quota` is checked before the status because vendors return billing failures
under 401, 402, 403 and 429 alike: Hugging Face uses 402, ElevenLabs 401,
SendGrid 403 ("Maximum credits exceeded"), and OpenAI sends
`insufficient_quota` with 429. The generic phrase "quota exceeded"
stays under `rate_limit`: Google uses it for per-minute limits, and it carries
no billing words. The word "credentials" never matches: the credit patterns
require `credit` or `credits` as a whole word.

### 2. Board and alert paths reclassify on read

The executor stores the same string it classifies (`sr.error = message;
sr.errorCategory = classifyError(message)`), so the stored error text is a
faithful input.

- `analyzeFailedRun` in `server/src/db/queries.ts` uses `categoryOfStep`
  instead of `thrown.errorCategory || 'piece_error'`. This feeds both
  `getAttentionItems` and `getPieceHealth`.
- `analyzeRun` in `server/src/services/alert-engine.ts` does the same.

Cost: one regex pass per latest failed run per plan. Both queries already
filter to failed and blocked rows.

One side effect: a batch run that never started (`'Run failed to start: …'`
from `plan-batch.ts`, which carries the raw executor error and no stored
category) is now classified from that message, so an AP connection refusal
or expired token reads as `transient` or `auth` instead of `piece_error`.

The per-step badge inside a run's detail view (`TestPlanView`) keeps the
stored `errorCategory`, so only historical run detail can disagree with the
board. New runs are consistent everywhere.

Tests that seed `step_results` with an `errorCategory` must seed matching
error text, since the stored category is now only a fallback.

### 3. Health board "Credits" column

In `getAttentionItems`:

- `bucket` union gains `'quota'`; a `quota` category maps to it regardless of
  streak.
- reason: `out of credits — vendor account needs billing, not a piece bug`.
- sort order: `likely_broken` 0, `reauth` 1, `watching` 2, `quota` 3,
  `noise` 4.

The Health tab is `Dashboard` → `HealthBoard`, which lanes failing pieces into
columns through `client/src/lib/healthBoard.ts`. (`NeedsAttention.tsx` is no
longer mounted anywhere and is left untouched.) The board gains a fifth
column, key `quota`, label `Credits`, hint `vendor account out of credits or
over its plan — top up, not a piece bug`, placed between Connection and
Reported with a fuchsia dot. The board has no collapsed state, so this is the
column-board equivalent of the "own lane, out of the red" choice: visible at
a glance, never counted as an error.

Precedence per failing action: Muted > Reported > Connection > Credits >
Errors. Per piece: all actions muted → Muted; reported → Reported; any live
error → Errors; else any connection issue → Connection; else Credits.
`pieceKindCounts` gains a `quota` count. A Credits-lane card wears a fuchsia
"N out of credits" chip instead of the red "N failing" one, and a card in
another lane shows an extra "N credits" chip when some of its actions are
quota failures.
`PieceDrawer` already makes a piece reportable only in the Errors lane, so a
Credits piece is never offered "Report to Pieces team".

The card's one-line error hint (`shortenError`) goes through `parseApError`,
so a Credits card reads "Failed to perform inference: You have no remaining
credits…" instead of the start of the wrapper JSON.

### 4. Playbook, chips, severity, alerts

- `ErrorPlaybook.tsx`: new `Blame` value `account` with chip label
  `vendor account` (fuchsia classes). New `case 'quota'`:
  diagnosis "The vendor account is out of credits or over its plan limit.
  Nothing to fix in the piece. Top up or upgrade the account, then retest."
  Actions: "View run details" (primary, runs) and "Check connection"
  (connections). No AI fixer.
- `ActionErrorRow.tsx` `CHIP.quota` and `ScheduledRunsFeed.tsx`
  `CATEGORY_STYLE.quota`: `bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25`.
- `categorySeverity` in `queries.ts`: `quota` → 1, same as `transient` and
  `rate_limit`, so it never becomes a wave's `worst_category` over a real
  fault.
- `alert-engine.ts`: `ENV_NOISE` gains `quota`. No Discord alert is created
  or re-opened for it.

### 5. Reports chart

- `FailureCategory` in `regression-classifier.ts` gains `quota`;
  `categorizeError` checks `isQuotaError` first.
- `Reports.tsx` `CATEGORY_META.quota = { label: 'Credits / quota', color: '#e879f9' }`.

### 6. Client types

`client/src/lib/api.ts`: `ErrorCategory` gains `'quota'`;
`AttentionItem.bucket` gains `'quota'`.

## Tests

- `server/src/services/error-category.test.ts` (new, table-driven):
  - the Hugging Face message, in the stored wrapper form → `quota`
  - `You exceeded your current quota, please check your plan and billing details.` → `quota`
  - `Request failed with status code 402` → `quota`
  - `Your credit balance is too low to access the API.` → `quota`
  - `International calling requires a completed purchase ... buy credits or turn on auto-recharge` (seen in the local DB) → `quota`
  - `Calling to this destination is temporarily limited to one call per minute` (same DB) → `rate_limit`
  - `Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'` → `rate_limit`
  - `Request failed with status code 429` → `rate_limit`
  - `invalid credentials` and `401 Unauthorized` → `auth`
  - an unrecognised message → `piece_error`
  - `Your subscription is inactive`, `Your account has been suspended`,
    `Credits exhausted`, `You do not have enough credits` → `quota`
  - `403: Your credit balance is too low` → `quota` (pins quota ahead of auth)
  - `Rate limit exceeded. Upgrade your plan for higher limits.` → `quota`
  - a wrapper with `401 Unauthorized` and `"id":402` in its output, and a
    `401` with a `:402:13` stack line → `auth`
  - `400: subscription cancel_at_period_end is invalid` and
    `400: This subscription is canceled` → `bad_request`;
    `404: credit balance transaction not found` and
    `404: The billing account was not found` → `not_found`
  - `429: You have exceeded your limit of 100 requests per minute` → `rate_limit`
  - `{"status_code":402,...}` → `quota`; a 404 whose output says
    "you have enough credits" → `not_found`
  - `categoryOfStep`: error text wins over a stale stored category; stored
    category is used when `error` is null; `piece_error` when both are missing.
- `regression-classifier.test.ts`: add the OpenAI and 402 rows → `quota`, and
  the per-minute Google row → `other` (this classifier has no per-minute rule;
  the row pins that generic "quota exceeded" is not billing).
- `alert-engine.test.ts`: `quota` is not in `PIECE_IMPLICATING`; a run whose
  failed step carries a credits message creates no alert even when the stored
  category says `piece_error`.
- `queries.attention.test.ts`: a plan whose latest run failed with a credits
  message and a stored `piece_error` category lands in bucket `quota` with
  the billing reason, and is excluded from `likely_broken` after repeated
  failures.
- `client/src/lib/healthBoard.test.ts`: a quota action lands in the `quota`
  column; muted and reported still win; a quota-only piece sits in Credits
  while a live error or connection issue pulls the piece to Errors or
  Connection; counts include `quota`; `groupPiecesByColumn` has the lane.
- On AP-wrapped failures: billing words in `requestBody` (Slack 404, Gmail
  400) do not make `quota`; a 402 in a batch response item does not either; a
  generic message with a billing reason in `responseBody` is `quota`; a nested
  status 402 is `quota`; a keyword-free 403 and 503 map by status.
- More billing walls: SendGrid 403 "Maximum credits exceeded", ElevenLabs 401
  "exceeds your quota … credits remaining", 403 "not available on your current
  plan", 403 "requires a Pro plan", "Daily message quota exceeded" → `quota`.
- `queries.attention.test.ts`: the card's error hint is the vendor message,
  not the wrapper JSON.
- Manual: Health tab shows the Credits column with the Hugging Face piece, its
  drawer row shows the `quota` chip and the "vendor account" playbook, and the
  Errors column no longer lists it. Checked in headless Chrome.

## Rollout

No schema change and no migration. After deploy, the first load of the Health
tab moves existing credit failures into the Credits column.

## Not doing

- A time-boxed "mute for 30 days" action. The lane is collapsed by default;
  the existing Quarantine button covers anything louder.
- Merging the two classifiers (`classifyError` and `categorizeError`). They
  share the quota vocabulary through `isQuotaError`; the rest stays as is.
- Vendor billing deep links. The tester does not know each vendor's billing
  page.

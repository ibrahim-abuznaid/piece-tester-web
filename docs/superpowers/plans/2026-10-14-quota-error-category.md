# Quota Error Category: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a piece that fails because the vendor account is out of credits lands in its own "Credits" column on the Health board instead of the reportable Errors column, everywhere the tester reads an error category.

**Architecture:** the regex classifier moves out of `plan-executor.ts` into a pure module `error-category.ts` that gains a `quota` category and a shared `isQuotaError` vocabulary. The board, inbox and alert paths re-derive the category from the stored error text (`categoryOfStep`), so existing items move lanes with no migration. The client learns the new bucket, board column, chip and playbook entry.

**Tech Stack:** TypeScript, Express + better-sqlite3 (server), React + TanStack Query + lucide-react + Tailwind (client), vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-quota-error-category-design.md`

**Global constraints:** ESM `.js` suffix on server imports; no live network in tests; comment density like the surrounding files; **no per-task commits** — one grouped code commit plus one docs commit at the end, after the user has tested; **no Co-Authored-By trailer**. Verify with `npm test` and `npx tsc --noEmit -p tsconfig.json` (the root tsconfig covers both server and client).

---

## Tasks

### Task 1: Classifier module with the `quota` category

> Superseded in part by Task 7b: the classifier below scans the whole wrapper;
> the shipped one reads only the parsed vendor reply and status.

**Files:**
- Create: `server/src/services/error-category.ts`
- Create: `server/src/services/error-category.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/error-category.test.ts
import { describe, it, expect } from 'vitest';
import { classifyError, categoryOfStep, isQuotaError } from './error-category.js';

// The stored form: the executor's wrapper around AP's JSON error, two levels deep.
const HF_STORED = JSON.stringify({
  status: 'FAILED',
  errorMessage: JSON.stringify({
    __apErrorVersion: 1,
    message: 'Failed to perform inference: You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers.',
    code: 'PIECE_ERROR',
    status: 402,
  }),
  output: null,
});

const PER_MINUTE_STORED = JSON.stringify({
  status: 'FAILED',
  errorMessage: JSON.stringify({
    message: 'Calling to this destination is temporarily limited to one call per minute. Complete account verification or increase your calling balance to lift this restriction.',
    status: 429,
  }),
});

describe('classifyError', () => {
  it.each([
    [HF_STORED, 'quota'],
    ['You exceeded your current quota, please check your plan and billing details.', 'quota'],
    ['Request failed with status code 402', 'quota'],
    ['Your credit balance is too low to access the API.', 'quota'],
    ['International calling requires a completed purchase. Adding a card by itself does not enable it — buy credits or turn on auto-recharge.', 'quota'],
    ['Request failed with status code 429: insufficient_quota', 'quota'],
    [PER_MINUTE_STORED, 'rate_limit'],
    ["Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'", 'rate_limit'],
    ['Request failed with status code 429', 'rate_limit'],
    ['invalid credentials', 'auth'],
    ['401 Unauthorized', 'auth'],
    ['Request failed with status code 503', 'transient'],
    ['Request failed with status code 404', 'not_found'],
    ['Request failed with status code 422: name is required', 'bad_request'],
    ["Cannot read properties of undefined (reading 'id')", 'piece_error'],
    ['Your subscription is inactive', 'quota'],
    ['Your account has been suspended', 'quota'],
    ['Credits exhausted', 'quota'],
    ['You do not have enough credits', 'quota'],
    // Pins quota ahead of auth: a 403 with billing wording is a billing problem.
    ['Request failed with status code 403: Your credit balance is too low', 'quota'],
    // Deliberate: "upgrade your plan" is an account-tier wall, not a flake.
    ['Rate limit exceeded. Upgrade your plan for higher limits.', 'quota'],
    // 402 only counts next to a status field — not inside output or a stack trace.
    ['{"status":"FAILED","errorMessage":"401 Unauthorized","output":{"id":402}}', 'auth'],
    ['Error: 401 Unauthorized\n    at handler (/app/index.js:402:13)', 'auth'],
    // Billing-domain pieces (Stripe, Google Cloud Billing) name these objects in ordinary errors.
    ['Request failed with status code 400: subscription cancel_at_period_end is invalid', 'bad_request'],
    ['Request failed with status code 404: credit balance transaction not found', 'not_found'],
    ['Request failed with status code 404: The billing account was not found', 'not_found'],
    ['Request failed with status code 400: This subscription is canceled', 'bad_request'],
    // A per-minute limit is a rate limit even when phrased as "your limit".
    ['Request failed with status code 429: You have exceeded your limit of 100 requests per minute', 'rate_limit'],
    ['{"status_code":402,"detail":"Payment needed"}', 'quota'],
    // Positive wording in step output must not flip a real error.
    ['{"status":"FAILED","errorMessage":"404 Not Found","output":{"note":"you have enough credits"}}', 'not_found'],
  ])('classifies %j as %j', (message, expected) => {
    expect(classifyError(message)).toBe(expected);
  });
});

describe('isQuotaError', () => {
  it('does not fire on the word "credentials"', () => {
    expect(isQuotaError('Invalid credentials supplied')).toBe(false);
  });
  it('does not fire on a bare 402 with no status context', () => {
    expect(isQuotaError('Error processing invoice 402')).toBe(false);
  });
});

describe('categoryOfStep', () => {
  it('re-derives the category from the error text over a stale stored category', () => {
    expect(categoryOfStep({ error: HF_STORED, errorCategory: 'piece_error' })).toBe('quota');
  });
  it('uses the stored category when there is no error text', () => {
    expect(categoryOfStep({ error: null, errorCategory: 'auth' })).toBe('auth');
  });
  it('keeps a more specific stored category when the text yields only piece_error', () => {
    expect(categoryOfStep({ error: 'boom', errorCategory: 'transient' })).toBe('transient');
  });
  it('defaults to piece_error when both are missing', () => {
    expect(categoryOfStep({})).toBe('piece_error');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/src/services/error-category.test.ts`
Expected: FAIL — cannot resolve `./error-category.js`.

- [ ] **Step 3: Write the module**

```ts
// server/src/services/error-category.ts
// Deterministic error classification for a thrown step — status codes + message, never an LLM.
// `auth`, `rate_limit`, `transient` and `quota` never implicate the piece; the rest can.
export type ErrorCategory =
  | 'auth' | 'rate_limit' | 'transient' | 'bad_request' | 'not_found' | 'piece_error' | 'quota' | 'unknown';

// Vendor account out of credits / over its plan / unpaid. Checked before auth and
// rate_limit because vendors return these under 402, 403 and 429 alike. The message is
// the whole stored wrapper (step output included), so 402 is tied to a status field and
// bare billing nouns (Stripe's "credit balance transaction") are not enough. The generic
// "quota exceeded" is deliberately absent: Google uses it for per-minute limits.
const QUOTA_PATTERNS = [
  /status([\s_]?code)?\W{0,6}402\b|payment required/,
  /(no remaining|out of|insufficient|not enough|exhausted|purchase|buy|top.?up) (pre-?paid |your |more |additional )?credits?\b|credits? (exhausted|depleted)|(not|n't) (have )?enough credits/,
  /credit balance (is )?(too low|insufficient|exhausted|depleted|zero|negative)|insufficient_quota|insufficient (account )?(funds|balance|quota)|(reached|exceeded) your (current |monthly |usage |plan |spending )(limit|quota)\b|exceeded your quota\b/,
  /(check|update|add|verify) (your )?billing (details|account|information)|billing (issue|problem)|check your plan|upgrade (your|to a|the) (plan|subscription|account)/,
  /(plan|usage|monthly|spending) (limit|quota) (reached|exceeded|hit)|trial (has |is |has been )?(expired|ended)|subscription (has |is |has been |was )?(expired|ended|lapsed|inactive|not active)|account (is |has been |was )?suspended/,
];

export function isQuotaError(message: string): boolean {
  const m = (message || '').toLowerCase();
  return QUOTA_PATTERNS.some(re => re.test(m));
}

export function classifyError(message: string): ErrorCategory {
  const m = (message || '').toLowerCase();
  if (isQuotaError(m)) return 'quota';
  if (/\b(401|403)\b/.test(m) || /unauthor|forbidden|invalid token|token (is )?expired|expired token|credential|permission|access denied|not authenticated/.test(m)) return 'auth';
  if (/\b429\b/.test(m) || /rate.?limit|too many requests|quota exceeded/.test(m)) return 'rate_limit';
  if (/\b(500|502|503|504)\b/.test(m) || /timeout|timed out|econnreset|econnrefused|socket hang up|network error|temporarily unavailable|service unavailable|getaddrinfo|enotfound/.test(m)) return 'transient';
  if (/\b(400|422)\b/.test(m) || /validation|invalid (input|value|parameter|param|request|body|argument)|is required|missing required|must be a|bad request/.test(m)) return 'bad_request';
  if (/\b404\b/.test(m) || /not found|does not exist|no such/.test(m)) return 'not_found';
  return 'piece_error';
}

/**
 * Category of a stored failed step. Re-derived from the error text so classifier
 * improvements apply to history; the stored category is kept when the text yields
 * nothing more specific (the stored error is capped at 8 KB, the live one was not).
 */
export function categoryOfStep(step: { error?: string | null; errorCategory?: string | null }): string {
  const derived = step.error ? classifyError(String(step.error)) : null;
  if (derived && derived !== 'piece_error') return derived;
  return step.errorCategory || derived || 'piece_error';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/src/services/error-category.test.ts`
Expected: PASS, 36 tests.

### Task 2: Executor uses the module

**Files:**
- Modify: `server/src/services/plan-executor.ts:22-29` (type block) and `:139-148` (local `classifyError`)

- [ ] **Step 1: Replace the local type with a re-export and import the classifier**

Replace lines 22–29 (the doc comment plus `export type ErrorCategory = ...`) with:

```ts
import { classifyError, type ErrorCategory } from './error-category.js';
export type { ErrorCategory };
```

Keep this next to the other imports (above the `// ── Types ──` banner). `StepResult.errorCategory?: ErrorCategory` at line 54 keeps working.

- [ ] **Step 2: Delete the local function**

Remove lines 139–148 (`/** Deterministically classify ... */` through the closing `}` of `function classifyError`). The call at `sr.errorCategory = classifyError(message);` (around line 703) now resolves to the import.

- [ ] **Step 3: Typecheck and run the executor suites**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run server/src/services/plan-executor`
Expected: no type errors; all plan-executor test files PASS.

### Task 3: Board and inbox reclassify on read, new bucket

**Files:**
- Modify: `server/src/db/queries.ts:1-3` (imports), `:988` (`bucket` union), `:1011-1021` (`analyzeFailedRun`), `:1075-1086` (bucket + reason), `:1106` (sort order), `:1209-1219` (`categorySeverity`)
- Test: `server/src/db/queries.attention.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/db/queries.attention.test.ts`:

```ts
describe('getAttentionItems — out of credits', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  // Stored with the stale piece_error category the old classifier assigned.
  const credits = JSON.stringify([{
    stepId: 'test', status: 'failed', errorCategory: 'piece_error',
    error: JSON.stringify({
      status: 'FAILED',
      errorMessage: JSON.stringify({ message: 'Failed to perform inference: You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers.', status: 402 }),
    }),
  }]);

  it('lands in the quota lane even with a stale stored piece_error category', () => {
    const plan = seedPlan('hugging-face', 'inference');
    seedScheduledRun(plan, 'failed', credits);
    const item = getAttentionItems().find(i => i.piece_name === 'hugging-face')!;
    expect(item.bucket).toBe('quota');
    expect(item.category).toBe('quota');
    expect(item.reason).toBe('out of credits — vendor account needs billing, not a piece bug');
  });

  it('never escalates to likely_broken on repeated failures', () => {
    const plan = seedPlan('hugging-face', 'inference');
    seedScheduledRun(plan, 'failed', credits);
    seedScheduledRun(plan, 'failed', credits);
    seedScheduledRun(plan, 'failed', credits);
    const item = getAttentionItems().find(i => i.piece_name === 'hugging-face')!;
    expect(item.bucket).toBe('quota');
    expect(item.fail_streak).toBe(3);
  });

  it('sorts after watching and before noise', () => {
    const q = seedPlan('hugging-face', 'inference');
    seedScheduledRun(q, 'failed', credits);
    const w = seedPlan('slack', 'send_message');
    seedScheduledRun(w, 'failed', JSON.stringify([{ stepId: 'test', status: 'failed', error: 'boom' }]));
    const n = seedPlan('gmail', 'send_email');
    seedScheduledRun(n, 'failed', JSON.stringify([{ stepId: 'test', status: 'failed', error: 'Request failed with status code 503' }]));
    expect(getAttentionItems().map(i => i.bucket)).toEqual(['watching', 'quota', 'noise']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run server/src/db/queries.attention.test.ts`
Expected: the three new tests FAIL (bucket is `watching` / `likely_broken`).

- [ ] **Step 3: Import the helper**

At the top of `server/src/db/queries.ts`, after the `parseApError` import:

```ts
import { categoryOfStep } from '../services/error-category.js';
```

- [ ] **Step 4: Reclassify on read**

In `analyzeFailedRun`, change the thrown branch:

```ts
    if (thrown) return { category: categoryOfStep(thrown), error: shortenError(thrown.error) };
```

- [ ] **Step 5: New bucket, reason and order**

`AttentionItem.bucket` (line 988):

```ts
  bucket: 'reauth' | 'likely_broken' | 'watching' | 'quota' | 'noise';
```

Bucket selection (replace the three-line `if` chain):

```ts
    let bucket: AttentionItem['bucket'];
    if (isBlocked || category === 'auth') bucket = 'reauth';
    else if (category === 'quota') bucket = 'quota';
    else if (category === 'transient' || category === 'rate_limit') bucket = 'noise';
    else bucket = streak >= 2 ? 'likely_broken' : 'watching';
```

Reason — insert one line after the `reauth` reason:

```ts
    else if (bucket === 'quota') reason = 'out of credits — vendor account needs billing, not a piece bug';
```

Sort order:

```ts
  const order: Record<string, number> = { likely_broken: 0, reauth: 1, watching: 2, quota: 3, noise: 4 };
```

- [ ] **Step 6: Severity**

In `categorySeverity`, add `quota` to the lowest non-zero tier:

```ts
    case 'quota':
    case 'rate_limit':
    case 'transient': return 1;
```

- [ ] **Step 7: Run the DB suites**

Run: `npx vitest run server/src/db`
Expected: PASS. If a pre-existing test seeds a step with an `errorCategory` that disagrees with its `error` text (for example `error: 'x', errorCategory: 'transient'`), change that seed's `error` to text the classifier maps to the same category (`'Request failed with status code 503'` for transient, `'401'` for auth, `'boom'` for piece_error). Do not weaken the assertion.

### Task 4: Alert engine stays quiet on quota

**Files:**
- Modify: `server/src/services/error-category.ts` (`categoryOfStep` only) and `server/src/services/error-category.test.ts`
- Modify: `server/src/services/alert-engine.ts:1-20`
- Test: `server/src/services/alert-engine.test.ts`

- [ ] **Step 0: Tighten `categoryOfStep`** (from the Task 3 review: the stored `error` is capped at 8 KB by `step-results-storage.ts`, so a status marker past the cap would be lost on re-read). Replace the function and its comment in `server/src/services/error-category.ts` with the version shown in Task 1 Step 3 (the `derived` / fallback form), and add the `keeps a more specific stored category` test from Task 1 Step 1 to the `categoryOfStep` describe. Run `npx vitest run server/src/services/error-category.test.ts` — expected 36 passing.

- [ ] **Step 1: Write the failing tests**

Add to the `analyzeRun` describe block:

```ts
  it('reclassifies a stored piece_error as quota from the error text', () => {
    const r = analyzeRun(run('failed', [{ status: 'failed', error: 'Request failed with status code 402: no remaining credits', errorCategory: 'piece_error' }]));
    expect(r.category).toBe('quota');
    expect(PIECE_IMPLICATING.has(r.category)).toBe(false);
  });
```

Add to the `retestTarget` describe block (a quota retest is neither a pass nor a piece fault, so it must not count as passed):

```ts
  it('counts an out-of-credits retest as inconclusive, never as passed', async () => {
    const r = await retestTarget(9, 1, execReturning([run('failed', [{ status: 'failed', error: 'You have no remaining credits. Purchase pre-paid credits to continue.' }])]) as any);
    expect(r).toEqual({ failed: 0, passed: 0, inconclusive: 1 });
  });
```

Add to the `processRunAlert` describe block:

```ts
  it('suppresses an out-of-credits failure — no post', async () => {
    const { deps, posts } = makeDeps();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'You have no remaining credits. Purchase pre-paid credits to continue.', errorCategory: 'piece_error' }]), stripePlan, wave, newWaveState(), deps);
    expect(posts).toHaveLength(0);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run server/src/services/alert-engine.test.ts`
Expected: the `analyzeRun` and `processRunAlert` tests FAIL (category `piece_error`, one post); the `retestTarget` test fails with `failed: 1`.

- [ ] **Step 3: Implement**

```ts
import { executePlan } from './plan-executor.js';
import { categoryOfStep } from './error-category.js';

// 'unknown' is piece-implicating on purpose: an unclassifiable failure should be
// surfaced, not silently swallowed.
export const PIECE_IMPLICATING = new Set(['piece_error', 'assert_failed', 'bad_request', 'not_found', 'unknown']);
const ENV_NOISE = new Set(['auth', 'rate_limit', 'transient', 'quota']);
```

and in `analyzeRun`:

```ts
  if (thrown) return { outcome: 'failed', category: categoryOfStep(thrown), error: shorten(thrown.error) };
```

- [ ] **Step 4: Run the suite**

Run: `npx vitest run server/src/services/alert-engine.test.ts`
Expected: PASS.

### Task 5: Reports chart bucket

**Files:**
- Modify: `server/src/services/regression-classifier.ts:126-138`
- Test: `server/src/services/regression-classifier.test.ts:76-89`

- [ ] **Step 1: Add failing rows**

In the `categorizeError` `it.each` table add:

```ts
    ['You exceeded your current quota, please check your plan and billing details.', 'quota'],
    ['Request failed with status code 402', 'quota'],
    // Generic "quota exceeded" is not billing; this classifier has no per-minute rule, so it stays `other`.
    ["Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'", 'other'],
```

Run: `npx vitest run server/src/services/regression-classifier.test.ts`
Expected: the two `quota` rows FAIL (`other`); the Google row passes already.

- [ ] **Step 2: Implement**

Add the import at the top of `regression-classifier.ts`:

```ts
import { isQuotaError } from './error-category.js';
```

Then:

```ts
export type FailureCategory =
  | 'auth' | 'quota' | 'no_trigger' | 'timeout' | 'rate_limit' | 'not_found' | 'server_error' | 'other';

export function categorizeError(error: string): FailureCategory {
  const s = (error || '').toLowerCase();
  if (isQuotaError(s)) return 'quota';
  if (isAuthError(error)) return 'auth';
  if (/no trigger event/.test(s)) return 'no_trigger';
  if (/timed out|timeout|etimedout|deadline exceeded/.test(s)) return 'timeout';
  if (/\b429\b|rate limit|too many requests/.test(s)) return 'rate_limit';
  if (/\b404\b|not found/.test(s)) return 'not_found';
  if (/\b5\d\d\b|internal server error|service unavailable|bad gateway/.test(s)) return 'server_error';
  return 'other';
}
```

- [ ] **Step 3: Run the suite**

Run: `npx vitest run server/src/services/regression-classifier.test.ts`
Expected: PASS.

### Task 6: Client types and the Health board "Credits" column

The Health tab is `Dashboard` → `HealthBoard`, which lanes failing pieces into columns through `client/src/lib/healthBoard.ts`. `client/src/components/NeedsAttention.tsx` is not mounted anywhere; leave it untouched.

**Files:**
- Modify: `client/src/lib/api.ts:310` and `:457`
- Modify: `client/src/lib/healthBoard.ts`
- Modify: `client/src/components/HealthBoard.tsx:9-14`
- Modify: `client/src/components/PieceCard.tsx:30-40`
- Test: `client/src/lib/healthBoard.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `client/src/lib/healthBoard.test.ts`:

```ts
describe('quota (out of credits) lane', () => {
  it('routes a quota-bucket action to the quota column', () => {
    expect(assignColumn(item({ bucket: 'quota', category: 'quota' }), noReports)).toBe('quota');
  });
  it('muted and reported still win over quota', () => {
    expect(assignColumn(item({ bucket: 'quota', category: 'quota', quarantined: true }), noReports)).toBe('muted');
    expect(assignColumn(item({ bucket: 'quota', category: 'quota' }), new Set(['@activepieces/piece-x']))).toBe('reported');
  });
  it('a quota-only piece sits in the quota lane; a live error or connection issue wins', () => {
    const quota = item({ bucket: 'quota', category: 'quota' });
    expect(assignPieceColumn([quota], noReports)).toBe('quota');
    expect(assignPieceColumn([quota, item({ category: 'piece_error' })], noReports)).toBe('errors');
    expect(assignPieceColumn([quota, item({ category: 'auth', bucket: 'reauth' })], noReports)).toBe('connection');
    expect(assignPieceColumn([quota, item({ quarantined: true })], noReports)).toBe('quota');
    expect(assignPieceColumn([quota, item({ category: 'auth', bucket: 'reauth' }), item({ quarantined: true })], noReports)).toBe('connection');
    expect(assignPieceColumn([quota], new Set(['@activepieces/piece-x']))).toBe('reported');
  });
  it('counts quota actions separately', () => {
    expect(pieceKindCounts([item({ bucket: 'quota', category: 'quota' }), item({ category: 'piece_error' })]))
      .toEqual({ error: 1, connection: 0, quota: 1, muted: 0 });
  });
  it('groupPiecesByColumn has a quota lane', () => {
    const g = groupPiecesByColumn([item({ piece_name: '@activepieces/piece-hf', bucket: 'quota', category: 'quota' })], noReports);
    expect(g.quota.map(x => x.piece_name)).toEqual(['@activepieces/piece-hf']);
    expect(g.errors).toEqual([]);
  });
});
```

Also update the existing `pieceKindCounts` expectation from `{ error: 2, connection: 1, muted: 1 }` to `{ error: 2, connection: 1, quota: 0, muted: 1 }`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run client/src/lib/healthBoard.test.ts`
Expected: the new tests FAIL (`errors` instead of `quota`, missing `quota` count); the rest pass.

- [ ] **Step 3: Types**

`client/src/lib/api.ts`:

```ts
export type ErrorCategory = 'auth' | 'rate_limit' | 'transient' | 'bad_request' | 'not_found' | 'piece_error' | 'quota' | 'unknown';
```

```ts
  bucket: 'reauth' | 'likely_broken' | 'watching' | 'quota' | 'noise';
```

- [ ] **Step 4: Laning**

In `client/src/lib/healthBoard.ts`:

```ts
export type ColumnKey = 'errors' | 'connection' | 'quota' | 'reported' | 'muted';

export const COLUMNS: { key: ColumnKey; label: string; hint: string }[] = [
  { key: 'errors', label: 'Errors', hint: 'piece or test failures — report to the piece team' },
  { key: 'connection', label: 'Connection', hint: 'auth / connection — re-auth or re-import' },
  { key: 'quota', label: 'Credits', hint: 'vendor account out of credits or over its plan — top up, not a piece bug' },
  { key: 'reported', label: 'Reported', hint: 'handed off to the piece team' },
  { key: 'muted', label: 'Muted', hint: 'quarantined or transient noise' },
];
```

`itemKind` (update its doc comment to "muted (parked) > connection (your-side auth) > quota (vendor account) > error"):

```ts
function itemKind(item: AttentionItem): 'muted' | 'connection' | 'quota' | 'error' {
  if (item.quarantined || item.bucket === 'noise') return 'muted';
  if (item.bucket === 'reauth' || item.category === 'auth' || item.category === 'connection_broken') return 'connection';
  if (item.bucket === 'quota') return 'quota';
  return 'error';
}
```

`assignColumn` (doc comment precedence becomes "Muted > Reported > Connection > Credits > Errors"): insert `if (item.bucket === 'quota') return 'quota';` directly before the final `return 'errors';`.

`assignPieceColumn` (doc comment: "Among active issues, Errors beats Connection beats Credits"): replace the last line with

```ts
  if (kinds.some(k => k === 'error')) return 'errors';
  return kinds.some(k => k === 'connection') ? 'connection' : 'quota';
```

`pieceKindCounts`:

```ts
export function pieceKindCounts(items: AttentionItem[]): { error: number; connection: number; quota: number; muted: number } {
  const counts = { error: 0, connection: 0, quota: 0, muted: 0 };
  for (const it of items) counts[itemKind(it)]++;
  return counts;
}
```

`groupPiecesByColumn`: `const out: Record<ColumnKey, PieceGroup[]> = { errors: [], connection: [], quota: [], reported: [], muted: [] };` and its doc comment becomes `/** Group failing actions into piece cards, bucketed into the board lanes. */`.

- [ ] **Step 5: Column dot**

`client/src/components/HealthBoard.tsx` `COLUMN_DOT`, after `connection`:

```ts
  quota: 'bg-fuchsia-500',
```

- [ ] **Step 6: Card chips**

`client/src/components/PieceCard.tsx`. A Credits-lane card must not wear the red "failing" chip (the column is never counted as an error). Replace the `{n} failing` chip with:

```tsx
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${group.lane === 'quota'
              ? 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25'
              : 'bg-red-500/15 text-red-300 border-red-500/25'}`}>
              {group.lane === 'quota' ? `${counts.quota} out of credits` : `${n} failing`}
            </span>
```

Then, directly after the `counts.connection` chip block, add the chip for pieces that have quota actions but sit in another lane:

```tsx
            {counts.quota > 0 && group.lane !== 'quota' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25">
                {counts.quota} credits
              </span>
            )}
```

- [ ] **Step 7: Verify**

Run: `npx vitest run client/src/lib/healthBoard.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: all healthBoard tests PASS; no type errors. `PieceDrawer` already derives `reportable` from `group.lane === 'errors'`, so a Credits piece is never offered "Report to Pieces team" without any change there.

### Task 7: Playbook entry, chips and chart label

**Files:**
- Modify: `client/src/components/ErrorPlaybook.tsx:46` (`Blame`), `:60-66` (`BLAME_CHIP`), `:71-157` (`buildPlaybook`)
- Modify: `client/src/components/ActionErrorRow.tsx:7-17`
- Modify: `client/src/components/ScheduledRunsFeed.tsx:41-51`
- Modify: `client/src/pages/Reports.tsx:33-42`

- [ ] **Step 1: Playbook**

```ts
type Blame = 'connection' | 'piece' | 'test' | 'environment' | 'account' | 'unknown';
```

```ts
const BLAME_CHIP: Record<Blame, { label: string; cls: string }> = {
  connection: { label: 'connection', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  piece: { label: 'likely piece bug', cls: 'bg-red-500/15 text-red-300 border-red-500/25' },
  test: { label: 'likely test config', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/25' },
  environment: { label: 'environment', cls: 'bg-gray-500/15 text-gray-300 border-gray-600/40' },
  account: { label: 'vendor account', cls: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25' },
  unknown: { label: 'needs a look', cls: 'bg-gray-500/15 text-gray-400 border-gray-600/40' },
};
```

Insert a case before `case 'transient':` in `buildPlaybook`:

```ts
    case 'quota':
      return {
        blame: 'account',
        diagnosis: 'The vendor account is out of credits or over its plan limit. Nothing to fix in the piece. Top up or upgrade the account, then retest.',
        nav: [
          { label: 'View run details', to: runs, icon: ScrollText, primary: true },
          { label: 'Check connection', to: connections, icon: KeyRound },
        ],
      };
```

Both icons are already imported.

- [ ] **Step 2: Chips**

`ActionErrorRow.tsx` `CHIP`, after `assert_failed`:

```ts
  quota: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25',
```

`ScheduledRunsFeed.tsx` `CATEGORY_STYLE`, after `connection_broken`:

```ts
  quota: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25',
```

- [ ] **Step 3: Chart label**

`Reports.tsx` `CATEGORY_META`, after `auth`:

```ts
  quota: { label: 'Credits / quota', color: '#e879f9' },
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

### Task 7b: Review fixes

From the full review, done as one batch:

- [x] **Classify the vendor reply, not the wrapper.** `ParsedApError` gains
  `responseBody`. `error-category.ts` runs `parseApError`, matches quota words
  on `message` + `responseBody` only, and takes the status from the parsed
  `status` (or `status code NNN` in the message). 402 → `quota`; then a known
  status decides (401/403 auth, 429 rate_limit, 500–504 transient, 400/422
  bad_request, 404 not_found); otherwise the old keyword chain. The
  `status\W{0,6}402` regex is gone. `isQuotaError` takes the raw error too, so
  `categorizeError` in `regression-classifier.ts` gets the same behaviour
  unchanged.
- [x] **More billing walls:** `max(imum)? credits (exceeded|reached)`,
  `exceeds your (\w+ )?quota`, `not available on your (current )?plan`,
  `requires an? (\w+ )?plan`, `(daily|monthly) (\w+ )?quota (reached|exceeded)`.
- [x] **Card hint:** `shortenError` in `queries.ts` uses `parseApError().message`.
- [x] Tests: 6 table rows, 5 AP-wrapped cases in `error-category.test.ts`, and
  a hint test in `queries.attention.test.ts`.
- [x] Second review round: `categorizeError` passed a lowercased string (the
  wrapper never parsed); a wrapper cut at the 8 KB cap is now matched only up
  to its first `requestBody`/`apiMessage`/`raw`/`output` key; non-wrapper JSON
  takes its status from top-level fields only; buy/purchase need plural
  "credits"; `check your plan` dropped; `shortenError` keeps one line and falls
  back to the raw first line when the vendor message is empty.
- [x] Re-ran every stored local failure through the new classifier: only the
  Bland "buy credits" 400 moves (bad_request → quota).

### Task 8: Full verification

- [ ] **Step 1: Whole suite and typecheck**

Run: `npm test && npx tsc --noEmit -p tsconfig.json`
Expected: all vitest files PASS; no type errors.

- [ ] **Step 2: Grep for stragglers**

Run: `grep -rn "'reauth' | 'likely_broken'" server/src client/src` and `grep -rn "errorCategory ||" server/src`
Expected: the first returns only the two unions edited in Tasks 3 and 6 (now containing `'quota'`); the second returns only the fallback line inside `categoryOfStep` (every board/alert read goes through it).

- [ ] **Step 3: Hand over for the user test**

Start the app (`npm run dev`) and tell the user what to check on the Health tab: the new "Credits" column holding the Hugging Face piece, its drawer row showing the fuchsia `quota` chip, the "vendor account" playbook chip and billing diagnosis, no "Run the AI fixer" and no "Report to Pieces team" action, and the Errors column no longer listing it. Scheduled Runs should show a fuchsia `quota` badge on that run; Reports' "why tests fail" chart should show "Credits / quota". If the user wants a self-check first, ask before inserting a seeded failing run into `data/piece-tester.db`, then drive the page per the headless-Chrome notes.

### Task 9: Commit after the user has tested

- [ ] **Step 1: One code commit, one docs commit, no trailer**

```bash
git add server/src/services/error-category.ts server/src/services/error-category.test.ts \
  server/src/services/plan-executor.ts server/src/db/queries.ts server/src/db/queries.attention.test.ts \
  server/src/services/alert-engine.ts server/src/services/alert-engine.test.ts \
  server/src/services/regression-classifier.ts server/src/services/regression-classifier.test.ts \
  client/src/lib/api.ts client/src/lib/healthBoard.ts client/src/lib/healthBoard.test.ts \
  client/src/components/HealthBoard.tsx client/src/components/PieceCard.tsx client/src/components/ErrorPlaybook.tsx \
  client/src/components/ActionErrorRow.tsx client/src/components/ScheduledRunsFeed.tsx client/src/pages/Reports.tsx
git commit -m "feat(health): separate out-of-credits failures from piece bugs

Add a quota error category with its own Credits column on the Health board,
re-derive categories from stored error text so existing items move lanes
without a migration, and keep quota out of Discord alerts and the Errors lane."

git add docs/superpowers/specs/2026-10-14-quota-error-category-design.md docs/superpowers/plans/2026-10-14-quota-error-category.md
git commit -m "docs: quota error category design spec and plan"
```

Then open a PR from `feat/quota-error-category` against `main` only when the user asks.

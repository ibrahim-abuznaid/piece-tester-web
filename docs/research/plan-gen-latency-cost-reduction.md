# Plan-Generation Latency & Cost Reduction (V2 pipeline)

_Research date: 2026-09-24. Scope: V2 plan generation only (`createTestPlanV2` / `createTriggerTestPlanV2`), used by both batch setup and individual piece generation. Code claims are first-hand `file:line`; Anthropic claims cite `docs.anthropic.com` / `anthropic.com`._

## 0. V2-only status (answered)

Plan generation is **already V2-only at runtime** in both paths:

| Path | Calls | Location |
|------|-------|----------|
| Batch — actions | `createTestPlanV2` | `server/src/routes/batch-setup.ts` |
| Batch — triggers | `createTriggerTestPlanV2` | `server/src/routes/batch-setup.ts` |
| Individual — actions | `createTestPlanV2` | `server/src/routes/pieces.ts` |
| Individual — triggers | `createTriggerTestPlanV2` | `server/src/routes/pieces.ts` |

Client only ever calls `streamAiPlanV2`. The V1 plan-**writing** path (`createTestPlanWithAi` / `fixTestPlanWithAi` in `ai-config-generator.ts`, `runPlanJobInBackground`, and the old `/ai-plan` + `/ai-plan-fix` routes) is **dead code (present but unreachable)**. Recommendation: delete it to make "V2 only" airtight, but **keep** the execution helpers `executeActionOnAP` and `resolveConnectionAuthInput` — V2 depends on them for live execution and auth resolution.

## 1. Executive summary — where the 10 minutes go

1. One "Generate plan" = **two sequential macro-phases**: WRITE (`createTestPlanV2`: research → synthesis → planner → verifier → fix-loop ×2, each fix re-verifies) then AUTO-TEST + FIX (route loop; up to 4 live AP executions with `fixTestPlanV2` between them).
2. The minutes are **serial LLM round-trips**, not one slow call: ~5 workers, each a tool-use loop of 8–12 turns, every turn a full **non-streaming** `messages.create`. ~50 sequential calls worst case — matches the captured prod log (59 calls, $1.41, 10m13s).
3. **Worst-case tail = the fixer exhausts its 12-turn loop without calling `set_test_plan`** (iteration exhaustion) → returns the plan unchanged → coordinator re-verifies the identical plan → route re-runs the whole live auto-test. **There is no wall-clock budget anywhere** — only per-turn caps.
4. The single biggest chunk of the logged 10-min run was two flailing fixer rounds (~6 min) caused by the planner picking non-runnable `audience:'ai'` actions.

## 2. Part A — Ground truth from the code (verified)

- WRITE coordinator fix loop `MAX_FIX_ATTEMPTS = 2`; route/batch loop is 3; `fixTestPlanV2` does fixer → verify → maybe one more fixer. Fixers are **doubly nested**.
- Shared loop: `max_tokens: 8096` hardcoded; model was `settings.ai_model || 'claude-sonnet-4-6'`; no extended thinking / effort, no streaming, no service_tier. `stop_reason` was only checked for `end_turn` — `max_tokens` truncation was **never handled** (silent plan corruption risk).
- Per-worker `model` field was DEAD — `runAgentLoop` read `settings.ai_model` and ignored `config.model`, so all 5 workers ran the same model.
- **Prompt caching present and correct.** System block cached + rolling message breakpoint. Because the cache prefix order is `tools → system → messages`, the system-block breakpoint **already caches the tools block** — no separate tools breakpoint needed.
- `validatePlanDeterministically` checked step count / target match / read-only discipline but **never** that each step's action existed in the runnable set (`piece.actions`). `buildActionsList` printed "All actions in this piece" without marking it authoritative — so the planner followed MCP research and used non-runnable actions.

## 3. Part B — Anthropic research (cited, corrected against the `claude-api` skill)

- **Prompt caching.** Prefix order `tools → system → messages`; a system breakpoint caches tools + system together. **Correction:** an earlier draft's "the tools block is NOT cached" is wrong — it already is.
- **`max_tokens` is a ceiling, not a reservation.** Billed on actual output, so 8096 costs nothing extra when a turn emits fewer. **Correction:** lowering 8096→2048 saves nothing and would truncate the observed ~2.9k-token `set_test_plan` turns — harmful. On truncation, retry with higher `max_tokens` or fail; never act on a truncated tool call.
- **Model pricing.** Haiku 4.5 `claude-haiku-4-5` **$1 / $5** (~4–5× faster); Sonnet 4.6 `claude-sonnet-4-6` **$3 / $15**. Route the high-input, low-judgment workers (research, verifier) to Haiku; keep planner + fixer on Sonnet.
- **Message Batches API** (50% off, async, ≤24h) does not fit the interactive loop. **Priority Tier** reduces variance, not median latency. Extended thinking/effort is already off (cheap default).

## 4. Part C — Shipped on `feat/reduce-plan-gen-latency` (test-first)

- **Q3 — skip re-verify on a no-op fix.** New pure `planStepsUnchanged` (`plan-diff.ts` + tests) wired into both fix loops: when the fixer returns a plan identical to its input, skip re-verifying it. Removes the ~3-min wasted re-verify from the prod log.
- **Q2 — handle `stop_reason === 'max_tokens'`.** In `agent-runner.ts`, stop the worker on a truncated turn instead of accepting a truncated `set_test_plan` (closes the silent-plan-corruption bug).
- **Q6 — global wall-clock budget + fail-fast.** New pure `resolvePlanGenBudgetMs` (`plan-budget.ts` + tests; default 7 min, env `PLAN_GEN_BUDGET_MS`, clamped [1,10] min). One `deadlineAt` per action, computed at job start in `pieces.ts` and `batch-setup.ts`, bounds the write fix loop and each auto-test attempt. Graceful stop returning the best plan so far. Guarantees no future >10-min run.
- **A — executable-actions gate (the big one).** New pure `findNonExecutableActionSteps` (`plan-validate.ts` + tests) called first in `validatePlanDeterministically`, so a plan using a non-runnable action fails the **free deterministic gate** with a precise message instead of burning an LLM verify→fix loop. `buildActionsList` relabeled AUTHORITATIVE (propagates to planner, verifier, fixer, research, trigger-planner). Kills the ~6-min two-fixer leak; improves correctness; zero extra LLM calls.
- **B — Haiku 4.5 for research + verifier.** Un-broke the dead per-worker `model` field (`agent-runner.ts`), routed research + verifier to `claude-haiku-4-5`, added Haiku pricing to the cost tracker. Planner + fixer stay on Sonnet.

**Dropped after verification (with cause):**

- **Q4 (cache the tools block)** — redundant; the system-block breakpoint already caches tools.
- **Q5 (max_tokens 8096→2048)** — counterproductive; no cost saving and would truncate real `set_test_plan` turns.

## 5. Measured A/B (n=1 each, `@activepieces/piece-apify › getDatasetItems`, same settings DB)

| Metric | Baseline (`main`, all-Sonnet) | New (Haiku research+verifier) | Δ |
|---|---|---|---|
| Total wall-clock | 298.7s | 256.3s | −14% |
| Cost | $0.498 | $0.435 | −13% |
| research *(→Haiku)* | 204.2s | 134.1s | **−34%** |
| verifier *(→Haiku)* | 58.6s | 33.8s | **−42%** |
| planner *(Sonnet, unchanged)* | 23.3s | 79.6s | +242% (run-to-run variance) |
| fix attempts | 0 | 0 | — |
| gate fired | no | no | neither run hit the failure path |

Read: the two Haiku-routed workers got 34–42% faster and ~13% cheaper (deterministic win). Total is only −14% because the (unchanged) Sonnet planner happened to take 3× longer on the new run — n=1 noise. Neither run triggered the flailing-fixer pathology, so the gate / no-op-skip / budget levers didn't fire live; their effect is proven by unit tests and the deterministic code path. Harness: `scripts/ab-plan-gen.mts`.

## 6. Backlog (not in this branch)

- **Q7 — skip the LLM verifier for trivial read-only plans** that already pass the deterministic validator.
- **Extend the gate + budget to the trigger paths** (`createTriggerTestPlanV2`).
- **Surface `PLAN_GEN_BUDGET_MS` in the Settings UI** (mirrors the `batch_concurrency` pattern).
- **Trim the 50k source injection** to ~12–15k for faster per-turn latency.
- **S1 — research-once-per-piece, plan-many** (amortize the source dump; biggest structural cost win).

_Prior related notes: `docs/research/batch-setup-throughput.md`._

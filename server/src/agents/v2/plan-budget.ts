/**
 * Wall-clock budget for a single action's plan generation (write phase +
 * auto-test loop combined). Bounds the runaway tail — nested fixers, re-verify
 * loops, live-AP retries — so one action can't crawl toward the 600s request
 * hard cap. Checked at loop boundaries for a graceful fail-fast (return the
 * best plan so far), not as a hard mid-worker abort.
 */
export const DEFAULT_PLAN_GEN_BUDGET_MS = 7 * 60_000; // 420_000
const MIN_PLAN_GEN_BUDGET_MS = 60_000; // 1 min floor
const MAX_PLAN_GEN_BUDGET_MS = 600_000; // 10 min ceiling — matches req.setTimeout in pieces.ts

/** Resolve the per-action budget from an env override, clamped to a sane range. */
export function resolvePlanGenBudgetMs(raw?: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PLAN_GEN_BUDGET_MS;
  return Math.min(MAX_PLAN_GEN_BUDGET_MS, Math.max(MIN_PLAN_GEN_BUDGET_MS, Math.floor(n)));
}

export type Lane =
  | 'newly_broken'
  | 'degrading'
  | 'flaky'
  | 'recovered'
  | 'still_broken'
  | 'stable'
  | 'stale';

export interface RunLite {
  status: string; // completed | failed | blocked | running | ...
  started_at: string;
}

export interface Classification {
  lane: Lane;
  recentRate: number; // 0-100 over the recent decided window
  priorRate: number | null; // null when there is no prior window
}

export interface ClassifierConfig {
  window: number; // runs per window
  minRuns: number; // below this = not enough data
  staleDays: number; // last run older than this = stale
  breakMax: number; // recent <= this = broken
  healthyMin: number; // prior >= this = was healthy
  recoverMin: number; // recent >= this = recovered/healthy now
  brokenMax: number; // <= this = broken-ish
  dropPts: number; // prior - recent >= this = degrading
  minFlips: number; // status changes in recent to call it flaky
}

export const DEFAULT_CONFIG: ClassifierConfig = {
  window: 5,
  minRuns: 3,
  staleDays: 14,
  breakMax: 40,
  healthyMin: 70,
  recoverMin: 80,
  brokenMax: 50,
  dropPts: 25,
  minFlips: 2,
};

function rate(window: RunLite[]): number {
  if (window.length === 0) return 0;
  const passed = window.filter(r => r.status === 'completed').length;
  return Math.round((passed / window.length) * 100);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

export function classifyPiece(
  runs: RunLite[],
  opts: { now: string; planUpdatedAt?: string | null; config?: Partial<ClassifierConfig> },
): Classification {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };

  const allAsc = [...runs].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const lastRunAt = allAsc.length ? allAsc[allAsc.length - 1].started_at : null;

  // Only decided (pass/fail) runs drive the rate; blocked/running are skipped.
  const decidedAsc = allAsc.filter(r => r.status === 'completed' || r.status === 'failed');
  const decidedDesc = [...decidedAsc].reverse(); // newest first

  const recent = decidedDesc.slice(0, cfg.window);
  const prior = decidedDesc.slice(cfg.window, cfg.window * 2);
  const recentRate = rate(recent);
  const priorRate = prior.length ? rate(prior) : null;

  const base: Omit<Classification, 'lane'> = { recentRate, priorRate };

  // Stale / not enough data — never fake-classify.
  const tooFew = decidedAsc.length < cfg.minRuns;
  const tooOld = lastRunAt !== null && daysBetween(lastRunAt, opts.now) > cfg.staleDays;
  if (tooFew || tooOld) return { ...base, lane: 'stale' };

  const lastDecided = decidedDesc[0];
  const lastFailed = lastDecided?.status === 'failed';
  const lastPassed = lastDecided?.status === 'completed';

  // Flaky signals
  const recentChron = [...recent].reverse(); // oldest -> newest
  let flips = 0;
  for (let i = 1; i < recentChron.length; i++) {
    if (recentChron[i].status !== recentChron[i - 1].status) flips++;
  }
  const hasMixed =
    recent.some(r => r.status === 'completed') && recent.some(r => r.status === 'failed');
  const windowStart = recentChron[0]?.started_at;
  const planChangedInWindow =
    !!opts.planUpdatedAt && !!windowStart && new Date(opts.planUpdatedAt) >= new Date(windowStart);

  let lane: Lane;
  if (priorRate !== null && lastFailed && recentRate <= cfg.breakMax && priorRate >= cfg.healthyMin) {
    lane = 'newly_broken';
  } else if (
    priorRate !== null && lastPassed && recentRate >= cfg.recoverMin && priorRate <= cfg.brokenMax
  ) {
    lane = 'recovered';
  } else if (priorRate !== null && priorRate - recentRate >= cfg.dropPts) {
    lane = 'degrading';
  } else if (hasMixed && flips >= cfg.minFlips && !planChangedInWindow) {
    lane = 'flaky';
  } else if (recentRate <= cfg.breakMax && (priorRate === null || priorRate <= cfg.brokenMax)) {
    lane = 'still_broken';
  } else {
    lane = 'stable';
  }

  return { ...base, lane };
}

// ── Error categorization ──

export function isAuthError(error: string): boolean {
  const s = (error || '').toLowerCase();
  if (/\b40[13]\b/.test(s)) return true;
  return /(authentication required|unauthorized|invalid (api )?(key|token|credential)|expired (token|credential|api key)|not authenticated|auth(entication)? (required|failed)|connection (was )?(deleted|broken)|reauthor)/.test(
    s,
  );
}

export type FailureCategory =
  | 'auth' | 'no_trigger' | 'timeout' | 'rate_limit' | 'not_found' | 'server_error' | 'other';

export function categorizeError(error: string): FailureCategory {
  const s = (error || '').toLowerCase();
  if (isAuthError(error)) return 'auth';
  if (/no trigger event/.test(s)) return 'no_trigger';
  if (/timed out|timeout|etimedout|deadline exceeded/.test(s)) return 'timeout';
  if (/\b429\b|rate limit|too many requests/.test(s)) return 'rate_limit';
  if (/\b404\b|not found/.test(s)) return 'not_found';
  if (/\b5\d\d\b|internal server error|service unavailable|bad gateway/.test(s)) return 'server_error';
  return 'other';
}

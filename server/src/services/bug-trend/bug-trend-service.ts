import { buildBugTrend, DEFAULT_FROM, EARLIEST_FROM, LINEAR_LABELS, TESTER_AT_SCALE_DATE, type BugTrend } from './bug-trend.js';
import { createBugCache, type BugCache } from './bug-trend-cache.js';
import { fetchTrackedBugs } from './linear-client.js';
import { parseRoster } from './roster.js';

export type BugTrendResponse =
  | { state: 'needs-setup'; missing: 'key' | 'roster' }
  | { state: 'ok'; fetchedAt: string; warnings: string[]; trend: BugTrend };

export interface BugTrendRequest {
  apiKey: string;
  rosterJson: string;
  from?: string;
  refresh: boolean;
  now: Date;
}

export const bugTrendCache: BugCache = createBugCache({
  fetch: ({ apiKey, rosterIds }) => fetchTrackedBugs(apiKey, rosterIds),
  now: () => Date.now(),
});

/** Call whenever the Linear key or the roster changes, so the page never shows data for the old ones. */
export function invalidateBugTrendCache(): void {
  bugTrendCache.invalidate();
}

function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

/** The only guard against a label being renamed in Linear: a whole query coming back empty. */
export function emptyQueryWarnings(matched: { GIT: number; PIE: number }): string[] {
  const warnings: string[] = [];
  if (matched.GIT === 0) warnings.push(`No GIT issues matched label "${LINEAR_LABELS.gitBug}" for the roster. Check the label name and the roster.`);
  if (matched.PIE === 0) warnings.push(`No PIE issues matched label "${LINEAR_LABELS.pieTester}". Check the label name.`);
  return warnings;
}

export async function resolveBugTrendRequest(
  cache: BugCache,
  req: BugTrendRequest,
): Promise<{ status: number; body: BugTrendResponse | { error: string } }> {
  const from = req.from ?? DEFAULT_FROM;
  if (!isValidYmd(from)) return { status: 400, body: { error: 'from must be a date like 2026-06-01' } };
  if (from < EARLIEST_FROM) return { status: 400, body: { error: `from cannot be before ${EARLIEST_FROM}` } };
  if (Date.parse(`${from}T00:00:00Z`) > req.now.getTime()) return { status: 400, body: { error: 'from cannot be in the future' } };
  if (!req.apiKey) return { status: 200, body: { state: 'needs-setup', missing: 'key' } };
  const roster = parseRoster(req.rosterJson);
  if (roster.length === 0) return { status: 200, body: { state: 'needs-setup', missing: 'roster' } };

  try {
    const cached = await cache.get({ apiKey: req.apiKey, rosterIds: roster.map(m => m.id), refresh: req.refresh });
    const asOfDay = cached.fetchedAt.slice(0, 10);
    const trendFrom = from > asOfDay ? asOfDay : from;
    const trend = buildBugTrend(cached.bugs, { from: trendFrom, now: new Date(cached.fetchedAt), markerDate: TESTER_AT_SCALE_DATE });
    return {
      status: 200,
      body: { state: 'ok', fetchedAt: cached.fetchedAt, warnings: [...cached.warnings, ...emptyQueryWarnings(cached.matched)], trend },
    };
  } catch (err) {
    return { status: 502, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

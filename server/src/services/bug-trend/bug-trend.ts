/** Linear label names and team keys the Bug Trend page depends on. Renaming one in Linear breaks the count. */
export const LINEAR_LABELS = { gitBug: '🐛 bug', pieTester: 'piece-tester', support: '🛟 support' } as const;
export const LINEAR_TEAMS = { git: 'GIT', pie: 'PIE' } as const;

/** The month Piece Tester plan runs jumped from hundreds to thousands. Drawn as a marker, not a setting. */
export const TESTER_AT_SCALE_DATE = '2026-08-01';
export const DEFAULT_FROM = '2026-06-01';
/** Earliest allowed `from`: bounds the per-day loop so one request can't stall the server. */
export const EARLIEST_FROM = '2024-01-01';

export type BugSource = 'support' | 'internal' | 'tester';

/** A Linear issue normalized for the trend. Canceled and trashed issues never become a TrackedBug. */
export interface TrackedBug {
  identifier: string;
  title: string;
  url: string;
  team: 'GIT' | 'PIE';
  source: BugSource;
  assigneeName: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface BugTrendWeek {
  weekStart: string;          // YYYY-MM-DD, a Monday, UTC
  support: number;
  internal: number;
  tester: number;
  total: number;
  rolling4: number | null;    // mean of `total` over this week + the 3 before; null for the in-progress week
  inProgress: boolean;
}

export interface BugTrendDay { date: string; open: number; openIds: string[] }

export interface BugTrendKpis {
  openNow: number;
  openedLast28: number;
  openedPrev28: number;
  medianDaysToFix: number | null;
  fixedCount: number;
}

export interface BugTrend {
  from: string;
  asOf: string;
  markerDate: string;
  weeks: BugTrendWeek[];
  days: BugTrendDay[];
  kpis: BugTrendKpis;
  issues: TrackedBug[];
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export function classifySource(labelNames: string[]): BugSource {
  if (labelNames.includes(LINEAR_LABELS.pieTester)) return 'tester';
  if (labelNames.includes(LINEAR_LABELS.support)) return 'support';
  return 'internal';
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function mondayOf(ms: number): number {
  const day = startOfUtcDay(ms);
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return day - sinceMonday * DAY_MS;
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function buildBugTrend(bugs: TrackedBug[], opts: { from: string; now: Date; markerDate: string }): BugTrend {
  const nowMs = opts.now.getTime();
  const fromMs = Date.parse(`${opts.from}T00:00:00Z`);
  const created = (b: TrackedBug) => Date.parse(b.createdAt);
  const completed = (b: TrackedBug) => (b.completedAt ? Date.parse(b.completedAt) : null);
  const openAt = (t: number) => bugs.filter(b => {
    const c = completed(b);
    return created(b) <= t && (c === null || c > t);
  });

  const perWeek = new Map<number, { support: number; internal: number; tester: number }>();
  for (const b of bugs) {
    const wk = mondayOf(created(b));
    const row = perWeek.get(wk) ?? { support: 0, internal: 0, tester: 0 };
    row[b.source]++;
    perWeek.set(wk, row);
  }
  const totalOf = (wk: number) => {
    const r = perWeek.get(wk);
    return r ? r.support + r.internal + r.tester : 0;
  };

  const weeks: BugTrendWeek[] = [];
  const currentWeek = mondayOf(nowMs);
  for (let wk = mondayOf(fromMs); wk <= currentWeek; wk += WEEK_MS) {
    const r = perWeek.get(wk) ?? { support: 0, internal: 0, tester: 0 };
    const inProgress = wk === currentWeek;
    weeks.push({
      weekStart: ymd(wk),
      ...r,
      total: r.support + r.internal + r.tester,
      rolling4: inProgress ? null : (totalOf(wk) + totalOf(wk - WEEK_MS) + totalOf(wk - 2 * WEEK_MS) + totalOf(wk - 3 * WEEK_MS)) / 4,
      inProgress,
    });
  }

  const days: BugTrendDay[] = [];
  const today = startOfUtcDay(nowMs);
  for (let d = startOfUtcDay(fromMs); d <= today; d += DAY_MS) {
    const open = openAt(d === today ? nowMs : d + DAY_MS - 1);
    days.push({ date: ymd(d), open: open.length, openIds: open.map(b => b.identifier) });
  }

  const createdIn = (lo: number, hi: number) => bugs.filter(b => created(b) > lo && created(b) <= hi).length;
  const fixDays = bugs
    .filter(b => { const c = completed(b); return c !== null && c >= fromMs && c <= nowMs; })
    .map(b => (completed(b)! - created(b)) / DAY_MS);

  const kpis: BugTrendKpis = {
    openNow: openAt(nowMs).length,
    openedLast28: createdIn(nowMs - 28 * DAY_MS, nowMs),
    openedPrev28: createdIn(nowMs - 56 * DAY_MS, nowMs - 28 * DAY_MS),
    medianDaysToFix: fixDays.length ? Math.round(median(fixDays) * 10) / 10 : null,
    fixedCount: fixDays.length,
  };

  const issues = bugs
    .filter(b => { const c = completed(b); return created(b) >= mondayOf(fromMs) || c === null || (c >= fromMs && c <= nowMs); })
    .sort((a, b) => created(b) - created(a));

  return { from: opts.from, asOf: opts.now.toISOString(), markerDate: opts.markerDate, weeks, days, kpis, issues };
}

import type { BugSource, BugTrendWeek } from './api';

/** Stack order, bottom to top. Color follows the source, never its position. */
export const SOURCE_ORDER: BugSource[] = ['support', 'internal', 'tester'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

function utcMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`);
}

function dayParts(ms: number) {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` };
}

export function formatDay(ymd: string): string {
  return dayParts(utcMs(ymd)).label;
}

export function weekStartOf(ymd: string): string {
  const ms = utcMs(ymd);
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return new Date(ms - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

export function formatWeekRange(weekStart: string): string {
  const start = utcMs(weekStart);
  return `${dayParts(start).label} – ${dayParts(start + 6 * DAY_MS).label}`;
}

export function formatDateRange(fromYmd: string, asOfIso: string): string {
  const a = dayParts(utcMs(fromYmd));
  const b = dayParts(Date.parse(asOfIso));
  return a.y === b.y ? `${a.label} – ${b.label}, ${b.y}` : `${a.label}, ${a.y} – ${b.label}, ${b.y}`;
}

export function formatDelta(last: number, prev: number): { text: string; direction: 'down' | 'up' | 'flat' | 'none' } {
  if (prev === 0) return { text: '— vs 0', direction: 'none' };
  const pct = Math.round((Math.abs(last - prev) / prev) * 100);
  if (last < prev) return { text: `↓ ${pct}% vs ${prev}`, direction: 'down' };
  if (last > prev) return { text: `↑ ${pct}% vs ${prev}`, direction: 'up' };
  return { text: `→ 0% vs ${prev}`, direction: 'flat' };
}

export function activeSources(weeks: BugTrendWeek[]): BugSource[] {
  return SOURCE_ORDER.filter(s => weeks.some(w => w[s] > 0));
}

/** The visible top segment of a week's stack: its highest non-zero source among `sources`, or null. */
export function topSourceOf(week: BugTrendWeek, sources: BugSource[]): BugSource | null {
  const stacked = SOURCE_ORDER.filter(s => sources.includes(s) && week[s] > 0);
  return stacked.length ? stacked[stacked.length - 1] : null;
}

/** The week in progress is drawn lighter, so a partial week never reads as a drop. */
export function weekBarOpacity(week: BugTrendWeek): number {
  return week.inProgress ? 0.4 : 1;
}

export function formatDaysToFix(createdAt: string, completedAt: string | null): string {
  if (!completedAt) return '—';
  return (Math.round(((Date.parse(completedAt) - Date.parse(createdAt)) / DAY_MS) * 10) / 10).toString();
}

export function pngFileName(asOfIso: string): string {
  return `pieces-team-bugs-${asOfIso.slice(0, 10)}.png`;
}

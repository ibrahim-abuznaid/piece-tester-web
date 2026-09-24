/** UTC+3, no DST: a local-time date bug fails here even when CI runs in UTC. */
process.env.TZ = 'Asia/Riyadh';

import { describe, it, expect } from 'vitest';
import {
  formatDay, weekStartOf, formatWeekRange, formatDateRange, formatDelta,
  activeSources, topSourceOf, formatDaysToFix, pngFileName,
} from './bugTrendFormat';
import type { BugTrendWeek } from './api';

const week = (p: Partial<BugTrendWeek>): BugTrendWeek => ({
  weekStart: '2026-09-07', support: 0, internal: 0, tester: 0, total: 0, rolling4: null, inProgress: false, ...p,
});

describe('dates', () => {
  it('formats a day as "Mon D"', () => {
    expect(formatDay('2026-08-04')).toBe('Aug 4');
  });
  it('finds the Monday of a date', () => {
    expect(weekStartOf('2026-08-01')).toBe('2026-07-27');
    expect(weekStartOf('2026-07-27')).toBe('2026-07-27');
  });
  it('formats a week range, crossing months', () => {
    expect(formatWeekRange('2026-08-31')).toBe('Aug 31 – Sep 6');
  });
  it('formats the window on the UTC day, even late in the UTC day', () => {
    expect(new Date('2026-09-24T23:30:00Z').getDate()).toBe(25);
    expect(formatDateRange('2026-06-01', '2026-09-24T23:30:00.000Z')).toBe('Jun 1 – Sep 24, 2026');
  });
  it('shows both years when the window crosses a year', () => {
    expect(formatDateRange('2025-12-01', '2026-01-05T10:00:00.000Z')).toBe('Dec 1, 2025 – Jan 5, 2026');
  });
});

describe('formatDelta', () => {
  it('shows a drop', () => {
    expect(formatDelta(6, 11)).toEqual({ text: '↓ 45% vs 11', direction: 'down' });
  });
  it('shows a rise', () => {
    expect(formatDelta(6, 4)).toEqual({ text: '↑ 50% vs 4', direction: 'up' });
  });
  it('shows no change', () => {
    expect(formatDelta(5, 5)).toEqual({ text: '→ 0% vs 5', direction: 'flat' });
  });
  it('has no percentage when the previous window is zero', () => {
    expect(formatDelta(3, 0)).toEqual({ text: '— vs 0', direction: 'none' });
  });
});

describe('activeSources', () => {
  it('keeps the fixed order and drops sources that are zero in every week', () => {
    expect(activeSources([week({ tester: 1 }), week({ support: 2 })])).toEqual(['support', 'tester']);
    expect(activeSources([week({})])).toEqual([]);
  });
});

describe('topSourceOf', () => {
  const all = ['support', 'internal', 'tester'] as const;
  it('picks the highest non-zero source in stack order', () => {
    expect(topSourceOf(week({ support: 2, internal: 1, tester: 3 }), [...all])).toBe('tester');
    expect(topSourceOf(week({ support: 2, internal: 1 }), [...all])).toBe('internal');
    expect(topSourceOf(week({ support: 4 }), [...all])).toBe('support');
  });
  it('skips a zero source in the middle of the stack', () => {
    expect(topSourceOf(week({ support: 1, tester: 1 }), [...all])).toBe('tester');
  });
  it('ignores sources that are not active', () => {
    expect(topSourceOf(week({ support: 1, tester: 2 }), ['support', 'internal'])).toBe('support');
  });
  it('is null for an empty week', () => {
    expect(topSourceOf(week({}), [...all])).toBeNull();
  });
});

describe('misc', () => {
  it('formats days to fix to one decimal, or a dash when open', () => {
    expect(formatDaysToFix('2026-09-01T00:00:00Z', '2026-09-03T12:00:00Z')).toBe('2.5');
    expect(formatDaysToFix('2026-09-01T00:00:00Z', null)).toBe('—');
  });
  it('names the PNG after the as-of UTC date', () => {
    expect(pngFileName('2026-09-24T23:30:00.000Z')).toBe('pieces-team-bugs-2026-09-24.png');
  });
});

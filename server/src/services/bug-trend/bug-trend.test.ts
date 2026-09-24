import { describe, it, expect } from 'vitest';
import { buildBugTrend, classifySource, type TrackedBug } from './bug-trend.js';

const NOW = new Date('2026-09-24T12:00:00Z');
const OPTS = { from: '2026-09-01', now: NOW, markerDate: '2026-08-01' };

let seq = 0;
function bug(p: Partial<TrackedBug> & { createdAt: string }): TrackedBug {
  seq++;
  return {
    identifier: `GIT-${seq}`, title: `Bug ${seq}`, url: `https://linear.app/x/issue/GIT-${seq}`,
    team: 'GIT', source: 'support', assigneeName: 'Kishan Parmar', completedAt: null,
    ...p,
  };
}

describe('classifySource', () => {
  it('puts piece-tester first, even when support is also present', () => {
    expect(classifySource(['🛟 support', 'piece-tester'])).toBe('tester');
  });
  it('uses support when there is no piece-tester label', () => {
    expect(classifySource(['🐛 bug', '🛟 support'])).toBe('support');
  });
  it('falls back to internal', () => {
    expect(classifySource(['🐛 bug'])).toBe('internal');
    expect(classifySource([])).toBe('internal');
  });
});

describe('buildBugTrend: weeks', () => {
  it('zero-fills Monday weeks from the Monday on or before `from` through the current week', () => {
    const t = buildBugTrend([], OPTS);
    expect(t.weeks.map(w => w.weekStart)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']);
    expect(t.weeks.every(w => w.total === 0)).toBe(true);
    expect(t.weeks.map(w => w.inProgress)).toEqual([false, false, false, true]);
  });

  it('splits Sunday 23:59:59 UTC and Monday 00:00 UTC into different weeks', () => {
    const t = buildBugTrend([
      bug({ createdAt: '2026-09-13T23:59:59Z' }),
      bug({ createdAt: '2026-09-14T00:00:00Z' }),
    ], OPTS);
    expect(t.weeks.find(w => w.weekStart === '2026-09-07')!.total).toBe(1);
    expect(t.weeks.find(w => w.weekStart === '2026-09-14')!.total).toBe(1);
  });

  it('counts each source separately', () => {
    const t = buildBugTrend([
      bug({ createdAt: '2026-09-08T10:00:00Z', source: 'support' }),
      bug({ createdAt: '2026-09-09T10:00:00Z', source: 'support' }),
      bug({ createdAt: '2026-09-10T10:00:00Z', source: 'tester', team: 'PIE' }),
      bug({ createdAt: '2026-09-11T10:00:00Z', source: 'internal' }),
    ], OPTS);
    expect(t.weeks.find(w => w.weekStart === '2026-09-07')).toMatchObject({ support: 2, tester: 1, internal: 1, total: 4 });
  });

  it('leaves bugs created before the first Monday out of every bar', () => {
    const t = buildBugTrend([bug({ createdAt: '2026-08-30T10:00:00Z' })], OPTS);
    expect(t.weeks.reduce((n, w) => n + w.total, 0)).toBe(0);
  });

  it('computes the 4-week average from weeks before `from` and skips the in-progress week', () => {
    const t = buildBugTrend([
      bug({ createdAt: '2026-08-12T10:00:00Z' }),
      bug({ createdAt: '2026-08-18T10:00:00Z' }), bug({ createdAt: '2026-08-19T10:00:00Z' }),
      bug({ createdAt: '2026-08-25T10:00:00Z' }), bug({ createdAt: '2026-08-26T10:00:00Z' }), bug({ createdAt: '2026-08-27T10:00:00Z' }),
      bug({ createdAt: '2026-09-01T10:00:00Z' }), bug({ createdAt: '2026-09-02T10:00:00Z' }),
      bug({ createdAt: '2026-09-22T10:00:00Z' }),
    ], OPTS);
    const byWeek = Object.fromEntries(t.weeks.map(w => [w.weekStart, w.rolling4]));
    expect(byWeek['2026-08-31']).toBe(2);      // (1 + 2 + 3 + 2) / 4
    expect(byWeek['2026-09-07']).toBe(1.75);   // (2 + 3 + 2 + 0) / 4
    expect(byWeek['2026-09-21']).toBeNull();
  });
});

describe('buildBugTrend: open bugs per day', () => {
  it('counts bugs open at the end of each UTC day, and today equals openNow', () => {
    const a = bug({ createdAt: '2026-09-18T10:00:00Z' });
    const sameDay = bug({ createdAt: '2026-09-22T09:00:00Z', completedAt: '2026-09-22T15:00:00Z' });
    const c = bug({ createdAt: '2026-09-21T10:00:00Z', completedAt: '2026-09-23T10:00:00Z' });
    const t = buildBugTrend([a, sameDay, c], { ...OPTS, from: '2026-09-20' });
    expect(t.days.map(d => [d.date, d.open])).toEqual([
      ['2026-09-20', 1], ['2026-09-21', 2], ['2026-09-22', 2], ['2026-09-23', 1], ['2026-09-24', 1],
    ]);
    expect(t.days[1].openIds).toEqual([a.identifier, c.identifier]);
    expect(t.days.some(d => d.openIds.includes(sameDay.identifier))).toBe(false);
    expect(t.days[t.days.length - 1].open).toBe(t.kpis.openNow);
  });

  it('counts a bug opened before `from` and fixed inside the window in the line and the median, not in the bars', () => {
    const early = bug({ createdAt: '2026-08-28T12:00:00Z', completedAt: '2026-09-03T12:00:00Z' });
    const t = buildBugTrend([early], OPTS);
    expect(t.days.find(d => d.date === '2026-09-01')!.open).toBe(1);
    expect(t.days.find(d => d.date === '2026-09-03')!.open).toBe(0);
    expect(t.weeks.reduce((n, w) => n + w.total, 0)).toBe(0);
    expect(t.kpis.medianDaysToFix).toBe(6);
    expect(t.kpis.fixedCount).toBe(1);
    expect(t.issues.map(b => b.identifier)).toEqual([early.identifier]);
  });
});

describe('buildBugTrend: KPIs', () => {
  it('uses 28-day windows relative to now, independent of `from`', () => {
    const t = buildBugTrend([
      bug({ createdAt: '2026-08-27T12:00:01Z' }),   // last 28
      bug({ createdAt: '2026-08-27T12:00:00Z' }),   // prev 28 (upper edge is inclusive)
      bug({ createdAt: '2026-07-30T12:00:01Z' }),   // prev 28
      bug({ createdAt: '2026-07-30T12:00:00Z' }),   // neither
    ], OPTS);
    expect(t.kpis.openedLast28).toBe(1);
    expect(t.kpis.openedPrev28).toBe(2);
    expect(t.kpis.openNow).toBe(4);
  });

  it('takes the median days to fix over fixes inside [from, now]', () => {
    const fixed = (days: number) => bug({
      createdAt: '2026-09-02T00:00:00Z',
      completedAt: new Date(Date.parse('2026-09-02T00:00:00Z') + days * 86_400_000).toISOString(),
    });
    const beforeFrom = bug({ createdAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-20T00:00:00Z' });
    const odd = buildBugTrend([fixed(1), fixed(3), fixed(2), beforeFrom], OPTS);
    expect(odd.kpis.medianDaysToFix).toBe(2);
    expect(odd.kpis.fixedCount).toBe(3);
    const even = buildBugTrend([fixed(1), fixed(3), fixed(2), fixed(4)], OPTS);
    expect(even.kpis.medianDaysToFix).toBe(2.5);
  });

  it('reports null median and zero fixes when nothing was fixed', () => {
    const t = buildBugTrend([bug({ createdAt: '2026-09-02T00:00:00Z' })], OPTS);
    expect(t.kpis.medianDaysToFix).toBeNull();
    expect(t.kpis.fixedCount).toBe(0);
  });
});

describe('buildBugTrend: issues and passthrough', () => {
  it('lists bugs created since `from` plus older ones still open, newest first', () => {
    const oldOpen = bug({ createdAt: '2026-07-01T00:00:00Z' });
    const oldFixed = bug({ createdAt: '2026-07-01T00:00:00Z', completedAt: '2026-07-02T00:00:00Z' });
    const recent = bug({ createdAt: '2026-09-10T00:00:00Z' });
    const newer = bug({ createdAt: '2026-09-20T00:00:00Z', completedAt: '2026-09-21T00:00:00Z' });
    const t = buildBugTrend([oldOpen, oldFixed, recent, newer], OPTS);
    expect(t.issues.map(b => b.identifier)).toEqual([newer.identifier, recent.identifier, oldOpen.identifier]);
  });

  it('lists a first-bar bug created before a non-Monday `from`, even when fixed before `from`', () => {
    const firstBar = bug({ createdAt: '2026-08-31T10:00:00Z', completedAt: '2026-08-31T15:00:00Z' });
    const t = buildBugTrend([firstBar], OPTS);
    expect(t.weeks[0].total).toBe(1);
    expect(t.issues.map(b => b.identifier)).toEqual([firstBar.identifier]);
  });

  it('passes from, asOf and markerDate through', () => {
    const t = buildBugTrend([], OPTS);
    expect(t.from).toBe('2026-09-01');
    expect(t.asOf).toBe('2026-09-24T12:00:00.000Z');
    expect(t.markerDate).toBe('2026-08-01');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginPlanGeneration, clampFindingsPage, completePlanGeneration, countFindings, dismissFinding, insertFinding,
  listFindings, upsertPieceUsage,
} from './vendor-watch-queries.js';
import { resetVendorWatch, sampleDraft, samplePlanResult } from './vendor-watch-test-utils.js';
import type { Severity } from '../services/vendor-watch/types.js';

const P = (s: string) => `@activepieces/piece-${s}`;

/** `n` new findings for one piece, oldest first. Returns their ids. */
function findings(name: string, n: number, severity: Severity = 'high'): number[] {
  const p = completePlanGeneration(beginPlanGeneration(name).id, samplePlanResult());
  return Array.from({ length: n }, (_, i) => insertFinding({
    plan_id: p.id, piece_name: name, source_id: null, run_id: null,
    draft: sampleDraft({ severity, signature: `${name}-${severity}-${i}` }),
  })!.id);
}

function usage(name: string, projects: number) {
  upsertPieceUsage([{ piece_name: name, projects, versions: 2, versions_failed: 0 }]);
}

const ids = (rows: { id: number }[]) => rows.map(r => r.id);

describe('findings paging', () => {
  beforeEach(resetVendorWatch);

  it('returns the newest 100 by default', () => {
    const all = findings(P('acme'), 120);
    expect(ids(listFindings({}))).toEqual([...all].reverse().slice(0, 100));
  });

  it('walks every finding once, in order, with limit and offset', () => {
    const all = findings(P('acme'), 7);
    const pages = [0, 3, 6].map(offset => ids(listFindings({}, { limit: 3, offset })));
    expect(pages.map(p => p.length)).toEqual([3, 3, 1]);
    expect(pages.flat()).toEqual([...all].reverse());
  });

  it('returns an empty page past the end, and the total does not change', () => {
    findings(P('acme'), 5);
    expect(listFindings({}, { limit: 3, offset: 5 })).toEqual([]);
    expect(listFindings({}, { limit: 3, offset: 500 })).toEqual([]);
    expect(countFindings({})).toBe(5);
  });

  it('clamps the limit to 1..200 and the offset to 0 or more', () => {
    findings(P('acme'), 205);
    expect(listFindings({}, { limit: 500 })).toHaveLength(200);
    expect(listFindings({}, { limit: 0 })).toHaveLength(1);
    expect(listFindings({}, { limit: -5 })).toHaveLength(1);
    expect(ids(listFindings({}, { limit: 2, offset: -10 }))).toEqual(ids(listFindings({}, { limit: 2 })));
    expect(countFindings({})).toBe(205);
  });

  it('reads missing or non-numeric values as the defaults', () => {
    expect(clampFindingsPage({})).toEqual({ limit: 100, offset: 0 });
    expect(clampFindingsPage({ limit: NaN, offset: NaN })).toEqual({ limit: 100, offset: 0 });
    expect(clampFindingsPage({ limit: 250, offset: -1 })).toEqual({ limit: 200, offset: 0 });
    expect(clampFindingsPage({ limit: 0, offset: 40 })).toEqual({ limit: 1, offset: 40 });
    expect(clampFindingsPage({ limit: 50.7, offset: 7.9 })).toEqual({ limit: 50, offset: 7 });
  });

  it('keeps the importance sort across pages', () => {
    usage(P('stripe'), 491);
    usage(P('slack'), 60);
    findings(P('slack'), 2, 'critical');
    findings(P('acme'), 3, 'low');
    findings(P('stripe'), 4, 'medium');
    const whole = ids(listFindings({ status: 'new', sort: 'importance' }, { limit: 200 }));
    const paged = [0, 2, 4, 6, 8].flatMap(offset => ids(listFindings({ status: 'new', sort: 'importance' }, { limit: 2, offset })));
    expect(paged).toEqual(whole);
    expect(whole).toHaveLength(9);
  });
});

describe('countFindings', () => {
  beforeEach(resetVendorWatch);

  it('counts what the filter matches, importance included, whatever the page', () => {
    usage(P('stripe'), 491);
    usage(P('slack'), 60);
    const stripe = findings(P('stripe'), 3);
    findings(P('slack'), 2);
    findings(P('acme'), 4);
    dismissFinding(stripe[0]);

    expect(countFindings({})).toBe(9);
    expect(countFindings({ importance: ['high'] })).toBe(3);
    expect(countFindings({ importance: ['high', 'unrated'] })).toBe(7);
    expect(countFindings({ importance: ['low'] })).toBe(0);
    expect(countFindings({ status: 'new', importance: ['high'] })).toBe(2);
    expect(countFindings({ status: 'dismissed' })).toBe(1);
    expect(countFindings({ piece: P('slack'), importance: ['high'] })).toBe(0);
    expect(countFindings({ piece: P('slack'), importance: ['medium'] })).toBe(2);
    expect(listFindings({ importance: ['high', 'unrated'] }, { limit: 2 })).toHaveLength(2);
    expect(countFindings({ importance: ['high', 'unrated'] })).toBe(7);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import {
  beginPlanGeneration, completePlanGeneration, countFindingsByImportance, getPieceImportance, insertFinding,
  listFindings, listPieceUsage, listPlans, stalePieces, updateWatchConfig, upsertPieceUsage, usageSummary,
  type FindingFilter,
} from './vendor-watch-queries.js';
import { resetVendorWatch, sampleDraft, samplePlanResult } from './vendor-watch-test-utils.js';
import type { Severity } from '../services/vendor-watch/types.js';

const P = (s: string) => `@activepieces/piece-${s}`;

function plan(name: string) {
  const p = beginPlanGeneration(name);
  return completePlanGeneration(p.id, samplePlanResult());
}

function finding(name: string, severity: Severity, sig: string) {
  const p = plan(name);
  return insertFinding({ plan_id: p.id, piece_name: name, source_id: null, run_id: null, draft: sampleDraft({ severity, signature: sig }) })!;
}

function usage(name: string, projects: number, fetchedAt?: string) {
  upsertPieceUsage([{ piece_name: name, projects, versions: 3, versions_failed: 0 }], fetchedAt);
}

describe('piece importance rule', () => {
  beforeEach(resetVendorWatch);

  it.each([
    [300, 'high'], [299, 'medium'], [50, 'medium'], [49, 'low'], [0, 'low'],
  ])('rates %i Cloud projects as %s with the default thresholds', (projects, tier) => {
    usage(P('acme'), projects);
    expect(getPieceImportance(P('acme'))).toMatchObject({ importance: tier, enterprise: 0, usage_projects: projects });
  });

  it('leaves a piece with no usage row unrated', () => {
    expect(getPieceImportance(P('acme'))).toEqual({ importance: null, enterprise: 0, usage_projects: null, usage_fetched_at: null });
  });

  it('rates an Enterprise-list piece High whatever its usage, even with no usage row', () => {
    updateWatchConfig({ enterprise_pieces: JSON.stringify([P('sap'), P('netsuite')]) });
    usage(P('netsuite'), 6);
    expect(getPieceImportance(P('netsuite'))).toMatchObject({ importance: 'high', enterprise: 1, usage_projects: 6 });
    expect(getPieceImportance(P('sap'))).toMatchObject({ importance: 'high', enterprise: 1, usage_projects: null });
  });

  it('ignores a malformed Enterprise list instead of failing every query', () => {
    getDb().run(`UPDATE vendor_watch_config SET enterprise_pieces = 'netsuite' WHERE id = 1`);
    usage(P('acme'), 400);
    expect(getPieceImportance(P('acme'))).toMatchObject({ importance: 'high', enterprise: 0 });
    expect(() => listFindings({})).not.toThrow();
    expect(() => listPlans()).not.toThrow();
    expect(() => listPieceUsage()).not.toThrow();
  });

  it('re-rates at once when the thresholds change, with no refresh', () => {
    usage(P('stripe'), 491);
    expect(getPieceImportance(P('stripe'))!.importance).toBe('high');
    updateWatchConfig({ importance_high_min: 1000, importance_medium_min: 500 });
    expect(getPieceImportance(P('stripe'))!.importance).toBe('low');
  });
});

describe('piece_usage rows', () => {
  beforeEach(resetVendorWatch);

  it('replaces a piece row on refresh', () => {
    usage(P('slack'), 10, '2026-01-01 00:00:00');
    upsertPieceUsage([{ piece_name: P('slack'), projects: 1825, versions: 140, versions_failed: 2 }]);
    const row = getDb().get<{ projects: number; versions: number; versions_failed: number; fetched_at: string }>(
      'SELECT * FROM piece_usage WHERE piece_name = ?', [P('slack')],
    )!;
    expect(row).toMatchObject({ projects: 1825, versions: 140, versions_failed: 2 });
    expect(row.fetched_at > '2026-01-01').toBe(true);
  });

  it('keeps a complete row when a refresh comes back partial and lower', () => {
    usage(P('slack'), 1825, '2026-01-01 00:00:00');
    upsertPieceUsage([{ piece_name: P('slack'), projects: 40, versions: 140, versions_failed: 3 }]);
    expect(getPieceImportance(P('slack'))).toMatchObject({ usage_projects: 1825, usage_fetched_at: '2026-01-01 00:00:00' });
    upsertPieceUsage([{ piece_name: P('slack'), projects: 1900, versions: 140, versions_failed: 3 }]);
    expect(getPieceImportance(P('slack')).usage_projects).toBe(1900);
    upsertPieceUsage([{ piece_name: P('slack'), projects: 30, versions: 140, versions_failed: 0 }]);
    expect(getPieceImportance(P('slack')).usage_projects).toBe(30);
  });

  it('lists every rated piece plus Enterprise-list pieces that have no row', () => {
    updateWatchConfig({ enterprise_pieces: JSON.stringify([P('sap')]) });
    usage(P('slack'), 1825);
    usage(P('zagomail'), 1);
    const byName = Object.fromEntries(listPieceUsage().map(r => [r.piece_name, r]));
    expect(Object.keys(byName).sort()).toEqual([P('sap'), P('slack'), P('zagomail')]);
    expect(byName[P('sap')]).toMatchObject({ importance: 'high', enterprise: 1, usage_projects: null });
    expect(byName[P('slack')]).toMatchObject({ importance: 'high', enterprise: 0, usage_projects: 1825 });
    expect(byName[P('zagomail')]).toMatchObject({ importance: 'low' });
  });

  it('reports pieces with no row, a row past the cut-off, or a partial row older than a day', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    usage(P('fresh'), 5);
    usage(P('old'), 5, '2020-01-01 00:00:00');
    upsertPieceUsage([{ piece_name: P('partial-new'), projects: 5, versions: 4, versions_failed: 1 }], hoursAgo(2));
    upsertPieceUsage([{ piece_name: P('partial-old'), projects: 5, versions: 4, versions_failed: 1 }], hoursAgo(30));
    expect(stalePieces([P('fresh'), P('old'), P('missing'), P('partial-new'), P('partial-old')], 7).sort())
      .toEqual([P('missing'), P('old'), P('partial-old')]);
    expect(stalePieces([], 7)).toEqual([]);
  });

  it('summarises how many pieces are rated and how old the data is', () => {
    expect(usageSummary()).toEqual({ rated: 0, oldest_fetched_at: null, newest_fetched_at: null });
    usage(P('a'), 1, '2026-10-01 00:00:00');
    usage(P('b'), 1, '2026-10-05 00:00:00');
    expect(usageSummary()).toEqual({ rated: 2, oldest_fetched_at: '2026-10-01 00:00:00', newest_fetched_at: '2026-10-05 00:00:00' });
  });
});

describe('findings and plans by importance', () => {
  beforeEach(() => {
    resetVendorWatch();
    usage(P('sheets'), 14303);
    usage(P('hubspot'), 120);
    usage(P('zagomail'), 1);
    updateWatchConfig({ enterprise_pieces: JSON.stringify([P('salesforce')]) });
  });

  function seed() {
    const low = finding(P('zagomail'), 'critical', 'z1');
    const unrated = finding(P('newpiece'), 'high', 'n1');
    const medium = finding(P('hubspot'), 'high', 'h1');
    const highLow = finding(P('sheets'), 'low', 's1');
    const ent = finding(P('salesforce'), 'medium', 'e1');
    const highCrit = insertFinding({
      plan_id: highLow.plan_id, piece_name: P('sheets'), source_id: null, run_id: null,
      draft: sampleDraft({ severity: 'critical', signature: 's2' }),
    })!;
    return { low, unrated, medium, highLow, ent, highCrit };
  }

  it('returns each finding with its piece importance', () => {
    const s = seed();
    const byId = Object.fromEntries(listFindings({}).map(f => [f.id, f]));
    expect(byId[s.low.id]).toMatchObject({ importance: 'low', usage_projects: 1, enterprise: 0 });
    expect(byId[s.unrated.id]).toMatchObject({ importance: null, usage_projects: null });
    expect(byId[s.ent.id]).toMatchObject({ importance: 'high', enterprise: 1 });
  });

  it('sorts the inbox by importance (unrated above low), then severity, then newest', () => {
    const s = seed();
    expect(listFindings({ status: 'new', sort: 'importance' }).map(f => f.id))
      .toEqual([s.highCrit.id, s.ent.id, s.highLow.id, s.medium.id, s.unrated.id, s.low.id]);
  });

  it('keeps newest first by default', () => {
    const s = seed();
    expect(listFindings({ status: 'new' }).map(f => f.id))
      .toEqual([s.highCrit.id, s.ent.id, s.highLow.id, s.medium.id, s.unrated.id, s.low.id]);
  });

  it('filters by one or more tiers, including unrated', () => {
    const s = seed();
    const ids = (importance: FindingFilter['importance']) =>
      listFindings({ importance, sort: 'importance' }).map(f => f.id);
    expect(ids(['high'])).toEqual([s.highCrit.id, s.ent.id, s.highLow.id]);
    expect(ids(['medium', 'low'])).toEqual([s.medium.id, s.low.id]);
    expect(ids(['unrated'])).toEqual([s.unrated.id]);
    expect(ids(['low', 'unrated'])).toEqual([s.unrated.id, s.low.id]);
    expect(ids([])).toHaveLength(6);
  });

  it('combines the importance filter with status and piece', () => {
    const s = seed();
    expect(listFindings({ status: 'new', piece: P('sheets'), importance: ['high'] }).map(f => f.id).sort())
      .toEqual([s.highLow.id, s.highCrit.id].sort());
    expect(listFindings({ status: 'filed', importance: ['high'] })).toEqual([]);
  });

  it('counts per tier for the status and piece, ignoring any importance filter', () => {
    seed();
    expect(countFindingsByImportance({ status: 'new' })).toEqual({ high: 3, medium: 1, low: 1, unrated: 1 });
    expect(countFindingsByImportance({ status: 'new', piece: P('sheets') })).toEqual({ high: 2, medium: 0, low: 0, unrated: 0 });
    expect(countFindingsByImportance({ status: 'filed' })).toEqual({ high: 0, medium: 0, low: 0, unrated: 0 });
  });

  it('lists plans with importance, ordered by importance then piece name', () => {
    seed();
    plan(P('airtable'));
    usage(P('airtable'), 1239);
    expect(listPlans().map(p => [p.piece_name, p.importance])).toEqual([
      [P('airtable'), 'high'], [P('salesforce'), 'high'], [P('sheets'), 'high'],
      [P('hubspot'), 'medium'], [P('newpiece'), null], [P('zagomail'), 'low'],
    ]);
    expect(listPlans().find(p => p.piece_name === P('sheets'))).toMatchObject({ usage_projects: 14303, open_findings: 2 });
  });
});

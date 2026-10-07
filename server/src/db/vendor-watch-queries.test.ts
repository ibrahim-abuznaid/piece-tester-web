import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import {
  getWatchConfig, updateWatchConfig, beginPlanGeneration, completePlanGeneration, failPlanGeneration,
  getPlan, listPlans, listRunnablePlans, setPlanStatus, markStalePlans, deletePlan,
  replaceSources, listSources, setSourceEnabled, recordSourceOk, recordSourceFailure, getSnapshot, saveSnapshot,
  createRun, finishRun, getRun, insertFinding, listFindings, countOpenFindings, markFindingFiled,
  dismissFinding, findMergeTarget, targetsOverlap, reconcileVendorWatch, queuePlanGeneration,
} from './vendor-watch-queries.js';
import { resetVendorWatch, samplePlanResult, sampleDraft } from './vendor-watch-test-utils.js';

function activePlan(name = '@activepieces/piece-acme') {
  const p = beginPlanGeneration(name);
  return completePlanGeneration(p.id, samplePlanResult());
}

describe('vendor watch config', () => {
  beforeEach(resetVendorWatch);

  it('starts with safe defaults', () => {
    const c = getWatchConfig();
    expect(c).toMatchObject({ enabled: 0, auto_file_enabled: 0, linear_team_key: 'PIE', linear_label: 'vendor-watch', dead_after_failures: 3, cron_expression: '0 4 * * *', timezone: 'UTC' });
  });

  it('patches only the given fields', () => {
    updateWatchConfig({ enabled: 1, linear_label: 'vw' });
    const c = getWatchConfig();
    expect(c.enabled).toBe(1);
    expect(c.linear_label).toBe('vw');
    expect(c.linear_team_key).toBe('PIE');
  });
});

describe('watch plans', () => {
  beforeEach(resetVendorWatch);

  it('goes generating → active with the plan result stored', () => {
    const p = beginPlanGeneration('@activepieces/piece-acme');
    expect(p.status).toBe('generating');
    const done = completePlanGeneration(p.id, samplePlanResult());
    expect(done.status).toBe('active');
    expect(done.piece_display_name).toBe('Acme');
    expect(JSON.parse(done.endpoint_inventory)).toHaveLength(2);
    expect(JSON.parse(done.api_base_urls)).toEqual(['https://api.acme.dev/v1']);
    expect(done.generated_at).not.toBeNull();
    expect(listRunnablePlans().map(r => r.id)).toEqual([p.id]);
  });

  it('keeps the plan id when regenerating', () => {
    const a = activePlan();
    const again = beginPlanGeneration(a.piece_name);
    expect(again.id).toBe(a.id);
    expect(again.status).toBe('generating');
  });

  it('queues a new plan, and re-queues an existing one in place keeping its generated data', () => {
    const q = queuePlanGeneration('@activepieces/piece-new');
    expect(q).toMatchObject({ piece_name: '@activepieces/piece-new', status: 'queued', generated_at: null });
    expect(listRunnablePlans()).toEqual([]);

    const a = activePlan();
    failPlanGeneration(beginPlanGeneration(a.piece_name).id, 'old note');
    const again = queuePlanGeneration(a.piece_name);
    expect(again).toMatchObject({
      id: a.id, status: 'queued', generation_note: '', piece_display_name: 'Acme', piece_version: '0.5.0',
      api_base_urls: a.api_base_urls, endpoint_inventory: a.endpoint_inventory, generated_at: a.generated_at,
    });
    expect(beginPlanGeneration(a.piece_name)).toMatchObject({ id: a.id, status: 'generating' });
  });

  it('marks a first failed generation failed, and a failed regeneration stale', () => {
    const first = beginPlanGeneration('@activepieces/piece-new');
    expect(failPlanGeneration(first.id, 'no sources', 0.1).status).toBe('failed');
    const a = activePlan();
    beginPlanGeneration(a.piece_name);
    const failed = failPlanGeneration(a.id, 'rate limited', 0.2);
    expect(failed.status).toBe('stale');
    expect(failed.generation_note).toBe('rate limited');
  });

  it('lists plans with source and open-finding counts', () => {
    const a = activePlan();
    const [s1, s2, s3, s4] = replaceSources(a.id, [
      { kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' },
      { kind: 'liveness', url: 'https://api.acme.dev/v1', label: 'host' },
      { kind: 'html', url: 'https://acme.dev/changelog', label: 'changelog' },
      { kind: 'openapi', url: 'https://acme.dev/openapi.json', label: 'spec' },
    ]);
    recordSourceFailure(s1.id, 'HTTP 500');
    recordSourceOk(s3.id, false);
    recordSourceOk(s4.id, false);
    setSourceEnabled(s4.id, false);
    insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: s1.id, run_id: null, draft: sampleDraft() });
    const [row] = listPlans();
    expect(row).toMatchObject({ sources_total: 4, sources_ok: 1, sources_failing: 1, open_findings: 1 });
    recordSourceFailure(s2.id, 'timeout', false);
    expect(listPlans()[0]).toMatchObject({ sources_ok: 1, sources_failing: 2 });
    setSourceEnabled(s2.id, false);
    expect(listPlans()[0]).toMatchObject({ sources_ok: 1, sources_failing: 1 });
  });

  it('marks only active plans whose catalog version moved', () => {
    const a = activePlan('@activepieces/piece-a');
    const b = activePlan('@activepieces/piece-b');
    const c = activePlan('@activepieces/piece-c');
    setPlanStatus(c.id, 'paused');
    const n = markStalePlans(new Map([[a.piece_name, '0.6.0'], [b.piece_name, '0.5.0'], [c.piece_name, '0.9.0']]));
    expect(n).toBe(1);
    expect(getPlan(a.id)!.status).toBe('stale');
    expect(getPlan(b.id)!.status).toBe('active');
    expect(getPlan(c.id)!.status).toBe('paused');
  });

  it('deletes a plan with its sources, snapshots, runs and findings', () => {
    const a = activePlan();
    const [s] = replaceSources(a.id, [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' }]);
    saveSnapshot(s.id, 'h', '[]');
    const run = createRun(a.id, 'manual');
    insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: s.id, run_id: run.id, draft: sampleDraft() });
    expect(deletePlan(a.id)).toBe(true);
    const db = getDb();
    for (const t of ['watch_sources', 'watch_snapshots', 'watch_runs', 'vendor_findings']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n).toBe(0);
    }
  });
});

describe('watch sources and snapshots', () => {
  beforeEach(resetVendorWatch);

  it('keeps the row and snapshot of an unchanged source and drops removed ones', () => {
    const a = activePlan();
    const [keep, drop] = replaceSources(a.id, [
      { kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' },
      { kind: 'html', url: 'https://acme.dev/changelog', label: 'page' },
    ]);
    saveSnapshot(keep.id, 'h1', '["a"]');
    saveSnapshot(drop.id, 'h2', '["b"]');
    const after = replaceSources(a.id, [
      { kind: 'feed', url: 'https://acme.dev/rss', label: 'RSS feed' },
      { kind: 'openapi', url: 'https://acme.dev/openapi.json', label: 'spec' },
    ]);
    expect(after.map(s => s.url)).toEqual(['https://acme.dev/rss', 'https://acme.dev/openapi.json']);
    expect(after[0].id).toBe(keep.id);
    expect(after[0].label).toBe('RSS feed');
    expect(getSnapshot(keep.id)?.content_hash).toBe('h1');
    expect(getSnapshot(drop.id)).toBeUndefined();
  });

  it('re-creates a source whose kind changed', () => {
    const a = activePlan();
    const [s] = replaceSources(a.id, [{ kind: 'html', url: 'https://acme.dev/x', label: 'x' }]);
    saveSnapshot(s.id, 'h', '[]');
    const [t] = replaceSources(a.id, [{ kind: 'feed', url: 'https://acme.dev/x', label: 'x' }]);
    expect(t.kind).toBe('feed');
    expect(getSnapshot(t.id)).toBeUndefined();
  });

  it('counts failures only when asked, and resets on success', () => {
    const a = activePlan();
    const [s] = replaceSources(a.id, [{ kind: 'liveness', url: 'https://api.acme.dev', label: 'host' }]);
    expect(recordSourceFailure(s.id, 'dns_not_found')).toBe(1);
    expect(recordSourceFailure(s.id, 'timeout', false)).toBe(1);
    expect(recordSourceFailure(s.id, 'dns_not_found')).toBe(2);
    recordSourceOk(s.id, true);
    const [after] = listSources(a.id);
    expect(after.consecutive_failures).toBe(0);
    expect(after.last_error).toBe('');
    expect(after.last_changed_at).not.toBeNull();
  });
});

describe('watch runs', () => {
  beforeEach(resetVendorWatch);

  it('round-trips a run', () => {
    const a = activePlan();
    const r = createRun(a.id, 'scheduled', 'vw-1');
    expect(r.status).toBe('running');
    finishRun(r.id, 'completed', { sources_checked: 3, sources_changed: 1, sources_failed: 0, findings_created: 2, cost_usd: 0.01 }, '');
    expect(getRun(r.id)).toMatchObject({ status: 'completed', sources_checked: 3, findings_created: 2, cycle_id: 'vw-1' });
  });
});

describe('vendor findings', () => {
  beforeEach(resetVendorWatch);

  it('ignores a second finding with the same signature for the same piece', () => {
    const a = activePlan('@activepieces/piece-a');
    const b = activePlan('@activepieces/piece-b');
    expect(insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft() })).not.toBeNull();
    expect(insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft() })).toBeNull();
    expect(insertFinding({ plan_id: b.id, piece_name: b.piece_name, source_id: null, run_id: null, draft: sampleDraft() })).not.toBeNull();
  });

  it('throws on a draft missing a required field instead of reporting a duplicate', () => {
    const a = activePlan();
    for (const title of [undefined, null]) {
      const draft = sampleDraft({ title: title as unknown as string, signature: `no-title-${title}` });
      expect(() => insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft })).toThrow(/NOT NULL/);
    }
    expect(listFindings()).toEqual([]);
  });

  it('stores affects_piece from the targets', () => {
    const a = activePlan();
    const f = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ affected_targets: [], signature: 's2' }) })!;
    expect(f.affects_piece).toBe(0);
    expect(f.status).toBe('new');
  });

  it('dismisses only new findings and filters lists', () => {
    const a = activePlan();
    const f1 = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ signature: 'x1' }) })!;
    const f2 = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ signature: 'x2' }) })!;
    markFindingFiled(f2.id, { filed_by: 'auto', linear_issue_id: 'i', linear_identifier: 'PIE-1', linear_url: 'https://linear.app/x' });
    expect(dismissFinding(f2.id)!.status).toBe('filed');
    expect(dismissFinding(f1.id)!.status).toBe('dismissed');
    expect(listFindings({ status: 'filed' }).map(f => f.id)).toEqual([f2.id]);
    expect(countOpenFindings(a.piece_name)).toBe(0);
  });

  it('finds a filed finding of the same kind with overlapping targets to merge into', () => {
    const a = activePlan();
    const filed = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ signature: 'f1' }) })!;
    markFindingFiled(filed.id, { filed_by: 'auto', linear_issue_id: 'iss', linear_identifier: 'PIE-9', linear_url: 'https://linear.app/pie-9' });
    const fresh = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ signature: 'f2' }) })!;
    expect(findMergeTarget(a.piece_name, 'deprecation', ['send_message'], fresh.id)?.id).toBe(filed.id);
    expect(findMergeTarget(a.piece_name, 'deprecation', ['*'], fresh.id)?.id).toBe(filed.id);
    expect(findMergeTarget(a.piece_name, 'breaking', ['send_message'], fresh.id)).toBeNull();
    expect(findMergeTarget(a.piece_name, 'deprecation', ['new_order'], fresh.id)).toBeNull();
    expect(findMergeTarget(a.piece_name, 'deprecation', [], fresh.id)).toBeNull();
  });

  it('targetsOverlap: * overlaps any non-empty list, empty overlaps nothing', () => {
    expect(targetsOverlap(['*'], ['a'])).toBe(true);
    expect(targetsOverlap(['a'], ['*'])).toBe(true);
    expect(targetsOverlap(['a', 'b'], ['b'])).toBe(true);
    expect(targetsOverlap(['a'], ['b'])).toBe(false);
    expect(targetsOverlap([], ['*'])).toBe(false);
  });
});

describe('reconcileVendorWatch', () => {
  beforeEach(resetVendorWatch);

  it('closes interrupted runs and generations', () => {
    const a = activePlan('@activepieces/piece-a');
    createRun(a.id, 'scheduled');
    beginPlanGeneration(a.piece_name);
    const fresh = beginPlanGeneration('@activepieces/piece-fresh');
    expect(reconcileVendorWatch()).toEqual({ runs: 1, plans: 2 });
    expect(getPlan(a.id)!.status).toBe('stale');
    expect(getPlan(fresh.id)!.status).toBe('failed');
    expect(getPlan(fresh.id)!.generation_note).toBe('interrupted by restart');
  });

  it('fails plans that were still queued, alongside interrupted generations', () => {
    const a = activePlan('@activepieces/piece-a');
    queuePlanGeneration(a.piece_name);
    const fresh = queuePlanGeneration('@activepieces/piece-fresh');
    const generating = beginPlanGeneration('@activepieces/piece-generating');
    const untouched = activePlan('@activepieces/piece-b');
    expect(reconcileVendorWatch()).toEqual({ runs: 0, plans: 3 });
    for (const id of [a.id, fresh.id]) {
      expect(getPlan(id)).toMatchObject({ status: 'failed', generation_note: 'interrupted by restart (was queued)' });
    }
    expect(getPlan(generating.id)).toMatchObject({ status: 'failed', generation_note: 'interrupted by restart' });
    expect(getPlan(untouched.id)!.status).toBe('active');
  });
});

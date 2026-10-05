import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import {
  createSetupRun, addSetupRunItems, updateSetupRunItem, finalizeSetupRun,
  getSetupRunItem, createTestPlan, updateTestPlan, getTestPlan,
  reclaimInterruptedSetupRuns, MAX_SETUP_ITEM_INTERRUPTIONS,
} from './queries.js';

function item(target: string, status: 'pending' | 'running' | 'done' | 'error' | 'skipped' = 'pending') {
  return { piece_name: 'p1', piece_display_name: 'P1', target_type: 'action' as const, target_name: target, target_display_name: target.toUpperCase(), status };
}

describe('reclaimInterruptedSetupRuns', () => {
  beforeEach(() => getDb().exec('DELETE FROM setup_run_items; DELETE FROM setup_runs; DELETE FROM test_plans;'));

  it('returns only runs still marked running, with their items', () => {
    const live = createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });
    addSetupRunItems(live.id, [item('a1')]);
    const finished = createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });
    addSetupRunItems(finished.id, [item('a2', 'done')]);
    finalizeSetupRun(finished.id, { status: 'done' });

    const reclaimed = reclaimInterruptedSetupRuns();
    expect(reclaimed.map(r => r.run.id)).toEqual([live.id]);
    expect(reclaimed[0].items).toHaveLength(1);
  });

  it('puts an interrupted item back to pending and counts the interruption', () => {
    const run = createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });
    const [running, pending, done, errored] = addSetupRunItems(run.id, [
      item('a1', 'running'), item('a2', 'pending'), item('a3', 'done'), item('a4', 'error'),
    ]);

    reclaimInterruptedSetupRuns();

    expect(getSetupRunItem(running.id)).toMatchObject({ status: 'pending', interruptions: 1 });
    expect(getSetupRunItem(pending.id)).toMatchObject({ status: 'pending', interruptions: 0 });
    expect(getSetupRunItem(done.id)!.status).toBe('done');
    expect(getSetupRunItem(errored.id)!.status).toBe('error');
  });

  it('gives up on an item that keeps getting interrupted (e.g. it crashes the server)', () => {
    const run = createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });
    const [it1] = addSetupRunItems(run.id, [item('a1', 'running')]);

    for (let i = 1; i < MAX_SETUP_ITEM_INTERRUPTIONS; i++) {
      reclaimInterruptedSetupRuns();
      expect(getSetupRunItem(it1.id)!.status).toBe('pending');
      updateSetupRunItem(it1.id, { status: 'running' });
    }
    reclaimInterruptedSetupRuns();

    const final = getSetupRunItem(it1.id)!;
    expect(final.status).toBe('error');
    expect(final.error).toMatch(/interrupted/i);
  });

  it('marks an interrupted item done when its plan already got approved', () => {
    const run = createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });
    const [it1] = addSetupRunItems(run.id, [item('a1', 'running')]);
    const plan = createTestPlan({ piece_name: 'p1', target_action: 'a1', steps: '[]', status: 'approved' });
    updateSetupRunItem(it1.id, { plan_id: plan.id });

    reclaimInterruptedSetupRuns();

    expect(getSetupRunItem(it1.id)).toMatchObject({ status: 'done', plan_id: plan.id });
  });

  it('keeps a half-built draft so the retry overwrites it instead of duplicating', () => {
    const run = createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });
    const [it1] = addSetupRunItems(run.id, [item('a1', 'running')]);
    const plan = createTestPlan({ piece_name: 'p1', target_action: 'a1', steps: '[]', status: 'draft' });
    updateSetupRunItem(it1.id, { plan_id: plan.id });

    reclaimInterruptedSetupRuns();

    expect(getSetupRunItem(it1.id)!.status).toBe('pending');
    expect(getTestPlan(plan.id)!.status).toBe('draft');
  });

  it('skips a pending item whose target got an approved plan some other way meanwhile', () => {
    const run = createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });
    const [it1] = addSetupRunItems(run.id, [item('a1', 'pending')]);
    const plan = createTestPlan({ piece_name: 'p1', target_action: 'a1', steps: '[]', status: 'draft' });
    updateTestPlan(plan.id, { status: 'approved' });

    reclaimInterruptedSetupRuns();

    expect(getSetupRunItem(it1.id)).toMatchObject({ status: 'skipped' });
  });
});

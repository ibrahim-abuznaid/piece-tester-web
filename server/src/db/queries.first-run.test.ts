import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import {
  createTestPlan, createPlanRun, updatePlanRun, createSchedule, createSetupRun, getSetupRun,
  startSetupFirstRun, completeSetupFirstRun, closeOrphanedFirstRuns, getWaveSummary, getScheduledWaves, getWaveDetail,
} from './queries.js';

describe('setup first run queries', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM setup_runs; DELETE FROM schedules;'));

  it('getWaveSummary aggregates one wave and is null for an unknown wave', () => {
    const plan = createTestPlan({ piece_name: 'a', target_action: 'x', steps: '[{"id":"s1"}]', status: 'approved' });
    const wave = { wave_id: 'setup1-1' };
    const r1 = createPlanRun(plan.id, 'scheduled', wave);
    const r2 = createPlanRun(plan.id, 'scheduled', wave);
    createPlanRun(plan.id, 'scheduled', wave);
    updatePlanRun(r1.id, { status: 'completed', completed_at: '2026-10-09 10:00:00' });
    updatePlanRun(r2.id, { status: 'failed', completed_at: '2026-10-09 10:01:00' });

    expect(getWaveSummary('setup1-1')).toMatchObject({ wave_id: 'setup1-1', total: 3, passed: 1, failed: 1, running: 1, blocked: 0 });
    expect(getWaveSummary('nope')).toBeNull();
  });

  it('labels a setup wave after its setup run; schedule waves keep the schedule label', () => {
    const plan = createTestPlan({ piece_name: 'a', target_action: 'x', steps: '[{"id":"s1"}]', status: 'approved' });
    const setup = createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });
    startSetupFirstRun(setup.id, { wave_id: 'setup-wave', total: 1 });
    createPlanRun(plan.id, 'scheduled', { wave_id: 'setup-wave' });

    const sched = createSchedule({ piece_name: 'a', cron_expression: '0 3 1 * *', label: 'Auto: a', targets: '[{"piece_name":"a"}]' });
    createPlanRun(plan.id, 'scheduled', { wave_id: 'cron-wave', schedule_id: sched.id });
    createPlanRun(plan.id, 'scheduled', { wave_id: 'orphan-wave' });

    const labels = Object.fromEntries(getScheduledWaves().map(w => [w.wave_id, w.schedule_label]));
    expect(labels).toEqual({ 'setup-wave': `Setup run #${setup.id} — first run`, 'cron-wave': 'Auto: a', 'orphan-wave': null });
    expect(getWaveDetail('setup-wave')?.schedule_label).toBe(`Setup run #${setup.id} — first run`);
  });

  it('closeOrphanedFirstRuns closes only first runs still open', () => {
    const done = createSetupRun({ cadence: 'none', cron_template: '', config: '{}' });
    startSetupFirstRun(done.id, { wave_id: 'w-done', total: 1 });
    completeSetupFirstRun(done.id);
    const open = createSetupRun({ cadence: 'none', cron_template: '', config: '{}' });
    startSetupFirstRun(open.id, { wave_id: 'w-open', total: 1 });
    const never = createSetupRun({ cadence: 'none', cron_template: '', config: '{}' });

    expect(closeOrphanedFirstRuns()).toBe(1);
    expect(getSetupRun(open.id)!.first_run_completed_at).not.toBeNull();
    expect(getSetupRun(never.id)!.first_run_wave_id).toBeNull();
    expect(getSetupRun(never.id)!.first_run_completed_at).toBeNull();
  });
});

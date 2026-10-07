import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { beginPlanGeneration, completePlanGeneration, getPlan, setPlanStatus, updateWatchConfig } from '../../db/vendor-watch-queries.js';
import { resetVendorWatch, samplePlanResult } from '../../db/vendor-watch-test-utils.js';
import { initVendorWatch, isCycleRunning, runWatchCycle, stopVendorWatch } from './cron.js';

function active(name: string) {
  const p = beginPlanGeneration(name);
  return completePlanGeneration(p.id, samplePlanResult());
}

describe('initVendorWatch', () => {
  beforeEach(resetVendorWatch);
  afterEach(stopVendorWatch);

  it('registers nothing while disabled', () => {
    expect(initVendorWatch()).toBe(false);
  });

  it('registers the cron when enabled with a valid expression', () => {
    updateWatchConfig({ enabled: 1 });
    expect(initVendorWatch()).toBe(true);
  });

  it('refuses an invalid expression', () => {
    updateWatchConfig({ enabled: 1, cron_expression: 'not a cron' });
    expect(initVendorWatch()).toBe(false);
  });
});

describe('runWatchCycle', () => {
  beforeEach(resetVendorWatch);

  it('marks stale plans, then runs only active and stale plans under one cycle id', async () => {
    const a = active('@activepieces/piece-a');
    const b = active('@activepieces/piece-b');
    const c = active('@activepieces/piece-c');
    setPlanStatus(c.id, 'paused');
    beginPlanGeneration('@activepieces/piece-d');
    const ran: { id: number; cycle: string }[] = [];
    const r = await runWatchCycle({
      catalogVersions: async () => new Map([[b.piece_name, '9.9.9']]),
      runPlan: async (id, cycle) => { ran.push({ id, cycle }); },
    });
    expect(r).toMatchObject({ started: true, plans: 2, staleMarked: 1 });
    expect(getPlan(b.id)!.status).toBe('stale');
    expect(ran.map(x => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(new Set(ran.map(x => x.cycle)).size).toBe(1);
  });

  it('refuses to overlap a running cycle', async () => {
    active('@activepieces/piece-a');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const first = runWatchCycle({ catalogVersions: async () => new Map(), runPlan: () => gate });
    expect(isCycleRunning()).toBe(true);
    expect(await runWatchCycle({ catalogVersions: async () => new Map(), runPlan: async () => {} })).toEqual({ started: false });
    release();
    await first;
    expect(isCycleRunning()).toBe(false);
  });

  it('still runs plans when the catalog cannot be reached', async () => {
    active('@activepieces/piece-a');
    const ran: number[] = [];
    const r = await runWatchCycle({
      catalogVersions: async () => { throw new Error('offline'); },
      runPlan: async (id) => { ran.push(id); },
    });
    expect(r).toMatchObject({ started: true, plans: 1, staleMarked: 0 });
    expect(ran).toHaveLength(1);
  });
});

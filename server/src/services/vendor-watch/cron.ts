import cron from 'node-cron';
import { getWatchConfig, listRunnablePlans, markStalePlans } from '../../db/vendor-watch-queries.js';
import { runWithConcurrency } from '../concurrency.js';
import { createClient } from '../test-engine.js';
import { startWatchRun } from './runner.js';

export interface CycleDeps {
  catalogVersions?: () => Promise<Map<string, string>>;
  runPlan?: (planId: number, cycleId: string) => Promise<unknown>;
}

export interface CycleResult {
  started: boolean;
  cycleId?: string;
  plans?: number;
  staleMarked?: number;
}

const PLAN_CONCURRENCY = 3;
let task: cron.ScheduledTask | null = null;
let cycleRunning = false;

export function isCycleRunning(): boolean {
  return cycleRunning;
}

async function catalogVersionsFromAp(): Promise<Map<string, string>> {
  const pieces = await createClient().listPieces();
  return new Map(pieces.map(p => [p.name, p.version]));
}

/** One watch cycle: mark stale plans, then run every active/stale plan, 3 at a time. Never overlaps itself. */
export async function runWatchCycle(deps: CycleDeps = {}): Promise<CycleResult> {
  if (cycleRunning) return { started: false };
  cycleRunning = true;
  const cycleId = `vw-${Date.now()}`;
  try {
    let staleMarked = 0;
    try {
      staleMarked = markStalePlans(await (deps.catalogVersions ?? catalogVersionsFromAp)());
    } catch (err: any) {
      console.warn(`[vendor-watch] stale check skipped: ${err?.message || err}`);
    }
    const plans = listRunnablePlans();
    const runPlan = deps.runPlan ?? ((id: number, c: string) => startWatchRun(id, 'scheduled', { cycleId: c }).done);
    await runWithConcurrency(plans, PLAN_CONCURRENCY, async (p) => {
      try {
        await runPlan(p.id, cycleId);
      } catch (err: any) {
        console.error(`[vendor-watch] ${p.piece_name} failed: ${err?.message || err}`);
      }
    });
    console.log(`[vendor-watch] cycle ${cycleId}: ${plans.length} plan(s), ${staleMarked} marked stale`);
    return { started: true, cycleId, plans: plans.length, staleMarked };
  } finally {
    cycleRunning = false;
  }
}

export function stopVendorWatch(): void {
  task?.stop();
  task = null;
}

/** (Re)register the daily cycle from vendor_watch_config. Returns whether a cron task is now registered. */
export function initVendorWatch(): boolean {
  stopVendorWatch();
  const c = getWatchConfig();
  if (!c.enabled) return false;
  if (!cron.validate(c.cron_expression)) {
    console.warn(`[vendor-watch] invalid cron "${c.cron_expression}" — not scheduled`);
    return false;
  }
  try {
    task = cron.schedule(c.cron_expression, () => { void runWatchCycle(); }, { timezone: c.timezone || 'UTC' });
  } catch (err: any) {
    console.warn(`[vendor-watch] could not register the cron: ${err?.message || err}`);
    return false;
  }
  console.log(`[vendor-watch] cycle scheduled: ${c.cron_expression} (${c.timezone || 'UTC'})`);
  return true;
}

export const reloadVendorWatch = initVendorWatch;

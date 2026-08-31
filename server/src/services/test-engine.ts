import { ActivepiecesClient } from './ap-client.js';
import { getSettings, listTestPlans, type ScheduleTarget, type WaveInfo } from '../db/queries.js';
import { executePlan } from './plan-executor.js';

/**
 * Creates an AP client from current DB settings.
 * If a JWT token is available, it's passed to the client for test-step support.
 */
export function createClient(): ActivepiecesClient {
  const s = getSettings();
  if (!s.api_key || !s.project_id) throw new Error('Activepieces settings not configured. Go to Settings page first.');
  return new ActivepiecesClient(s.base_url, s.api_key, s.project_id, s.jwt_token || undefined);
}

/**
 * Run scheduled tests for the given targets (approved plans only).
 * targets = [] means "all pieces, all actions".
 *
 * `wave` identifies the schedule fire that triggered this batch; it's stamped onto
 * every plan run created here so the whole batch can be grouped as one "wave" and
 * linked back to its schedule.
 */
export async function runScheduledTests(targets?: ScheduleTarget[] | null, wave?: WaveInfo): Promise<void> {
  // ── Test plan runs (modern approach) ──
  const allPlans = listTestPlans();
  const plansToRun = allPlans.filter(p => {
    if (p.status !== 'approved') return false;
    if (!targets || targets.length === 0) return true;
    return targets.some(t =>
      t.piece_name === p.piece_name &&
      (!t.action_name || t.action_name === p.target_action)
    );
  });

  const validPlans = plansToRun.filter(p => {
    try {
      const steps = JSON.parse(p.steps);
      if (!Array.isArray(steps) || steps.length === 0) {
        console.warn(`[scheduler] Skipping plan #${p.id} (${p.target_action}): no steps defined`);
        return false;
      }
      return true;
    } catch {
      console.warn(`[scheduler] Skipping plan #${p.id} (${p.target_action}): invalid steps JSON`);
      return false;
    }
  });

  if (validPlans.length > 0) {
    console.log(`[scheduler] Running ${validPlans.length} test plan(s)...`);
    (async () => {
      for (const plan of validPlans) {
        try {
          await executePlan(plan.id, () => {}, 'scheduled', undefined, wave);
        } catch (err) {
          console.error(`[scheduler] Plan #${plan.id} (${plan.target_action}) failed:`, err);
        }
      }
    })();
  }

}

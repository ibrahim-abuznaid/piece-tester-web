import cron from 'node-cron';
import { listSchedules, updateSchedule, type ScheduleTarget } from '../db/queries.js';
import { runScheduledTests } from './test-engine.js';

const activeTasks = new Map<number, cron.ScheduledTask>();

/**
 * Load all enabled schedules from DB and register cron jobs.
 * Call on server startup and whenever schedules change.
 */
export function initScheduler(): void {
  // Stop all existing tasks
  for (const task of activeTasks.values()) task.stop();
  activeTasks.clear();

  const schedules = listSchedules();
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;

    if (!cron.validate(schedule.cron_expression)) {
      console.warn(`[scheduler] Skipping schedule #${schedule.id} — invalid cron expression: "${schedule.cron_expression}"`);
      continue;
    }

    const tz = schedule.timezone || 'UTC';
    const label = schedule.label || `Schedule #${schedule.id}`;

    // Parse targets from JSON; fall back to legacy piece_name for old records
    let targets: ScheduleTarget[] | null = null;
    try {
      const parsed = JSON.parse(schedule.targets || '[]');
      targets = Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
    } catch { /* treat as all */ }
    // Legacy fallback: if no targets but piece_name set, convert to a single target
    if (!targets && schedule.piece_name) {
      targets = [{ piece_name: schedule.piece_name }];
    }

    const targetDesc = targets
      ? targets.map(t => t.action_name ? `${t.piece_name}/${t.action_name}` : t.piece_name).join(', ')
      : 'all';

    let task: cron.ScheduledTask;
    try {
      task = cron.schedule(schedule.cron_expression, async () => {
        console.log(`[scheduler] Running "${label}" (targets: ${targetDesc}, tz: ${tz})`);
        try {
          await runScheduledTests(targets);
          updateSchedule(schedule.id, { last_run_at: new Date().toISOString() });
        } catch (err) {
          console.error(`[scheduler] "${label}" failed:`, err);
        }
      }, { timezone: tz });
    } catch (err: any) {
      console.warn(`[scheduler] Skipping schedule #${schedule.id} ("${label}") — failed to register: ${err.message}`);
      continue;
    }

    activeTasks.set(schedule.id, task);
    console.log(`[scheduler] Registered "${label}": ${schedule.cron_expression} (${tz})`);
  }

  console.log(`[scheduler] Registered ${activeTasks.size} active schedule(s)`);
}

/**
 * Reload schedules (call after CRUD operations on schedules table).
 */
export function reloadScheduler(): void {
  initScheduler();
}

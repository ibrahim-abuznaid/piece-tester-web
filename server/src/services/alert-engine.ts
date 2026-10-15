import { executePlan } from './plan-executor.js';
import { categoryOfStep } from './error-category.js';

// 'unknown' is piece-implicating on purpose: an unclassifiable failure should be
// surfaced, not silently swallowed.
export const PIECE_IMPLICATING = new Set(['piece_error', 'assert_failed', 'bad_request', 'not_found', 'unknown']);
const ENV_NOISE = new Set(['auth', 'rate_limit', 'transient', 'quota']);

export interface RunOutcome { outcome: 'passed' | 'failed'; category: string; error: string | null; }

/** Parse a run's step_results into a single outcome + the piece-implicating category/error. */
export function analyzeRun(run: { status: string; step_results?: string | null }): RunOutcome {
  // A blocked run (broken connection or stale plan) is NOT a piece bug — its target was
  // skipped, not exercised. 'blocked' is neither piece-implicating nor env-noise, so the
  // caller skips it (no alert, no recovery). The Health tab already surfaces these.
  if (run.status === 'blocked') return { outcome: 'failed', category: 'blocked', error: 'run blocked (connection or stale plan)' };
  let steps: any[] = [];
  try { const p = JSON.parse(run.step_results || '[]'); if (Array.isArray(p)) steps = p; } catch { /* ignore */ }
  const thrown = steps.find(s => s && s.status === 'failed');
  if (thrown) return { outcome: 'failed', category: categoryOfStep(thrown), error: shorten(thrown.error) };
  const asserted = steps.find(s => s && s.status === 'assert_failed');
  if (asserted) return { outcome: 'failed', category: 'assert_failed', error: shorten(asserted.error) };
  if (run.status === 'completed') return { outcome: 'passed', category: 'none', error: null };
  return { outcome: 'failed', category: 'unknown', error: null };
}

function shorten(e: string | null | undefined): string | null {
  if (!e) return null;
  const first = String(e).split('\n')[0].trim();
  return first.length > 180 ? first.slice(0, 180) + '…' : first;
}

export interface RetestResult { failed: number; passed: number; inconclusive: number; }

/** Re-run a plan `times` times (out of band, trigger_type='retest') and tally outcomes. */
export async function retestTarget(planId: number, times: number, exec = executePlan): Promise<RetestResult> {
  const r: RetestResult = { failed: 0, passed: 0, inconclusive: 0 };
  for (let i = 0; i < times; i++) {
    let run: any;
    try { run = await exec(planId, () => {}, 'retest'); } catch { r.inconclusive++; continue; }
    const a = analyzeRun(run);
    if (a.outcome === 'passed') r.passed++;
    else if (PIECE_IMPLICATING.has(a.category)) r.failed++;
    else r.inconclusive++; // retest itself hit env-noise
  }
  return r;
}

export { ENV_NOISE };

import { alertEmbed, accountEmbed, stormEmbed, errorSignature, postDiscordMessage, editDiscordMessage, type DiscordMessage } from './notifier.js';
import type { AlertRow } from '../db/queries.js';
import { getSettings, listQuarantine, getOpenAlert, createAlert, updateAlert, recoverAlert, listOpenAlerts } from '../db/queries.js';

export interface AlertDeps {
  getSettings: () => { notify_webhook_url: string; notify_enabled: number; notify_storm_threshold: number; notify_retest_count: number };
  isQuarantined: (piece: string, action: string | null) => boolean;
  getOpenAlert: (piece: string, action: string | null) => AlertRow | undefined;
  createAlert: (p: { piece_name: string; target_action: string | null; target_type?: string | null; error_signature: string; error_category: string | null; error_message: string | null; last_run_id?: number | null; last_wave_id?: string | null; schedule_id?: number | null }) => AlertRow;
  updateAlert: (id: number, u: Partial<AlertRow>) => AlertRow | undefined;
  recoverAlert: (id: number) => AlertRow | undefined;
  listOpenAlerts: () => AlertRow[];
  post: (webhook: string, msg: DiscordMessage) => Promise<{ id: string }>;
  edit: (webhook: string, messageId: string, msg: DiscordMessage) => Promise<void>;
  retest: (planId: number, times: number) => Promise<RetestResult>;
  appBaseUrl: string;
}

export interface WaveState {
  failures: number;
  suppressed: number;
  passedTargets: Array<{ piece: string; action: string | null }>;
  quotaPieces: Set<string>;
}
export function newWaveState(): WaveState { return { failures: 0, suppressed: 0, passedTargets: [], quotaPieces: new Set() }; }

// An account alert is keyed by piece (target_type 'account'); target_action records the
// first action that hit the wall, so recovery waits for a target known to need credits.
const ACCOUNT = 'account';

async function raiseAccountAlert(
  run: { id: number }, plan: { piece_name: string; target_action: string | null },
  wave: { wave_id?: string; schedule_id?: number }, error: string | null, webhook: string, deps: AlertDeps,
): Promise<void> {
  const open = deps.listOpenAlerts().find(x => x.piece_name === plan.piece_name && x.target_type === ACCOUNT);
  if (open?.discord_message_id) {
    deps.updateAlert(open.id, { last_seen_at: new Date().toISOString(), last_run_id: run.id, last_wave_id: wave.wave_id ?? null });
    return;
  }
  const alert = open ?? deps.createAlert({ piece_name: plan.piece_name, target_action: plan.target_action, target_type: ACCOUNT, error_signature: 'quota', error_category: 'quota', error_message: error, last_run_id: run.id, last_wave_id: wave.wave_id ?? null, schedule_id: wave.schedule_id ?? null });
  try {
    const posted = await deps.post(webhook, accountEmbed(alert, { appBaseUrl: deps.appBaseUrl }));
    deps.updateAlert(alert.id, { status: 'confirmed', discord_message_id: posted.id });
  } catch (err) {
    console.error(`[alerts] credits notice failed for ${plan.piece_name}:`, err);
  }
}

export async function processRunAlert(
  run: { id: number; status: string; step_results?: string | null },
  plan: { id: number; piece_name: string; target_action: string | null; target_type?: string | null },
  wave: { wave_id?: string; schedule_id?: number },
  ws: WaveState,
  deps: AlertDeps,
): Promise<void> {
  const s = deps.getSettings();
  if (!s.notify_enabled || !s.notify_webhook_url) return;

  const a = analyzeRun(run);
  if (a.outcome === 'passed') { ws.passedTargets.push({ piece: plan.piece_name, action: plan.target_action }); return; }
  if (a.category === 'quota') {
    ws.quotaPieces.add(plan.piece_name);
    if (!deps.isQuarantined(plan.piece_name, plan.target_action)) await raiseAccountAlert(run, plan, wave, a.error, s.notify_webhook_url, deps);
    return;
  }
  if (ENV_NOISE.has(a.category)) return;                 // connection/env noise → no piece ping
  if (!PIECE_IMPLICATING.has(a.category)) return;
  if (deps.isQuarantined(plan.piece_name, plan.target_action)) return;

  ws.failures++;
  if (ws.failures > s.notify_storm_threshold) { ws.suppressed++; return; }  // circuit breaker

  const sig = errorSignature(a.category, a.error);
  const existing = deps.getOpenAlert(plan.piece_name, plan.target_action);

  // Dedup only once the alert has actually been DELIVERED (has a message_id). An
  // alert whose initial post failed is left message-less on purpose so a later wave
  // re-raises it rather than silently swallowing the bug.
  if (existing && existing.error_signature === sig && existing.discord_message_id) {
    const bumped = deps.updateAlert(existing.id, { fail_count: (existing.fail_count ?? 1) + 1, last_seen_at: new Date().toISOString(), last_run_id: run.id, last_wave_id: wave.wave_id ?? null, error_message: a.error });
    // Relabel a still-open confirmed bug as chronic with its running fire count (silent edit, no new ping).
    if (bumped && bumped.status === 'confirmed' && existing.discord_message_id) {
      try { await deps.edit(s.notify_webhook_url, existing.discord_message_id, alertEmbed(bumped, { appBaseUrl: deps.appBaseUrl, failCount: bumped.fail_count })); }
      catch (err) { console.error(`[alerts] chronic relabel edit failed for ${plan.piece_name}/${plan.target_action ?? ''}:`, err); }
    }
    return; // dedup — already alerted for this exact failure
  }

  // New target failure, the error changed, or a prior post failed → raise a fresh alert.
  let alert: AlertRow;
  if (existing) {
    alert = deps.updateAlert(existing.id, { status: 'verifying', error_signature: sig, error_category: a.category, error_message: a.error, discord_message_id: null, acknowledged_at: null, acknowledged_by: null, last_run_id: run.id, last_wave_id: wave.wave_id ?? null })!;
  } else {
    alert = deps.createAlert({ piece_name: plan.piece_name, target_action: plan.target_action, target_type: plan.target_type ?? null, error_signature: sig, error_category: a.category, error_message: a.error, last_run_id: run.id, last_wave_id: wave.wave_id ?? null, schedule_id: wave.schedule_id ?? null });
  }

  // Deliver: eager "verifying" post → inline retest → self-edit. A Discord/executor
  // hiccup here must not abort the wave; log and move on. A failed post leaves the
  // alert un-delivered (no message_id) so the dedup guard above retries it next wave.
  try {
    const posted = await deps.post(s.notify_webhook_url, alertEmbed({ ...alert, status: 'verifying' }, { appBaseUrl: deps.appBaseUrl }));
    alert = deps.updateAlert(alert.id, { discord_message_id: posted.id })!;

    const rt = await deps.retest(plan.id, s.notify_retest_count);
    if (rt.failed === 0 && rt.passed > 0) {
      const recovered = deps.recoverAlert(alert.id)!;
      await deps.edit(s.notify_webhook_url, posted.id, alertEmbed({ ...recovered, status: 'recovered' }, { appBaseUrl: deps.appBaseUrl, recoveredNote: 'Recovered on retest — looks flaky' }));
    } else {
      const reproduced = rt.failed > 0 ? 1 + rt.failed : undefined; // undefined ⇒ "unverified retest" wording
      const confirmed = deps.updateAlert(alert.id, { status: 'confirmed', confirmed_at: new Date().toISOString() })!;
      await deps.edit(s.notify_webhook_url, posted.id, alertEmbed({ ...confirmed, status: 'confirmed' }, { appBaseUrl: deps.appBaseUrl, reproduced }));
    }
  } catch (err) {
    console.error(`[alerts] delivery failed for ${plan.piece_name}/${plan.target_action ?? ''}:`, err);
  }
}

export async function finalizeWaveAlerts(wave: { wave_id?: string; schedule_id?: number }, ws: WaveState, deps: AlertDeps): Promise<void> {
  const s = deps.getSettings();
  if (!s.notify_enabled || !s.notify_webhook_url) return;

  // Recovery: any open alert whose target passed this wave → recover + edit green.
  const passed = new Set(ws.passedTargets.map(t => `${t.piece}::${t.action ?? ''}`));
  for (const alert of deps.listOpenAlerts()) {
    if (!passed.has(`${alert.piece_name}::${alert.target_action ?? ''}`)) continue;
    const isAccount = alert.target_type === ACCOUNT;
    if (isAccount && ws.quotaPieces.has(alert.piece_name)) continue; // another action is still out of credits
    const recovered = deps.recoverAlert(alert.id)!;
    if (isAccount && alert.discord_message_id) {
      const days = daysSince(alert.first_seen_at);
      try {
        await deps.post(s.notify_webhook_url, accountEmbed({ ...recovered, status: 'recovered' }, { appBaseUrl: deps.appBaseUrl, recoveredNote: `Tests are running again${days != null ? ` after ${days} day${days === 1 ? '' : 's'}` : ''}` }));
      } catch (err) {
        console.error(`[alerts] credits-restored notice failed for ${alert.piece_name}:`, err);
      }
    } else if (alert.discord_message_id) {
      const days = daysSince(alert.first_seen_at);
      try {
        await deps.edit(s.notify_webhook_url, alert.discord_message_id, alertEmbed({ ...recovered, status: 'recovered' }, { appBaseUrl: deps.appBaseUrl, recoveredNote: `Recovered${days != null ? ` after ${days} day${days === 1 ? '' : 's'}` : ''}` }));
      } catch (err) {
        console.error(`[alerts] recovery edit failed for ${alert.piece_name}/${alert.target_action ?? ''}:`, err);
      }
    }
  }

  // Storm: if failures were suppressed, post one outage summary.
  if (ws.suppressed > 0) {
    await deps.post(s.notify_webhook_url, stormEmbed({ failing: ws.failures, suppressed: ws.suppressed, appBaseUrl: deps.appBaseUrl }));
  }
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso); if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

export function realAlertDeps(): AlertDeps {
  return {
    getSettings: () => { const s = getSettings(); return { notify_webhook_url: s.notify_webhook_url, notify_enabled: s.notify_enabled, notify_storm_threshold: s.notify_storm_threshold, notify_retest_count: s.notify_retest_count }; },
    isQuarantined: (piece, action) => listQuarantine().some(q => q.piece_name === piece && (q.action_name == null || q.action_name === action)),
    getOpenAlert, createAlert, updateAlert, recoverAlert, listOpenAlerts,
    post: (wh, m) => postDiscordMessage(wh, m),
    edit: (wh, id, m) => editDiscordMessage(wh, id, m),
    retest: (planId, times) => retestTarget(planId, times),
    appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:5173',
  };
}

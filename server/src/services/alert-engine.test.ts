import { describe, it, expect } from 'vitest';
import { analyzeRun, retestTarget, PIECE_IMPLICATING, newWaveState, processRunAlert, finalizeWaveAlerts, type AlertDeps } from './alert-engine.js';

function run(status: string, steps: any[]): any { return { id: 1, status, step_results: JSON.stringify(steps) }; }

describe('analyzeRun', () => {
  it('reclassifies a stored piece_error as quota from the error text', () => {
    const r = analyzeRun(run('failed', [{ status: 'failed', error: 'Request failed with status code 402: no remaining credits', errorCategory: 'piece_error' }]));
    expect(r.category).toBe('quota');
    expect(PIECE_IMPLICATING.has(r.category)).toBe(false);
  });
  it('reports a thrown piece_error failure', () => {
    const r = analyzeRun(run('failed', [{ status: 'completed' }, { status: 'failed', error: 'boom', errorCategory: 'piece_error' }]));
    expect(r.outcome).toBe('failed');
    expect(r.category).toBe('piece_error');
    expect(r.error).toBe('boom');
  });
  it('reports assert_failed', () => {
    const r = analyzeRun(run('failed', [{ status: 'assert_failed', error: 'expected 200' }]));
    expect(r.category).toBe('assert_failed');
  });
  it('reports a clean pass', () => {
    const r = analyzeRun(run('completed', [{ status: 'completed' }]));
    expect(r.outcome).toBe('passed');
  });
  it('marks auth as env-noise (not piece-implicating)', () => {
    const r = analyzeRun(run('failed', [{ status: 'failed', error: '401', errorCategory: 'auth' }]));
    expect(PIECE_IMPLICATING.has(r.category)).toBe(false);
  });
  it('treats piece_error/assert_failed/bad_request/not_found as piece-implicating', () => {
    for (const c of ['piece_error', 'assert_failed', 'bad_request', 'not_found']) expect(PIECE_IMPLICATING.has(c)).toBe(true);
  });
  it('falls back safely on malformed step_results', () => {
    const r = analyzeRun({ status: 'failed', step_results: 'not json' } as any);
    expect(r.outcome).toBe('failed');
    expect(r.category).toBe('unknown');
  });
  it('treats a blocked run (connection/stale) as non-piece-implicating even if a step looks failed', () => {
    const r = analyzeRun({ status: 'blocked', step_results: JSON.stringify([{ status: 'failed', error: 'connection broken', errorCategory: 'piece_error' }]) } as any);
    expect(r.category).toBe('blocked');
    expect(PIECE_IMPLICATING.has(r.category)).toBe(false);
  });
});

describe('retestTarget', () => {
  function execReturning(runs: any[]) { let i = 0; return async () => runs[i++]; }

  it('counts reproduced piece failures as failed', async () => {
    const exec = execReturning([run('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), run('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }])]);
    const r = await retestTarget(9, 2, exec as any);
    expect(r).toEqual({ failed: 2, passed: 0, inconclusive: 0 });
  });
  it('counts a clean pass as passed', async () => {
    const r = await retestTarget(9, 1, execReturning([run('completed', [{ status: 'completed' }])]) as any);
    expect(r.passed).toBe(1);
  });
  it('counts an env-noise retest (auth) as inconclusive, never as passed (never swallow)', async () => {
    const r = await retestTarget(9, 1, execReturning([run('failed', [{ status: 'failed', error: '401', errorCategory: 'auth' }])]) as any);
    expect(r).toEqual({ failed: 0, passed: 0, inconclusive: 1 });
  });
  it('counts an out-of-credits retest as inconclusive, never as passed', async () => {
    const r = await retestTarget(9, 1, execReturning([run('failed', [{ status: 'failed', error: 'You have no remaining credits. Purchase pre-paid credits to continue.' }])]) as any);
    expect(r).toEqual({ failed: 0, passed: 0, inconclusive: 1 });
  });
  it('counts a thrown executor as inconclusive', async () => {
    const exec = async () => { throw new Error('executor down'); };
    const r = await retestTarget(9, 1, exec as any);
    expect(r.inconclusive).toBe(1);
  });
});

function makeDeps(over: Partial<AlertDeps> & { settings?: any } = {}): { deps: AlertDeps; posts: any[]; edits: any[]; store: Map<string, any> } {
  const store = new Map<string, any>();
  const posts: any[] = []; const edits: any[] = [];
  let idSeq = 1;
  const settings = over.settings || { notify_webhook_url: 'https://wh', notify_enabled: 1, notify_storm_threshold: 8, notify_retest_count: 2 };
  const deps: AlertDeps = {
    getSettings: () => settings,
    isQuarantined: () => false,
    getOpenAlert: (p, a) => [...store.values()].find(x => x.piece_name === p && x.target_action === a && !x.recovered_at),
    createAlert: (x) => { const row = { id: idSeq++, status: 'verifying', fail_count: 1, recovered_at: null, first_seen_at: '2026-09-11T09:00:00.000Z', ...x } as any; store.set(String(row.id), row); return row; },
    updateAlert: (id, u) => { const row = { ...store.get(String(id)), ...u }; store.set(String(id), row); return row; },
    recoverAlert: (id) => { const row = { ...store.get(String(id)), status: 'recovered', recovered_at: 'now' }; store.set(String(id), row); return row; },
    listOpenAlerts: () => [...store.values()].filter(x => !x.recovered_at),
    post: async (_wh, _m) => { posts.push(_m); return { id: 'M' + posts.length }; },
    edit: async (_wh, id, m) => { edits.push({ id, m }); },
    retest: async () => ({ failed: 2, passed: 0, inconclusive: 0 }),
    appBaseUrl: 'https://app.test',
    ...over,
  };
  return { deps, posts, edits, store };
}

function schedRun(status: string, steps: any[]): any { return { id: 42, status, step_results: JSON.stringify(steps) }; }
const stripePlan: any = { id: 5, piece_name: '@ap/stripe', target_action: 'create_customer', target_type: 'action' };
const wave = { wave_id: 'w1', schedule_id: 2 };

describe('processRunAlert', () => {
  it('confirms a reproduced piece bug: posts verifying then edits to confirmed', async () => {
    const { deps, posts, edits, store } = makeDeps();
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, ws, deps);
    expect(posts).toHaveLength(1);          // verifying posted
    expect(edits).toHaveLength(1);          // edited to confirmed
    const row = [...store.values()][0];
    expect(row.status).toBe('confirmed');
  });

  it('self-retracts a flake: retest passes → recovered, no lasting open alert', async () => {
    const { deps, edits, store } = makeDeps({ retest: async () => ({ failed: 0, passed: 2, inconclusive: 0 }) });
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'blip', errorCategory: 'piece_error' }]), stripePlan, wave, ws, deps);
    expect([...store.values()][0].status).toBe('recovered');
    expect(edits[edits.length - 1].m.embeds[0].color).toBe(0x57F287); // green
  });

  it('never swallows: all-inconclusive retest still confirms', async () => {
    const { deps, store } = makeDeps({ retest: async () => ({ failed: 0, passed: 0, inconclusive: 2 }) });
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'x', errorCategory: 'piece_error' }]), stripePlan, wave, ws, deps);
    expect([...store.values()][0].status).toBe('confirmed');
  });

  it('does not alert on a blocked run (broken connection / stale plan)', async () => {
    const { deps, posts } = makeDeps();
    await processRunAlert({ id: 7, status: 'blocked', step_results: JSON.stringify([{ status: 'failed', error: 'x', errorCategory: 'piece_error' }]) } as any, stripePlan, wave, newWaveState(), deps);
    expect(posts).toHaveLength(0);
  });

  it('relabels a chronic (repeated) confirmed bug with its fire count', async () => {
    const { deps, edits, store } = makeDeps();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, newWaveState(), deps);
    const editsAfterFirst = edits.length;
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, newWaveState(), deps);
    expect([...store.values()][0].fail_count).toBe(2);
    expect(edits.length).toBeGreaterThan(editsAfterFirst);          // a chronic relabel edit happened
    expect(edits[edits.length - 1].m.embeds[0].description).toContain('chronic');
  });

  it('suppresses an out-of-credits failure — no post', async () => {
    const { deps, posts } = makeDeps();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'You have no remaining credits. Purchase pre-paid credits to continue.', errorCategory: 'piece_error' }]), stripePlan, wave, newWaveState(), deps);
    expect(posts).toHaveLength(0);
  });

  it('suppresses env-noise (auth) — no post', async () => {
    const { deps, posts } = makeDeps();
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: '401', errorCategory: 'auth' }]), stripePlan, wave, ws, deps);
    expect(posts).toHaveLength(0);
  });

  it('dedups a same-signature re-fire: no second post, fail_count bumped', async () => {
    const { deps, posts, store } = makeDeps();
    const ws1 = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, ws1, deps);
    const ws2 = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, ws2, deps);
    expect(posts).toHaveLength(1);
    expect([...store.values()][0].fail_count).toBe(2);
  });

  it('a failed initial post is not swallowed — it retries on the next wave', async () => {
    let postCount = 0;
    const { deps, store } = makeDeps({ post: async (_wh: string, _m: any) => { postCount++; if (postCount === 1) throw new Error('discord down'); return { id: 'M' + postCount }; } });
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, newWaveState(), deps);
    expect([...store.values()][0].discord_message_id).toBeFalsy(); // first post failed, left un-delivered
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, newWaveState(), deps);
    expect(postCount).toBe(2);                                     // re-raised, not deduped away
    const row = [...store.values()][0];
    expect(row.discord_message_id).toBe('M2');
    expect(row.status).toBe('confirmed');
  });

  it('skips quarantined targets', async () => {
    const { deps, posts } = makeDeps({ isQuarantined: () => true });
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, ws, deps);
    expect(posts).toHaveLength(0);
  });

  it('circuit-breaks past the storm threshold', async () => {
    const { deps, posts } = makeDeps({ settings: { notify_webhook_url: 'https://wh', notify_enabled: 1, notify_storm_threshold: 1, notify_retest_count: 0 } });
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'a', errorCategory: 'piece_error' }]), { ...stripePlan, target_action: 'a' }, wave, ws, deps);
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'b', errorCategory: 'piece_error' }]), { ...stripePlan, target_action: 'b' }, wave, ws, deps);
    expect(posts).toHaveLength(1);          // first alerted, second suppressed
    expect(ws.suppressed).toBe(1);
  });
});

describe('finalizeWaveAlerts', () => {
  it('recovers an open alert whose target passed this wave', async () => {
    const { deps, edits, store } = makeDeps();
    store.set('1', { id: 1, piece_name: '@ap/stripe', target_action: 'create_customer', status: 'confirmed', recovered_at: null, first_seen_at: '2026-09-10T09:00:00.000Z', discord_message_id: 'M1' });
    const ws = newWaveState();
    ws.passedTargets.push({ piece: '@ap/stripe', action: 'create_customer' });
    await finalizeWaveAlerts(wave, ws, deps);
    expect(store.get('1').status).toBe('recovered');
    expect(edits[edits.length - 1].m.embeds[0].color).toBe(0x57F287);
  });

  it('posts one storm summary when failures were suppressed', async () => {
    const { deps, posts } = makeDeps();
    const ws = newWaveState(); ws.failures = 9; ws.suppressed = 15;
    await finalizeWaveAlerts(wave, ws, deps);
    expect(posts).toHaveLength(1);
    expect(posts[0].embeds[0].title).toContain('9');
  });
});

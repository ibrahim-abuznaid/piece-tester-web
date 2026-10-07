import {
  listWatchedPieceNames, stalePieces, upsertPieceUsage, type PieceUsageInput,
} from '../../db/vendor-watch-queries.js';
import { runWithConcurrency } from '../concurrency.js';

const CLOUD_API = 'https://cloud.activepieces.com/api/v1';
const VERSION_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 20_000;
export const USAGE_MAX_AGE_DAYS = 7;
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

export type FetchJson = (url: string) => Promise<unknown>;
export type UsageScope = 'watched' | 'catalog' | { pieces: string[] };

export interface UsageDeps {
  fetchJson?: FetchJson;
  onProgress?: (doneVersions: number, totalVersions: number) => void;
  retryDelayMs?: number;
  now?: () => number;
}

export interface UsageRefreshState {
  running: boolean;
  scope: 'watched' | 'catalog' | null;
  done: number;
  total: number;
  started_at: string | null;
  finished_at: string | null;
  error: string;
}

export interface UsageRefreshResult {
  pieces: number;
  updated: number;
  versions_failed: number;
}

export class UsageRefreshRunningError extends Error {
  constructor() {
    super('A usage refresh is already running');
    this.name = 'UsageRefreshRunningError';
  }
}

const IDLE: UsageRefreshState = { running: false, scope: null, done: 0, total: 0, started_at: null, finished_at: null, error: '' };
let state: UsageRefreshState = { ...IDLE };
const lastAttempt = new Map<string, number>();

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'piece-tester-vendor-watch' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function cloudVersions(fetchJson: FetchJson): Promise<Map<string, string[]>> {
  const flags = await fetchJson(`${CLOUD_API}/flags`) as { CURRENT_VERSION?: unknown } | null;
  const release = flags?.CURRENT_VERSION;
  if (typeof release !== 'string' || !release) throw new Error('Cloud flags have no CURRENT_VERSION');
  const registry = await fetchJson(`${CLOUD_API}/pieces/registry?release=${encodeURIComponent(release)}&edition=cloud`);
  if (!Array.isArray(registry)) throw new Error('Cloud piece registry did not return a list');
  if (registry.length === 0) throw new Error(`Cloud piece registry is empty for release ${release}`);
  const byName = new Map<string, string[]>();
  for (const row of registry as Array<{ name?: unknown; version?: unknown }>) {
    if (typeof row?.name !== 'string' || typeof row.version !== 'string') continue;
    const list = byName.get(row.name) ?? [];
    list.push(row.version);
    byName.set(row.name, list);
  }
  return byName;
}

/**
 * Real Cloud usage: `projectUsage` summed over every Cloud version of each piece. The catalog's own number only
 * counts the latest version, so pieces the team bumps often look unused. A project on two versions counts twice.
 */
export async function fetchCloudUsage(names: string[] | 'all', deps: UsageDeps = {}): Promise<PieceUsageInput[]> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const retryDelayMs = deps.retryDelayMs ?? 1000;
  const versions = await cloudVersions(fetchJson);
  const targets = names === 'all' ? [...versions.keys()] : [...new Set(names)];
  const rows = new Map<string, PieceUsageInput>(targets.map(n => [n, {
    piece_name: n, projects: 0, versions: versions.get(n)?.length ?? 0, versions_failed: 0,
  }]));
  const jobs = targets.flatMap(n => (versions.get(n) ?? []).map(v => ({ name: n, version: v })));
  let done = 0;

  const usageOf = async (name: string, version: string): Promise<number> => {
    const url = `${CLOUD_API}/pieces/${encodeURIComponent(name)}?version=${encodeURIComponent(version)}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const body = await fetchJson(url) as { projectUsage?: unknown } | null;
        if (typeof body?.projectUsage !== 'number') throw new Error(`no projectUsage for ${name}@${version}`);
        return body.projectUsage;
      } catch (err) {
        if (attempt >= 2) throw err;
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  };

  await runWithConcurrency(jobs, VERSION_CONCURRENCY, async ({ name, version }) => {
    const row = rows.get(name)!;
    try {
      const projects = await usageOf(name, version);
      row.projects += projects;
    } catch {
      row.versions_failed++;
    }
    deps.onProgress?.(++done, jobs.length);
  });
  return targets.map(n => rows.get(n)!);
}

export function getUsageRefreshState(): UsageRefreshState {
  return { ...state };
}

/**
 * Fetch Cloud usage for a scope and store it. One refresh at a time. A piece whose versions all failed keeps its
 * old row; if the registry can't be read nothing is written.
 */
export async function refreshPieceUsage(scope: UsageScope, deps: UsageDeps = {}): Promise<UsageRefreshResult> {
  if (state.running) throw new UsageRefreshRunningError();
  const label = scope === 'catalog' ? 'catalog' : 'watched';
  state = { ...IDLE, running: true, scope: label, started_at: new Date().toISOString() };
  try {
    const names = scope === 'catalog' ? 'all' : scope === 'watched' ? listWatchedPieceNames() : scope.pieces;
    const rows = await fetchCloudUsage(names, {
      ...deps,
      onProgress: (done, total) => { state.done = done; state.total = total; deps.onProgress?.(done, total); },
    });
    const usable = rows.filter(r => r.versions === 0 || r.versions_failed < r.versions);
    upsertPieceUsage(usable);
    const versionsFailed = rows.reduce((n, r) => n + r.versions_failed, 0);
    console.log(`[vendor-watch] usage refresh (${label}): ${usable.length}/${rows.length} pieces updated, ${versionsFailed} version(s) failed`);
    return { pieces: rows.length, updated: usable.length, versions_failed: versionsFailed };
  } catch (err: any) {
    state.error = err?.message || String(err);
    throw err;
  } finally {
    state.running = false;
    state.finished_at = new Date().toISOString();
  }
}

/**
 * Start a background refresh for watched pieces whose usage is missing, older than a week, or partial and a day old.
 * A piece is not retried within an hour of the last attempt. Returns whether a refresh started.
 */
export function ensureWatchedUsage(deps: UsageDeps = {}): boolean {
  if (state.running) return false;
  const now = (deps.now ?? Date.now)();
  const due = stalePieces(listWatchedPieceNames(), USAGE_MAX_AGE_DAYS)
    .filter(n => now - (lastAttempt.get(n) ?? -Infinity) >= RETRY_AFTER_FAILURE_MS);
  if (due.length === 0) return false;
  for (const n of due) lastAttempt.set(n, now);
  refreshPieceUsage({ pieces: due }, deps)
    .catch(err => console.warn(`[vendor-watch] usage refresh failed: ${err?.message || err}`));
  return true;
}

/** Tests only. */
export function _resetUsageRefresh(): void {
  state = { ...IDLE };
  lastAttempt.clear();
}

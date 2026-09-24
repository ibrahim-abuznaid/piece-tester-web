import type { TrackedBugsResult } from './linear-client.js';

export const BUG_CACHE_TTL_MS = 15 * 60_000;

export interface BugFetchInput { apiKey: string; rosterIds: string[] }

export interface CachedBugs extends TrackedBugsResult {
  fetchedAt: string;
  warnings: string[];
}

export interface BugCache {
  get(input: BugFetchInput & { refresh?: boolean }): Promise<CachedBugs>;
  invalidate(): void;
}

/** Holds the raw Linear result, not the built trend: building is cheap and depends on `from`. */
export function createBugCache(deps: {
  fetch: (input: BugFetchInput) => Promise<TrackedBugsResult>;
  now: () => number;
  ttlMs?: number;
}): BugCache {
  const ttl = deps.ttlMs ?? BUG_CACHE_TTL_MS;
  let entry: { key: string; at: number; result: TrackedBugsResult } | null = null;
  const keyOf = (i: BugFetchInput) => `${i.apiKey}|${[...i.rosterIds].sort().join(',')}`;
  const view = (e: { at: number; result: TrackedBugsResult }, warnings: string[]): CachedBugs =>
    ({ ...e.result, fetchedAt: new Date(e.at).toISOString(), warnings });

  return {
    async get(input) {
      const key = keyOf(input);
      if (!input.refresh && entry && entry.key === key && deps.now() - entry.at < ttl) return view(entry, []);
      try {
        const result = await deps.fetch({ apiKey: input.apiKey, rosterIds: input.rosterIds });
        entry = { key, at: deps.now(), result };
        return view(entry, []);
      } catch (err) {
        if (!entry || entry.key !== key) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        const hhmm = new Date(entry.at).toISOString().slice(11, 16);
        return view(entry, [`Couldn't reach Linear (${msg}). Showing data from ${hhmm} UTC.`]);
      }
    },
    invalidate() {
      entry = null;
    },
  };
}

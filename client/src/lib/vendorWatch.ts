import type {
  VwFindingKind, VwImportanceFields, VwImportanceFilter, VwPlan, VwPlanStatus, VwSeverity, VwSource,
} from './api';

export const KIND_LABEL: Record<VwFindingKind, string> = {
  vendor_dead: 'Vendor dead',
  breaking: 'Breaking',
  deprecation: 'Deprecation',
  auth_change: 'Auth change',
  new_feature: 'New feature',
  other: 'Other',
};

export const SEVERITY_CLASS: Record<VwSeverity, string> = {
  critical: 'bg-red-500/15 text-red-300 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-200 border-yellow-500/30',
  low: 'bg-gray-700/40 text-gray-300 border-gray-600/40',
};

export const PLAN_STATUS_CLASS: Record<VwPlanStatus, string> = {
  queued: 'bg-gray-800 text-gray-400',
  generating: 'bg-blue-500/15 text-blue-300',
  active: 'bg-green-500/15 text-green-300',
  paused: 'bg-gray-700/50 text-gray-300',
  stale: 'bg-amber-500/15 text-amber-300',
  failed: 'bg-red-500/15 text-red-300',
};

/** Linear priority numbers. */
export const PRIORITY_LABEL: Record<number, string> = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

export function shortPieceName(name: string): string {
  return name.replace('@activepieces/piece-', '');
}

export function parseJsonArray<T = string>(s: string | null | undefined): T[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function describeTargets(json: string): string {
  const t = parseJsonArray(json);
  if (t.includes('*')) return 'whole piece';
  return t.length ? t.join(', ') : '—';
}

/** A liveness timeout only notes last_error without counting a failure, so a noted error also reads as failing. */
export function sourceHealth(s: Pick<VwSource, 'last_checked_at' | 'consecutive_failures' | 'last_error'>): 'never' | 'ok' | 'failing' {
  if (!s.last_checked_at) return 'never';
  return s.consecutive_failures > 0 || s.last_error ? 'failing' : 'ok';
}

export function effectiveLabel(date: string | null, today = new Date()): string {
  if (!date) return '—';
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const d = Math.round((Date.parse(`${date}T00:00:00Z`) - start) / 86_400_000);
  if (d === 0) return `${date} (today)`;
  return d > 0 ? `${date} (in ${d}d)` : `${date} (${-d}d ago)`;
}

export const IMPORTANCE_FILTERS: VwImportanceFilter[] = ['high', 'medium', 'low', 'unrated'];

export const IMPORTANCE_LABEL: Record<VwImportanceFilter, string> = { high: 'High', medium: 'Medium', low: 'Low', unrated: 'Unrated' };

/** Badge and active-chip colors. Deliberately not the severity palette: piece importance is not change severity. */
export const IMPORTANCE_CLASS: Record<VwImportanceFilter, string> = {
  high: 'bg-violet-500/15 text-violet-200 border-violet-500/35',
  medium: 'bg-sky-500/10 text-sky-200 border-sky-500/30',
  low: 'bg-gray-800/70 text-gray-300 border-gray-600/50',
  unrated: 'bg-gray-900 text-gray-400 border-gray-700',
};

/** `?importance=low,high` → ['high', 'low']: known tiers only, in canonical order. */
export function parseImportanceParam(v: string | null): VwImportanceFilter[] {
  const asked = new Set((v ?? '').split(',').map(s => s.trim()));
  return IMPORTANCE_FILTERS.filter(t => asked.has(t));
}

export function toggleImportance(current: VwImportanceFilter[], tier: VwImportanceFilter): VwImportanceFilter[] {
  const next = new Set(current);
  if (next.has(tier)) next.delete(tier);
  else next.add(tier);
  return IMPORTANCE_FILTERS.filter(t => next.has(t));
}

/** An empty filter matches every row. */
export function matchesImportance(row: Pick<VwImportanceFields, 'importance'>, filter: VwImportanceFilter[]): boolean {
  return filter.length === 0 || filter.includes(row.importance ?? 'unrated');
}

export function countByImportance(rows: Array<Pick<VwImportanceFields, 'importance'>>): Record<VwImportanceFilter, number> {
  const counts: Record<VwImportanceFilter, number> = { high: 0, medium: 0, low: 0, unrated: 0 };
  for (const r of rows) counts[r.importance ?? 'unrated']++;
  return counts;
}

const TIER_RANK: Record<VwImportanceFilter, number> = { high: 0, medium: 1, unrated: 2, low: 3 };

/** Sort comparator: tier (unrated above low, like the server), then Cloud projects, most first. */
export function compareImportance(a: VwImportanceFields, b: VwImportanceFields): number {
  const tier = TIER_RANK[a.importance ?? 'unrated'] - TIER_RANK[b.importance ?? 'unrated'];
  return tier || (b.usage_projects ?? -1) - (a.usage_projects ?? -1);
}

export function importanceTitle(f: VwImportanceFields): string {
  if (!f.importance) return 'Not rated yet: Cloud usage for this piece has not been fetched';
  const parts = [`${IMPORTANCE_LABEL[f.importance]} importance`];
  if (f.usage_projects !== null) {
    parts.push(`${f.usage_projects.toLocaleString('en-US')} Cloud project${f.usage_projects === 1 ? '' : 's'} across all versions`);
  }
  if (f.enterprise) parts.push('on the Enterprise list');
  parts.push(f.usage_fetched_at ? `usage from ${f.usage_fetched_at.slice(0, 10)}` : 'no Cloud usage fetched yet');
  return parts.join(' · ');
}

/** A typed piece ("Google Sheets", "zoho-crm", "@activepieces/piece-x") → its package name, or null. */
export function toPieceName(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(t)) return t;
  const slug = t.replace(/\s+/g, '-').replace(/^piece-/, '');
  return /^[a-z0-9][a-z0-9._-]*$/.test(slug) ? `@activepieces/piece-${slug}` : null;
}

/** The keys of `next` whose values differ from `base`: save only what the user edited. */
export function changedFields<T extends object>(base: T, next: T): Partial<T> {
  return Object.fromEntries(
    (Object.keys(next) as Array<keyof T>).filter(k => next[k] !== base[k]).map(k => [k, next[k]]),
  ) as Partial<T>;
}


/** A failed plan doesn't count, so its piece can be picked again. */
export function watchedPieceNames(plans: Array<Pick<VwPlan, 'piece_name' | 'status'>>): Set<string> {
  return new Set(plans.filter(p => p.status !== 'failed').map(p => p.piece_name));
}

/** The `n` most used pieces on Cloud that aren't watched yet. Core pieces (Webhook, HTTP, Code…) have no vendor to watch. */
export function pickTopByUsage(
  pieces: Array<{ name: string; categories?: string[]; usage_projects: number | null }>,
  n: number,
  watched: Set<string>,
): string[] {
  return pieces
    .filter((p): p is typeof p & { usage_projects: number } =>
      p.usage_projects !== null && !p.categories?.includes('CORE') && !watched.has(p.name))
    .sort((a, b) => b.usage_projects - a.usage_projects || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, n))
    .map(p => p.name);
}

export function pickEnterprise(pieces: Array<{ name: string; enterprise: number }>, watched: Set<string>): string[] {
  return pieces.filter(p => p.enterprise && !watched.has(p.name)).map(p => p.name);
}

/** `current` plus the new names from `add`, in order, until the list holds `max`. */
export function addUpTo(current: string[], add: string[], max: number): string[] {
  const out = [...current];
  const seen = new Set(current);
  for (const name of add) {
    if (out.length >= max) break;
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

const EST_USD_PER_WATCHER = 0.35;
const EST_MINUTES_PER_WATCHER = 1.5;

/** "230 selected · about $81 · runs one at a time, about 6 h"; cents under $10, minutes under an hour. */
export function generationEstimate(n: number): string {
  if (n === 0) return '0 selected';
  const usd = n * EST_USD_PER_WATCHER;
  const minutes = n * EST_MINUTES_PER_WATCHER;
  const time = minutes < 60 ? `${Math.ceil(minutes)} min` : `${Math.ceil(minutes / 60)} h`;
  return `${n} selected · about $${usd.toFixed(usd < 10 ? 2 : 0)} · runs one at a time, about ${time}`;
}

/** A pasted list (one per line, or comma/semicolon separated) → catalog names, plus the entries the catalog doesn't have, as typed. */
export function parsePieceList(text: string, knownNames: Set<string>): { names: string[]; unknown: string[] } {
  const names: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const entry of text.split(/[\n,;]/).map(s => s.trim()).filter(Boolean)) {
    const name = entry.startsWith('@') || entry.includes('/')
      ? entry
      : `@activepieces/piece-${entry.toLowerCase().replace(/\s+/g, '-').replace(/^piece-/, '')}`;
    if (seen.has(name)) continue;
    seen.add(name);
    if (knownNames.has(name)) names.push(name);
    else unknown.push(entry);
  }
  return { names, unknown };
}

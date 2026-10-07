import type {
  VwFindingKind, VwImportanceFields, VwImportanceFilter, VwPlanStatus, VwSeverity, VwSource,
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

/** Where a page of `count` rows sits in the list: the 1-based range shown and the Previous / Next offsets (null at the ends). */
export function pageInfo(page: { offset: number; limit: number; total: number }, count: number) {
  return {
    from: count ? page.offset + 1 : 0,
    to: page.offset + count,
    prevOffset: page.offset > 0 ? Math.max(0, page.offset - page.limit) : null,
    nextOffset: page.offset + page.limit < page.total ? page.offset + page.limit : null,
  };
}

/** An offset at or past the end (its last rows were dismissed or filed) → the last page that still has rows. */
export function clampOffset(offset: number, total: number, limit: number): number {
  if (offset < total) return offset;
  return total > 0 ? Math.floor((total - 1) / limit) * limit : 0;
}

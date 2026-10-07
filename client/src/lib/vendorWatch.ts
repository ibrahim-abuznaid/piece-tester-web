import type { VwFindingKind, VwPlanStatus, VwSeverity, VwSource } from './api';

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

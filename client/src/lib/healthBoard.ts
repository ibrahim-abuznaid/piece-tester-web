import type { AttentionItem } from './api';

export type ColumnKey = 'piece' | 'connection' | 'test' | 'reported' | 'muted';

export const COLUMNS: { key: ColumnKey; label: string; hint: string }[] = [
  { key: 'piece', label: 'Piece bug', hint: 'the piece code errored — report or fix' },
  { key: 'connection', label: 'Connection', hint: 'auth / connection — re-auth or re-import' },
  { key: 'test', label: 'Test · needs a look', hint: 'inputs, assertions, or unclear' },
  { key: 'reported', label: 'Reported', hint: 'handed off to the piece team' },
  { key: 'muted', label: 'Muted', hint: 'quarantined or transient noise' },
];

/**
 * Which column a failing (piece, action) belongs to. Precedence:
 * Muted (deliberately parked) > Reported (handed off) > fix-owner by signal.
 */
export function assignColumn(item: AttentionItem, reportedPieces: Set<string>): ColumnKey {
  if (item.quarantined || item.bucket === 'noise') return 'muted';
  if (reportedPieces.has(item.piece_name)) return 'reported';
  if (item.bucket === 'reauth' || item.category === 'auth' || item.category === 'connection_broken') return 'connection';
  if (item.category === 'piece_error') return 'piece';
  return 'test'; // bad_request, not_found, assert_failed, unknown, and any fallthrough
}

/** A high-confidence breakage: failed 2x+ in a row and not flaky. */
export function isConfirmed(item: AttentionItem): boolean {
  return item.fail_streak >= 2 && !item.flaky;
}

/** Confirmed items first, then by fail-streak descending. */
export function sortByConfidence(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const ca = isConfirmed(a) ? 0 : 1;
    const cb = isConfirmed(b) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return b.fail_streak - a.fail_streak;
  });
}

export function groupByColumn(items: AttentionItem[], reportedPieces: Set<string>): Record<ColumnKey, AttentionItem[]> {
  const out: Record<ColumnKey, AttentionItem[]> = { piece: [], connection: [], test: [], reported: [], muted: [] };
  for (const it of items) out[assignColumn(it, reportedPieces)].push(it);
  (Object.keys(out) as ColumnKey[]).forEach(k => { out[k] = sortByConfidence(out[k]); });
  return out;
}

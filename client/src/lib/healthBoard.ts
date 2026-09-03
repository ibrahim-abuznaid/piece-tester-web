import type { AttentionItem } from './api';

export type ColumnKey = 'errors' | 'connection' | 'reported' | 'muted';

export const COLUMNS: { key: ColumnKey; label: string; hint: string }[] = [
  { key: 'errors', label: 'Errors', hint: 'piece or test failures — report to the piece team' },
  { key: 'connection', label: 'Connection', hint: 'auth / connection — re-auth or re-import' },
  { key: 'reported', label: 'Reported', hint: 'handed off to the piece team' },
  { key: 'muted', label: 'Muted', hint: 'quarantined or transient noise' },
];

/** All the failing actions of one piece, collapsed into a single board card. */
export interface PieceGroup {
  piece_name: string;
  items: AttentionItem[];   // the piece's failing actions, sorted by confidence
  lane: ColumnKey;          // the single lane the piece sits in
  confirmed: boolean;       // true if any action is a confirmed breakage
}

/**
 * Which lane a single failing action belongs to, ignoring the piece-level
 * "reported" state: muted (parked) > connection (your-side auth) > error.
 */
function itemKind(item: AttentionItem): 'muted' | 'connection' | 'error' {
  if (item.quarantined || item.bucket === 'noise') return 'muted';
  if (item.bucket === 'reauth' || item.category === 'auth' || item.category === 'connection_broken') return 'connection';
  return 'error';
}

/**
 * Which column a failing (piece, action) belongs to. Precedence:
 * Muted (deliberately parked) > Reported (handed off) > Connection > Errors.
 * Everything that isn't a connection/noise/reported case is a reportable error.
 */
export function assignColumn(item: AttentionItem, reportedPieces: Set<string>): ColumnKey {
  if (item.quarantined || item.bucket === 'noise') return 'muted';
  if (reportedPieces.has(item.piece_name)) return 'reported';
  if (item.bucket === 'reauth' || item.category === 'auth' || item.category === 'connection_broken') return 'connection';
  return 'errors'; // piece_error, bad_request, not_found, assert_failed, unknown, and any fallthrough
}

/**
 * The single lane a whole piece sits in. Reported and Muted are terminal — they
 * win over the active lanes so a handled piece doesn't re-clutter Errors. Muted
 * requires ALL of the piece's failing actions to be muted; a live error wins.
 * Among active issues, Errors beats Connection.
 */
export function assignPieceColumn(items: AttentionItem[], reportedPieces: Set<string>): ColumnKey {
  if (items.length === 0) return 'errors';
  const kinds = items.map(itemKind);
  if (kinds.every(k => k === 'muted')) return 'muted';
  if (reportedPieces.has(items[0].piece_name)) return 'reported';
  return kinds.some(k => k === 'error') ? 'errors' : 'connection';
}

/** Per-kind counts across a piece's failing actions — drives the card summary. */
export function pieceKindCounts(items: AttentionItem[]): { error: number; connection: number; muted: number } {
  const counts = { error: 0, connection: 0, muted: 0 };
  for (const it of items) counts[itemKind(it)]++;
  return counts;
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

function worstFailStreak(items: AttentionItem[]): number {
  return items.reduce((max, it) => Math.max(max, it.fail_streak), 0);
}

/** One PieceGroup per piece, its actions sorted by confidence. */
export function groupByPiece(items: AttentionItem[], reportedPieces: Set<string>): PieceGroup[] {
  const byPiece = new Map<string, AttentionItem[]>();
  for (const it of items) {
    if (!byPiece.has(it.piece_name)) byPiece.set(it.piece_name, []);
    byPiece.get(it.piece_name)!.push(it);
  }
  const groups: PieceGroup[] = [];
  for (const [piece_name, its] of byPiece) {
    groups.push({
      piece_name,
      items: sortByConfidence(its),
      lane: assignPieceColumn(its, reportedPieces),
      confirmed: its.some(isConfirmed),
    });
  }
  return groups;
}

/** Confirmed pieces first, then by worst fail-streak descending, then name. */
export function sortPieceGroups(groups: PieceGroup[]): PieceGroup[] {
  return [...groups].sort((a, b) => {
    if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
    const fa = worstFailStreak(a.items);
    const fb = worstFailStreak(b.items);
    if (fa !== fb) return fb - fa;
    return a.piece_name.localeCompare(b.piece_name);
  });
}

/** Group failing actions into piece cards, bucketed into the four lanes. */
export function groupPiecesByColumn(items: AttentionItem[], reportedPieces: Set<string>): Record<ColumnKey, PieceGroup[]> {
  const out: Record<ColumnKey, PieceGroup[]> = { errors: [], connection: [], reported: [], muted: [] };
  for (const group of groupByPiece(items, reportedPieces)) out[group.lane].push(group);
  (Object.keys(out) as ColumnKey[]).forEach(k => { out[k] = sortPieceGroups(out[k]); });
  return out;
}

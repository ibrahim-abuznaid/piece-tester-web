import type { CoverageRow } from './api';

export interface SchedulablePiece {
  piece_name: string;
  display_name: string;
}

/**
 * Pieces the Schedules target picker offers: anything that can run on a schedule — connected
 * (a no-auth piece counts as connected) or already holding test plans. Sorted by display name.
 */
export function schedulablePieces(rows: CoverageRow[]): SchedulablePiece[] {
  return rows
    .filter(r => r.connected || r.has_plans)
    .map(r => ({ piece_name: r.piece_name, display_name: r.display_name }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

import type { AppConnection, ActivepiecesClient } from './ap-client.js';
import {
  listConnectionsForPiece, getConnectionByPiece, createConnection,
  activateConnection, markPlansStaleByPiece, type PieceConnectionRow,
} from '../db/queries.js';
import { classify } from './test-connection-matcher.js';

export interface SweepPieceResult {
  pieceName: string;
  outcome: 'linked' | 'already_linked' | 'skipped_none' | 'error';
  importedNames?: string[];
  error?: string;
}
export interface SweepResult {
  linked: SweepPieceResult[];
  alreadyLinked: SweepPieceResult[];
  skippedNone: SweepPieceResult[];
  errored: SweepPieceResult[];
}

/** The remote_id stored on an imported row, or undefined for a non-imported/local row. */
function importedRemoteId(row: PieceConnectionRow): string | undefined {
  try {
    const v = JSON.parse(row.connection_value);
    return v?._imported ? v.remote_id : undefined;
  } catch { return undefined; }
}

/** AP timestamp used to pick the "newest" connection; '' when AP omits it. */
function apTimestamp(c: AppConnection): string {
  return String((c as any).updated ?? (c as any).created ?? '');
}

/** Newest by timestamp; ties or missing timestamps fall back to last in list order. */
function pickNewest(conns: AppConnection[]): AppConnection {
  return conns.reduce((best, c) => (apTimestamp(c) >= apTimestamp(best) ? c : best));
}

/**
 * Fetch the AP connection list once; for each piece import every connection (by pieceName)
 * not already imported, keeping a pre-existing active connection or else activating the newest.
 */
export async function sweepTestConnections(
  client: ActivepiecesClient,
  pieceNames: string[],
): Promise<SweepResult> {
  const remoteList = await client.listConnections();
  const result: SweepResult = { linked: [], alreadyLinked: [], skippedNone: [], errored: [] };

  for (const pieceName of pieceNames) {
    const { status, connections } = classify(pieceName, remoteList);
    if (status === 'none') {
      result.skippedNone.push({ pieceName, outcome: 'skipped_none' });
      continue;
    }

    const existingRemoteIds = new Set(
      listConnectionsForPiece(pieceName).map(importedRemoteId).filter(Boolean) as string[],
    );
    const toImport = connections.filter(c => !existingRemoteIds.has(c.externalId || c.id));
    if (toImport.length === 0) {
      result.alreadyLinked.push({ pieceName, outcome: 'already_linked' });
      continue;
    }

    // Capture the active connection before importing — createConnection flips is_active.
    const preActive = getConnectionByPiece(pieceName);

    try {
      const imported = toImport.map(c => ({
        ap: c,
        row: createConnection({
          piece_name: pieceName,
          display_name: c.displayName,
          connection_type: c.type || 'IMPORTED',
          connection_value: JSON.stringify({ _imported: true, remote_id: c.externalId || c.id }),
        }),
      }));

      if (preActive) {
        // Don't disturb a prior active connection (manual choice or earlier import).
        activateConnection(preActive.id);
      } else {
        const newest = pickNewest(imported.map(i => i.ap));
        const row = imported.find(i => i.ap.id === newest.id)!.row;
        activateConnection(row.id);
      }
      markPlansStaleByPiece(pieceName);
      result.linked.push({
        pieceName, outcome: 'linked',
        importedNames: imported.map(i => i.ap.displayName),
      });
    } catch (err) {
      result.errored.push({
        pieceName, outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

import type { AppConnection, ActivepiecesClient } from './ap-client.js';
import { getConnectionByPiece, type PieceConnectionRow } from '../db/queries.js';
import { classifyImported } from './connection-health.js';
import { classify } from './test-connection-matcher.js';

export interface ConnectionGateResult {
  ok: boolean;
  reason?: string;
}

function parseImported(row: PieceConnectionRow): { remote_id: string } | null {
  try {
    const v = JSON.parse(row.connection_value);
    return v?._imported && v?.remote_id ? { remote_id: String(v.remote_id) } : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a piece has a usable connection to generate a plan against. Pure.
 *
 * A plan is only worth generating if the executor will be able to resolve auth. This
 * mirrors that: an imported local row must still resolve to a live AP connection; a
 * manual local row is usable as-is; with no local row we accept a usable (non-error)
 * live AP connection matched to the piece.
 */
export function evaluateConnectionForPlanning(
  pieceName: string,
  displayName: string,
  localRow: PieceConnectionRow | undefined,
  remoteList: AppConnection[],
): ConnectionGateResult {
  if (localRow) {
    const imported = parseImported(localRow);
    if (imported) {
      const health = classifyImported(imported.remote_id, remoteList);
      if (health.status !== 'live') {
        return { ok: false, reason: `Connection for "${displayName}" is not usable: ${health.detail}.` };
      }
    }
    return { ok: true };
  }

  const { connections } = classify(pieceName, remoteList);
  const usable = connections.some(c => String(c.status).toUpperCase() !== 'ERROR');
  if (!usable) {
    return {
      ok: false,
      reason: `No active connection for "${displayName}" in Activepieces — connect or import it before generating a plan.`,
    };
  }
  return { ok: true };
}

/**
 * Async wrapper: look up the local connection, fetch AP's connection list once, and
 * evaluate. A manual local row short-circuits without an AP call. An AP fetch failure
 * fails OPEN (proceed) — a transient blip must not halt a whole batch; the executor's
 * own connection gate will catch a genuine problem at run time.
 */
export async function checkPieceConnectionForPlanning(
  client: ActivepiecesClient,
  pieceName: string,
  displayName: string,
): Promise<ConnectionGateResult> {
  const localRow = getConnectionByPiece(pieceName);
  if (localRow && !parseImported(localRow)) return { ok: true };

  let remoteList: AppConnection[];
  try {
    remoteList = await client.listConnections();
  } catch {
    return { ok: true };
  }
  return evaluateConnectionForPlanning(pieceName, displayName, localRow, remoteList);
}

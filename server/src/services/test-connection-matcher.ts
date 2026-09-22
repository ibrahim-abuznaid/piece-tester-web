import type { AppConnection } from './ap-client.js';

export type MatchStatus = 'found' | 'none';
export interface MatchResult {
  status: MatchStatus;
  connections: AppConnection[];
}

/**
 * Match by AP pieceName. A remote connection belongs to piece P when its `pieceName`
 * equals P exactly (both sides use the `@activepieces/piece-<slug>` form). Returns every
 * matching connection; `found` when there is at least one, `none` when there are zero.
 */
export function classify(pieceName: string, remoteConns: AppConnection[]): MatchResult {
  const connections = remoteConns.filter(c => c.pieceName === pieceName);
  return { status: connections.length ? 'found' : 'none', connections };
}

import type { AppConnection, ActivepiecesClient } from './ap-client.js';

export type RemoteStatus = 'live' | 'missing' | 'error';
export interface HealthResult { status: RemoteStatus; detail: string; }
export interface ConnectionBacklinks { activepieces: string; reimport: string; }

/**
 * Classify an imported connection against the upstream connection list. Pure.
 * Match rule mirrors resolveConnectionAuthInput: rc.id === remoteId || rc.externalId === remoteId.
 */
export function classifyImported(remoteId: string, remoteList: AppConnection[]): HealthResult {
  const remote = remoteList.find(rc => rc.id === remoteId || rc.externalId === remoteId);
  if (!remote) return { status: 'missing', detail: 'Connection was deleted in Activepieces' };
  if (String(remote.status).toUpperCase() === 'ERROR') {
    return { status: 'error', detail: 'Connection is in an error state in Activepieces — reauthorize it' };
  }
  return { status: 'live', detail: '' };
}

/**
 * Build the two "fix it" backlinks for a broken connection. Pure.
 * baseUrl is settings.base_url (e.g. "https://cloud.activepieces.com/api").
 */
export function buildConnectionBacklinks(baseUrl: string, projectId: string, pieceName: string): ConnectionBacklinks {
  const dashboard = baseUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '');
  return {
    activepieces: `${dashboard}/projects/${projectId}/connections`,
    reimport: `/connections?piece=${encodeURIComponent(pieceName)}`,
  };
}

/**
 * Health of an imported connection given its raw `connection_value` JSON.
 * Returns null when the connection is NOT imported (manual creds live locally and cannot be
 * deleted upstream) or the value is unparseable. Otherwise fetches the upstream list once and
 * classifies. A thrown listConnections() (network / bad creds) PROPAGATES — callers decide;
 * we never treat a fetch failure as 'missing'.
 */
export async function checkImportedConnectionHealth(
  client: ActivepiecesClient,
  connectionValueJson: string,
): Promise<(HealthResult & { remoteId: string }) | null> {
  let parsed: { _imported?: boolean; remote_id?: unknown } | null = null;
  try { parsed = JSON.parse(connectionValueJson); } catch { return null; }
  if (!parsed || !parsed._imported || !parsed.remote_id) return null;
  const remoteId = String(parsed.remote_id);
  const remoteList = await client.listConnections();
  return { remoteId, ...classifyImported(remoteId, remoteList) };
}

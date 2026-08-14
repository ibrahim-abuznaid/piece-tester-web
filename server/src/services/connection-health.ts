import type { AppConnection } from './ap-client.js';

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

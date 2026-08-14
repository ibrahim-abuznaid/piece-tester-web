import { describe, it, expect } from 'vitest';
import { classifyImported, buildConnectionBacklinks } from './connection-health.js';
import type { AppConnection } from './ap-client.js';

function conn(over: Partial<AppConnection>): AppConnection {
  return {
    id: 'id1', pieceName: 'p', displayName: 'd', projectId: 'proj',
    externalId: 'ext1', type: 'OAUTH2', status: 'ACTIVE', ...over,
  };
}

describe('classifyImported', () => {
  it('missing when remoteId is absent from the list', () => {
    expect(classifyImported('gone', [conn({ id: 'id1', externalId: 'ext1' })]).status).toBe('missing');
  });
  it('error when upstream status is ERROR', () => {
    expect(classifyImported('id1', [conn({ id: 'id1', status: 'ERROR' })]).status).toBe('error');
  });
  it('live when present and active', () => {
    expect(classifyImported('id1', [conn({ id: 'id1', status: 'ACTIVE' })]).status).toBe('live');
  });
  it('matches by externalId too', () => {
    expect(classifyImported('ext1', [conn({ id: 'id1', externalId: 'ext1' })]).status).toBe('live');
  });
});

describe('buildConnectionBacklinks', () => {
  it('strips a trailing /api and builds both links', () => {
    const b = buildConnectionBacklinks('https://cloud.activepieces.com/api', 'projX', 'hubspot');
    expect(b.activepieces).toBe('https://cloud.activepieces.com/projects/projX/connections');
    expect(b.reimport).toBe('/connections?piece=hubspot');
  });
  it('works when baseUrl has no /api suffix', () => {
    const b = buildConnectionBacklinks('https://ap.example.com', 'p1', 'slack');
    expect(b.activepieces).toBe('https://ap.example.com/projects/p1/connections');
  });
});

import { checkImportedConnectionHealth } from './connection-health.js';
import type { ActivepiecesClient } from './ap-client.js';

function fakeClient(list: AppConnection[]): ActivepiecesClient {
  return { listConnections: async () => list } as unknown as ActivepiecesClient;
}

describe('checkImportedConnectionHealth', () => {
  it('returns null for a manual (non-imported) connection', async () => {
    const r = await checkImportedConnectionHealth(fakeClient([]), JSON.stringify({ secret_text: 'x' }));
    expect(r).toBeNull();
  });
  it('returns null for unparseable connection_value', async () => {
    expect(await checkImportedConnectionHealth(fakeClient([]), 'not json')).toBeNull();
  });
  it('returns missing (with remoteId) for a deleted imported connection', async () => {
    const r = await checkImportedConnectionHealth(fakeClient([]), JSON.stringify({ _imported: true, remote_id: 'gone' }));
    expect(r?.status).toBe('missing');
    expect(r?.remoteId).toBe('gone');
  });
  it('returns live when the imported connection still exists', async () => {
    const list = [conn({ id: 'id1', status: 'ACTIVE' })];
    const r = await checkImportedConnectionHealth(fakeClient(list), JSON.stringify({ _imported: true, remote_id: 'id1' }));
    expect(r?.status).toBe('live');
  });
});

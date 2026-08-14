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

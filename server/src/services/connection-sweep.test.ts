import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { getConnectionByPiece, listConnectionsForPiece, createConnection } from '../db/queries.js';
import { sweepTestConnections } from './connection-sweep.js';
import type { AppConnection, ActivepiecesClient } from './ap-client.js';

function conn(over: Partial<AppConnection>): AppConnection {
  return {
    id: 'id1', pieceName: '@activepieces/piece-gmail', displayName: 'd', projectId: 'proj',
    externalId: 'ext1', type: 'OAUTH2', status: 'ACTIVE', ...over,
  };
}

function fakeClient(list: AppConnection[]) {
  const box = { calls: 0 };
  const client = {
    listConnections: async () => { box.calls++; return list; },
  } as unknown as ActivepiecesClient;
  return { client, box };
}

describe('sweepTestConnections', () => {
  beforeEach(() => getDb().exec('DELETE FROM piece_connections; DELETE FROM test_plans;'));

  it('imports every connection for a piece and reports their names', async () => {
    const { client } = fakeClient([
      conn({ id: 'r1', externalId: 'ext-a', displayName: 'Gmail A', updated: '2026-01-01T00:00:00Z' }),
      conn({ id: 'r2', externalId: 'ext-b', displayName: 'Gmail B', updated: '2026-02-01T00:00:00Z' }),
    ]);
    const result = await sweepTestConnections(client, ['@activepieces/piece-gmail']);

    expect(result.linked.map(r => r.pieceName)).toEqual(['@activepieces/piece-gmail']);
    expect(result.linked[0].importedNames).toEqual(['Gmail A', 'Gmail B']);
    expect(listConnectionsForPiece('@activepieces/piece-gmail')).toHaveLength(2);
  });

  it('activates the newest connection when the piece had none active', async () => {
    const { client } = fakeClient([
      conn({ id: 'r1', externalId: 'ext-a', displayName: 'Gmail A', updated: '2026-01-01T00:00:00Z' }),
      conn({ id: 'r2', externalId: 'ext-b', displayName: 'Gmail B', updated: '2026-02-01T00:00:00Z' }),
    ]);
    await sweepTestConnections(client, ['@activepieces/piece-gmail']);

    const active = getConnectionByPiece('@activepieces/piece-gmail')!;
    expect(JSON.parse(active.connection_value).remote_id).toBe('ext-b');
  });

  it('is idempotent — a re-sweep imports nothing new and reports already_linked', async () => {
    const list = [
      conn({ id: 'r1', externalId: 'ext-a', displayName: 'Gmail A' }),
      conn({ id: 'r2', externalId: 'ext-b', displayName: 'Gmail B' }),
    ];
    const { client } = fakeClient(list);
    await sweepTestConnections(client, ['@activepieces/piece-gmail']);
    const result = await sweepTestConnections(client, ['@activepieces/piece-gmail']);

    expect(result.linked).toEqual([]);
    expect(result.alreadyLinked.map(r => r.pieceName)).toEqual(['@activepieces/piece-gmail']);
    expect(listConnectionsForPiece('@activepieces/piece-gmail')).toHaveLength(2);
  });

  it('preserves an already-active connection across a re-sweep that adds a new one', async () => {
    createConnection({
      piece_name: '@activepieces/piece-gmail', display_name: 'Gmail A', connection_type: 'IMPORTED',
      connection_value: JSON.stringify({ _imported: true, remote_id: 'ext-a' }),
    });
    const { client } = fakeClient([
      conn({ id: 'r1', externalId: 'ext-a', displayName: 'Gmail A', updated: '2026-01-01T00:00:00Z' }),
      conn({ id: 'r2', externalId: 'ext-b', displayName: 'Gmail B', updated: '2026-02-01T00:00:00Z' }),
    ]);
    const result = await sweepTestConnections(client, ['@activepieces/piece-gmail']);

    expect(result.linked[0].importedNames).toEqual(['Gmail B']);
    const active = getConnectionByPiece('@activepieces/piece-gmail')!;
    expect(JSON.parse(active.connection_value).remote_id).toBe('ext-a');
  });

  it('reports skipped_none for pieces with no connections and fetches only once', async () => {
    const { client, box } = fakeClient([conn({ pieceName: '@activepieces/piece-gmail' })]);
    const result = await sweepTestConnections(client, [
      '@activepieces/piece-slack', '@activepieces/piece-notion',
    ]);

    expect(box.calls).toBe(1);
    expect(result.skippedNone.map(r => r.pieceName)).toEqual([
      '@activepieces/piece-slack', '@activepieces/piece-notion',
    ]);
  });
});

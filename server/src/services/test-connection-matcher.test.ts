import { describe, it, expect } from 'vitest';
import { classify } from './test-connection-matcher.js';
import type { AppConnection } from './ap-client.js';

function conn(over: Partial<AppConnection>): AppConnection {
  return {
    id: 'id1', pieceName: '@activepieces/piece-gmail', displayName: 'd', projectId: 'proj',
    externalId: 'ext1', type: 'OAUTH2', status: 'ACTIVE', ...over,
  };
}

describe('classify', () => {
  it('returns every connection whose pieceName matches the piece', () => {
    const r = classify('@activepieces/piece-gmail', [
      conn({ id: 'a', pieceName: '@activepieces/piece-gmail', displayName: 'Gmail A' }),
      conn({ id: 'b', pieceName: '@activepieces/piece-gmail', displayName: 'Gmail B' }),
      conn({ id: 'c', pieceName: '@activepieces/piece-slack', displayName: 'Slack' }),
    ]);
    expect(r.status).toBe('found');
    expect(r.connections.map(c => c.displayName)).toEqual(['Gmail A', 'Gmail B']);
  });

  it('matches exactly — a longer pieceName is not a match', () => {
    const r = classify('@activepieces/piece-gmail', [
      conn({ id: 'a', pieceName: '@activepieces/piece-gmail-extra', displayName: 'X' }),
    ]);
    expect(r.status).toBe('none');
    expect(r.connections).toEqual([]);
  });

  it('returns none when no connection matches', () => {
    const r = classify('@activepieces/piece-notion', [conn({ pieceName: '@activepieces/piece-gmail' })]);
    expect(r.status).toBe('none');
  });
});

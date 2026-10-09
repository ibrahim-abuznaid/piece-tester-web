import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../../db/schema.js';
import { buildPieceContext, buildTriggerContext } from './shared.js';
import type { PieceMetadataFull } from '../../../services/ap-client.js';

function piece(auth: boolean): PieceMetadataFull {
  return {
    name: '@activepieces/piece-x', displayName: 'X', description: '', logoUrl: '', version: '1.0.0',
    auth: auth ? { type: 'SECRET_TEXT' } : undefined,
    actions: { do: { displayName: 'Do', description: '', props: {} } as any },
    triggers: { on: { displayName: 'On', description: '', type: 'POLLING', props: {} } as any },
    pieceType: 'OFFICIAL', packageType: 'REGISTRY',
  };
}

describe('prompt context connection line', () => {
  beforeEach(() => getDb().exec('DELETE FROM piece_connections;'));

  it('says a no-auth piece needs no connection', () => {
    expect(buildPieceContext(piece(false), 'do')).toContain('**Connection:** Not needed');
    expect(buildTriggerContext(piece(false), 'on')).toContain('**Connection:** Not needed');
  });

  it('still reports Not connected for an auth piece without a local connection', () => {
    expect(buildPieceContext(piece(true), 'do')).toContain('**Connection:** Not connected');
    expect(buildTriggerContext(piece(true), 'on')).toContain('**Connection:** Not connected');
  });
});

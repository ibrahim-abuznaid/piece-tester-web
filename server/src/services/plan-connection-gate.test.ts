import { describe, it, expect } from 'vitest';
import { evaluateConnectionForPlanning } from './plan-connection-gate.js';
import type { AppConnection } from './ap-client.js';
import type { PieceConnectionRow } from '../db/queries.js';

const PIECE = '@activepieces/piece-apify';
const DISPLAY = 'Apify';

function remote(overrides: Partial<AppConnection> = {}): AppConnection {
  return {
    id: 'conn_1', pieceName: PIECE, displayName: 'Apify conn', projectId: 'p1',
    externalId: 'EXT1', type: 'CUSTOM_AUTH', status: 'ACTIVE', ...overrides,
  };
}

function localRow(connectionValue: unknown, overrides: Partial<PieceConnectionRow> = {}): PieceConnectionRow {
  return {
    id: 1, piece_name: PIECE, display_name: DISPLAY, connection_type: 'CUSTOM_AUTH',
    connection_value: JSON.stringify(connectionValue), actions_config: '{}', ai_config_meta: '{}',
    project_id: 'p1', is_active: 1, created_at: '', updated_at: '', ...overrides,
  };
}

describe('evaluateConnectionForPlanning', () => {
  it('accepts an imported local row whose remote is live', () => {
    const row = localRow({ _imported: true, remote_id: 'EXT1' });
    expect(evaluateConnectionForPlanning(PIECE, DISPLAY, row, [remote()])).toEqual({ ok: true });
  });

  it('rejects an imported local row whose remote was deleted in AP', () => {
    const row = localRow({ _imported: true, remote_id: 'GONE' });
    const res = evaluateConnectionForPlanning(PIECE, DISPLAY, row, [remote()]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/deleted/i);
  });

  it('rejects an imported local row whose remote is in an error state', () => {
    const row = localRow({ _imported: true, remote_id: 'EXT1' });
    const res = evaluateConnectionForPlanning(PIECE, DISPLAY, row, [remote({ status: 'ERROR' })]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/error|reauthor/i);
  });

  it('accepts a manual (non-imported) local row without needing any remote', () => {
    const row = localRow({ apiKey: 'secret' });
    expect(evaluateConnectionForPlanning(PIECE, DISPLAY, row, [])).toEqual({ ok: true });
  });

  it('accepts a local row with unparseable connection_value (treated as manual)', () => {
    const row = localRow({} , { connection_value: 'not-json' });
    expect(evaluateConnectionForPlanning(PIECE, DISPLAY, row, [])).toEqual({ ok: true });
  });

  it('accepts no local row when AP has a usable connection for the piece', () => {
    expect(evaluateConnectionForPlanning(PIECE, DISPLAY, undefined, [remote()])).toEqual({ ok: true });
  });

  it('rejects no local row when AP has no connection for the piece', () => {
    const res = evaluateConnectionForPlanning(PIECE, DISPLAY, undefined, [remote({ pieceName: '@activepieces/piece-other' })]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no active connection/i);
  });

  it('rejects no local row when the only AP connection for the piece is in error', () => {
    const res = evaluateConnectionForPlanning(PIECE, DISPLAY, undefined, [remote({ status: 'ERROR' })]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no active connection/i);
  });
});

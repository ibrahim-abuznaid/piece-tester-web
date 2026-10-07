import { describe, it, expect } from 'vitest';
import { buildTicketDraft, buildCommentBody, describeEffectiveDate, type TicketContext } from './ticket-draft.js';
import type { VendorFindingRow } from '../../db/vendor-watch-queries.js';

const row = (over: Partial<VendorFindingRow> = {}): VendorFindingRow => ({
  id: 7, plan_id: 1, piece_name: '@activepieces/piece-acme', source_id: 3, run_id: 2, kind: 'deprecation',
  severity: 'high', affects_piece: 1, affected_targets: '["send_message"]', effective_date: '2027-01-31',
  title: 'Messages v1 removed on 2027-01-31', summary: 'POST /v1/messages goes away.',
  suggested_action: 'Move send_message to /v2/messages.', evidence_url: 'https://acme.dev/changelog',
  evidence_excerpt: 'Messages v1 will be removed on 2027-01-31', evidence_verified: 1, is_baseline: 0, signature: 's',
  status: 'new', filed_by: null, linear_issue_id: null, linear_identifier: null, linear_url: null, file_error: '',
  created_at: '2026-10-06 04:00:00', updated_at: '2026-10-06 04:00:00', ...over,
});

const ctx: TicketContext = {
  pieceDisplayName: 'Acme', pieceName: '@activepieces/piece-acme', pieceVersion: '0.5.0',
  inventory: [{ target: 'send_message', target_kind: 'action', method: 'POST', path: '/v1/messages' }],
  sourceLabel: 'Acme changelog', today: new Date('2026-10-06T12:00:00Z'),
};

describe('buildTicketDraft', () => {
  it('builds the title, body sections and priority', () => {
    const d = buildTicketDraft(row(), ctx, 'auto');
    expect(d.title).toBe('Acme: Messages v1 removed on 2027-01-31');
    expect(d.priority).toBe(2);
    expect(d.description).toContain('**Piece:** Acme (`@activepieces/piece-acme` 0.5.0)');
    expect(d.description).toContain('**What changed:** POST /v1/messages goes away.');
    expect(d.description).toContain('**Effective date:** 2027-01-31 (in 117 days)');
    expect(d.description).toContain('**Affects:** `send_message` (POST /v1/messages)');
    expect(d.description).toContain('**Suggested action:** Move send_message to /v2/messages.');
    expect(d.description).toContain('> Messages v1 will be removed on 2027-01-31');
    expect(d.description).toContain('Source: [Acme changelog](https://acme.dev/changelog) · seen 2026-10-06');
    expect(d.description).toContain('Finding #7 · deprecation · high · auto-filed');
  });

  it('says "filed by hand", "the whole piece" and maps critical/low priority', () => {
    expect(buildTicketDraft(row(), ctx, 'manual').description).toContain('filed by hand');
    expect(buildTicketDraft(row({ affected_targets: '["*"]' }), ctx, 'auto').description).toContain('**Affects:** the whole piece');
    expect(buildTicketDraft(row({ severity: 'critical' }), ctx, 'auto').priority).toBe(1);
    expect(buildTicketDraft(row({ severity: 'low' }), ctx, 'auto').priority).toBe(4);
  });

  it('says "N days ago" for a removal that already happened', () => {
    const d = buildTicketDraft(row({ effective_date: '2026-09-01' }), ctx, 'auto');
    expect(d.description).toContain('**Effective date:** 2026-09-01 (35 days ago)');
    expect(d.description).not.toMatch(/in -\d/);
  });

  it('caps the title at 120 characters', () => {
    expect(buildTicketDraft(row({ title: 'y'.repeat(300) }), ctx, 'auto').title).toHaveLength(120);
  });
});

describe('describeEffectiveDate', () => {
  const today = new Date('2026-10-06T23:30:00Z');
  it('handles future, past, today and missing dates', () => {
    expect(describeEffectiveDate('2026-10-07', today)).toBe('2026-10-07 (in 1 day)');
    expect(describeEffectiveDate('2026-10-01', today)).toBe('2026-10-01 (5 days ago)');
    expect(describeEffectiveDate('2026-10-05', today)).toBe('2026-10-05 (1 day ago)');
    expect(describeEffectiveDate('2026-10-06', today)).toBe('2026-10-06 (today)');
    expect(describeEffectiveDate(null, today)).toBe('not stated');
  });
});

describe('buildCommentBody', () => {
  it('names the finding and quotes the evidence', () => {
    const body = buildCommentBody(row());
    expect(body).toContain('Vendor watch saw this again');
    expect(body).toContain('finding #7');
    expect(body).toContain('> Messages v1 will be removed on 2027-01-31');
    expect(body).toContain('Source: https://acme.dev/changelog');
  });
});

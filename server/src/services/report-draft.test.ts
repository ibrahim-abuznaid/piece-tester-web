import { describe, it, expect } from 'vitest';
import { buildReportDraft } from './report-draft.js';

const base = {
  piece_name: '@activepieces/piece-streak',
  failing_targets: [
    { action: 'create-box', category: 'piece_error', error: "Cannot read 'id'", run_id: 42, reproduction: ['Create box {name:"x"}', 'Expect 200'] },
  ],
};

describe('buildReportDraft', () => {
  it('names the single failing target in the title', () => {
    expect(buildReportDraft(base).title).toBe('streak / create-box failing (piece_error)');
  });

  it('uses a piece-level title for multiple targets', () => {
    const d = buildReportDraft({ ...base, failing_targets: [
      base.failing_targets[0],
      { action: 'get-box', category: 'piece_error', error: null, run_id: 43, reproduction: [] },
    ] });
    expect(d.title).toBe('streak failing (piece_error)');
  });

  it('derives the piece label', () => {
    expect(buildReportDraft(base).label).toBe('piece:streak');
  });

  it('maps piece_error to Linear High priority (2)', () => {
    expect(buildReportDraft(base).priority).toBe(2);
  });

  it('maps a non-piece_error category to Medium priority (3)', () => {
    const d = buildReportDraft({ ...base, failing_targets: [{ ...base.failing_targets[0], category: 'assert_failed' }] });
    expect(d.priority).toBe(3);
  });

  it('includes error, run ref, and reproduction in the description', () => {
    const d = buildReportDraft(base);
    expect(d.description).toContain("Cannot read 'id'");
    expect(d.description).toContain('#42');
    expect(d.description).toContain('1. Create box');
  });

  it('renders upstream authors when provided', () => {
    expect(buildReportDraft({ ...base, authors: ['sanket-a11y'] }).description).toContain('@sanket-a11y');
  });
});

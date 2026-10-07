import { describe, it, expect } from 'vitest';
import { validateClassifierFindings, shouldAutoFile, vendorDeadFinding, classifierSignature } from './findings.js';
import { sampleDraft } from '../../db/vendor-watch-test-utils.js';

const text = 'Heads up!\n## 2026-09-01\n- The   Messages v1 API will be REMOVED on 2027-01-31. Please migrate to v2.';
const ctx = { sourceText: text, inventoryTargets: ['send_message', 'new_order'], evidenceUrl: 'https://acme.dev/changelog', isBaseline: false };
const raw = (over: Record<string, unknown> = {}) => ({
  kind: 'deprecation', severity: 'high', affected_targets: ['send_message'], effective_date: '2027-01-31',
  title: 'Messages v1 removed on 2027-01-31', summary: 's', suggested_action: 'a',
  evidence_excerpt: '"the messages v1 API will be removed on 2027-01-31"', ...over,
});

describe('validateClassifierFindings', () => {
  it('verifies an excerpt found in the text, ignoring case, quotes and whitespace', () => {
    const [f] = validateClassifierFindings([raw()], ctx);
    expect(f.evidence_verified).toBe(true);
    expect(f.evidence_url).toBe('https://acme.dev/changelog');
    expect(f.is_baseline).toBe(false);
  });

  it('does not verify an excerpt that is missing or too short', () => {
    expect(validateClassifierFindings([raw({ evidence_excerpt: 'Messages v2 is removed tomorrow' })], ctx)[0].evidence_verified).toBe(false);
    expect(validateClassifierFindings([raw({ evidence_excerpt: 'removed' })], ctx)[0].evidence_verified).toBe(false);
  });

  it('keeps only inventory targets, and * on its own', () => {
    expect(validateClassifierFindings([raw({ affected_targets: ['send_message', 'made_up'] })], ctx)[0].affected_targets).toEqual(['send_message']);
    expect(validateClassifierFindings([raw({ affected_targets: ['*', 'send_message'] })], ctx)[0].affected_targets).toEqual(['*']);
    expect(validateClassifierFindings([raw({ affected_targets: 'send_message' })], ctx)[0].affected_targets).toEqual([]);
  });

  it('drops findings with an unknown or reserved kind, a bad severity or no title', () => {
    expect(validateClassifierFindings([
      raw({ kind: 'vendor_dead' }), raw({ kind: 'nonsense' }), raw({ severity: 'urgent' }), raw({ title: '  ' }),
    ], ctx)).toEqual([]);
  });

  it('never emits a draft without a title or signature, whatever the classifier sends', () => {
    const { title: _omit, ...untitled } = raw();
    expect(validateClassifierFindings([
      untitled, raw({ title: null }), raw({ title: 42 }), raw({ kind: undefined }), raw({ severity: undefined }), null, 'finding', 7,
    ], ctx)).toEqual([]);
    const kept = validateClassifierFindings([raw({ evidence_excerpt: undefined, affected_targets: undefined, effective_date: undefined })], ctx);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('Messages v1 removed on 2027-01-31');
    expect(kept[0].signature).toMatch(/^[0-9a-f]{40}$/);
  });

  it('nulls impossible dates, caps the title, and returns [] for non-arrays', () => {
    const [f] = validateClassifierFindings([raw({ effective_date: '2027-02-30', title: 'x'.repeat(200) })], ctx);
    expect(f.effective_date).toBeNull();
    expect(f.title).toHaveLength(90);
    expect(validateClassifierFindings({ findings: [] }, ctx)).toEqual([]);
  });

  it('gives the same change the same signature, and a different date a different one', () => {
    const a = validateClassifierFindings([raw()], ctx)[0].signature;
    const b = validateClassifierFindings([raw({ title: 'Different words, same change' })], ctx)[0].signature;
    const c = validateClassifierFindings([raw({ effective_date: '2027-03-01' })], ctx)[0].signature;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(classifierSignature('deprecation', ['send_message'], '2027-01-31', '"the messages v1 API will be removed on 2027-01-31"'));
  });

  it('marks baseline findings', () => {
    expect(validateClassifierFindings([raw()], { ...ctx, isBaseline: true })[0].is_baseline).toBe(true);
  });
});

describe('shouldAutoFile', () => {
  const on = { auto_file_enabled: 1 };
  it.each([
    ['auto-file off', sampleDraft(), 'feed', { auto_file_enabled: 0 }, false],
    ['baseline', sampleDraft({ is_baseline: true }), 'feed', on, false],
    ['vendor dead', sampleDraft({ kind: 'vendor_dead', severity: 'critical', affected_targets: ['*'] }), 'liveness', on, true],
    ['verified high deprecation on a target', sampleDraft(), 'feed', on, true],
    ['critical breaking, whole piece', sampleDraft({ kind: 'breaking', severity: 'critical', affected_targets: ['*'] }), 'html', on, true],
    ['unverified, from a feed', sampleDraft({ evidence_verified: false }), 'feed', on, false],
    ['unverified, from an OpenAPI diff', sampleDraft({ evidence_verified: false }), 'openapi', on, true],
    ['medium severity', sampleDraft({ severity: 'medium' }), 'feed', on, false],
    ['new feature', sampleDraft({ kind: 'new_feature' }), 'feed', on, false],
    ['no targets', sampleDraft({ kind: 'breaking', affected_targets: [] }), 'feed', on, false],
  ] as const)('%s', (_name, draft, kind, config, expected) => {
    expect(shouldAutoFile(draft, kind, config)).toBe(expected);
  });
});

describe('vendorDeadFinding', () => {
  it('is a critical whole-piece finding keyed by host', () => {
    const f = vendorDeadFinding('api.acme.dev', 'DNS: api.acme.dev not found', 3, false, 'https://api.acme.dev/v1');
    expect(f).toMatchObject({ kind: 'vendor_dead', severity: 'critical', affected_targets: ['*'], signature: 'vendor_dead|api.acme.dev', evidence_verified: true, is_baseline: false });
    expect(f.summary).toContain('3 time(s) in a row');
  });
});

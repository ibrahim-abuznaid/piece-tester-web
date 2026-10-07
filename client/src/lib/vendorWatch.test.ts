import { describe, it, expect } from 'vitest';
import {
  compareImportance, countByImportance, describeTargets, effectiveLabel, importanceTitle, matchesImportance,
  changedFields, parseImportanceParam, parseJsonArray, shortPieceName, sourceHealth, toPieceName, toggleImportance,
  clampOffset, pageInfo,
} from './vendorWatch';

describe('vendorWatch helpers', () => {
  it('describes targets', () => {
    expect(describeTargets('["*"]')).toBe('whole piece');
    expect(describeTargets('["a","b"]')).toBe('a, b');
    expect(describeTargets('[]')).toBe('—');
    expect(describeTargets('nope')).toBe('—');
  });

  it('labels effective dates relative to today', () => {
    const today = new Date('2026-10-06T20:00:00Z');
    expect(effectiveLabel('2026-10-16', today)).toBe('2026-10-16 (in 10d)');
    expect(effectiveLabel('2026-10-01', today)).toBe('2026-10-01 (5d ago)');
    expect(effectiveLabel('2026-10-06', today)).toBe('2026-10-06 (today)');
    expect(effectiveLabel(null, today)).toBe('—');
  });

  it('classifies source health, counting a noted error as failing', () => {
    expect(sourceHealth({ last_checked_at: null, consecutive_failures: 0, last_error: '' })).toBe('never');
    expect(sourceHealth({ last_checked_at: 'x', consecutive_failures: 0, last_error: '' })).toBe('ok');
    expect(sourceHealth({ last_checked_at: 'x', consecutive_failures: 2, last_error: 'HTTP 500' })).toBe('failing');
    expect(sourceHealth({ last_checked_at: 'x', consecutive_failures: 0, last_error: 'Timed out' })).toBe('failing');
  });

  it('parses JSON arrays defensively and shortens piece names', () => {
    expect(parseJsonArray('[1,2]')).toEqual([1, 2]);
    expect(parseJsonArray('{"a":1}')).toEqual([]);
    expect(parseJsonArray(null)).toEqual([]);
    expect(shortPieceName('@activepieces/piece-slack')).toBe('slack');
  });
});

describe('importance helpers', () => {
  const rated = (importance: 'high' | 'medium' | 'low' | null, over: Partial<{ enterprise: number; usage_projects: number | null; usage_fetched_at: string | null }> = {}) => ({
    importance, enterprise: 0, usage_projects: 491, usage_fetched_at: '2026-10-07 08:00:00', ...over,
  });

  it('parses the URL param in canonical order, dropping unknown and duplicate values', () => {
    expect(parseImportanceParam(null)).toEqual([]);
    expect(parseImportanceParam('')).toEqual([]);
    expect(parseImportanceParam('low,high,bogus,high')).toEqual(['high', 'low']);
    expect(parseImportanceParam(' unrated , medium')).toEqual(['medium', 'unrated']);
  });

  it('toggles a tier in and out, keeping canonical order', () => {
    expect(toggleImportance([], 'low')).toEqual(['low']);
    expect(toggleImportance(['low'], 'high')).toEqual(['high', 'low']);
    expect(toggleImportance(['high', 'low'], 'high')).toEqual(['low']);
  });

  it('matches rows against a filter, with an empty filter matching everything', () => {
    expect(matchesImportance(rated('high'), [])).toBe(true);
    expect(matchesImportance(rated('high'), ['high', 'medium'])).toBe(true);
    expect(matchesImportance(rated('low'), ['high', 'medium'])).toBe(false);
    expect(matchesImportance(rated(null), ['unrated'])).toBe(true);
    expect(matchesImportance(rated(null), ['high'])).toBe(false);
  });

  it('counts rows per tier', () => {
    expect(countByImportance([rated('high'), rated('high'), rated(null), rated('low')]))
      .toEqual({ high: 2, medium: 0, low: 1, unrated: 1 });
  });

  it('explains a rating in the tooltip', () => {
    expect(importanceTitle(rated('high', { enterprise: 1 })))
      .toBe('High importance · 491 Cloud projects across all versions · on the Enterprise list · usage from 2026-10-07');
    expect(importanceTitle(rated('high', { enterprise: 1, usage_projects: null, usage_fetched_at: null })))
      .toBe('High importance · on the Enterprise list · no Cloud usage fetched yet');
    expect(importanceTitle(rated('low', { usage_projects: 1 })))
      .toBe('Low importance · 1 Cloud project across all versions · usage from 2026-10-07');
    expect(importanceTitle(rated(null, { usage_projects: null, usage_fetched_at: null })))
      .toBe('Not rated yet: Cloud usage for this piece has not been fetched');
  });

  it('orders rows by tier, then Cloud projects, with unrated between medium and low', () => {
    const rows = [
      { n: 'a', ...rated('low', { usage_projects: 3 }) },
      { n: 'b', ...rated(null, { usage_projects: null }) },
      { n: 'c', ...rated('high', { usage_projects: 400 }) },
      { n: 'd', ...rated('high', { usage_projects: 9000 }) },
      { n: 'e', ...rated('high', { enterprise: 1, usage_projects: null }) },
    ];
    expect([...rows].sort(compareImportance).map(r => r.n)).toEqual(['d', 'c', 'e', 'b', 'a']);
  });
});

describe('toPieceName', () => {
  it.each([
    ['Salesforce', '@activepieces/piece-salesforce'],
    ['  Google Sheets ', '@activepieces/piece-google-sheets'],
    ['piece-sap-ariba', '@activepieces/piece-sap-ariba'],
    ['zoho-crm', '@activepieces/piece-zoho-crm'],
    ['@activepieces/piece-netsuite', '@activepieces/piece-netsuite'],
    ['@acme/piece-internal', '@acme/piece-internal'],
  ])('%s → %s', (text, name) => {
    expect(toPieceName(text)).toBe(name);
  });

  it.each(['', '   ', 'Sales/force', 'what?!'])('rejects %j', (text) => {
    expect(toPieceName(text)).toBeNull();
  });
});

describe('changedFields', () => {
  it('keeps only the keys whose value differs from the base', () => {
    expect(changedFields({ a: 1, b: 'x', c: '[]' }, { a: 1, b: 'y', c: '["s"]' })).toEqual({ b: 'y', c: '["s"]' });
    expect(changedFields({ a: 1 }, { a: 1 })).toEqual({});
  });
});


describe('findings paging', () => {
  it('describes the page range and the neighbouring offsets', () => {
    expect(pageInfo({ offset: 0, limit: 100, total: 340 }, 100)).toEqual({ from: 1, to: 100, prevOffset: null, nextOffset: 100 });
    expect(pageInfo({ offset: 100, limit: 100, total: 340 }, 100)).toEqual({ from: 101, to: 200, prevOffset: 0, nextOffset: 200 });
    expect(pageInfo({ offset: 300, limit: 100, total: 340 }, 40)).toEqual({ from: 301, to: 340, prevOffset: 200, nextOffset: null });
  });

  it('has no neighbours for a single full page or an empty list', () => {
    expect(pageInfo({ offset: 0, limit: 100, total: 100 }, 100)).toEqual({ from: 1, to: 100, prevOffset: null, nextOffset: null });
    expect(pageInfo({ offset: 0, limit: 100, total: 0 }, 0)).toEqual({ from: 0, to: 0, prevOffset: null, nextOffset: null });
  });

  it('moves an offset past the last row back to the last page', () => {
    expect(clampOffset(200, 340, 100)).toBe(200);
    expect(clampOffset(300, 300, 100)).toBe(200);
    expect(clampOffset(100, 100, 100)).toBe(0);
    expect(clampOffset(400, 250, 100)).toBe(200);
    expect(clampOffset(100, 0, 100)).toBe(0);
    expect(clampOffset(0, 0, 100)).toBe(0);
  });
});

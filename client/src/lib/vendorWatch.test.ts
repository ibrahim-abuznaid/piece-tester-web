import { describe, it, expect } from 'vitest';
import {
  compareImportance, countByImportance, describeTargets, effectiveLabel, importanceTitle, matchesImportance,
  changedFields, parseImportanceParam, parseJsonArray, shortPieceName, sourceHealth, toPieceName, toggleImportance,
  addUpTo, generationEstimate, parsePieceList, pickEnterprise, pickTopByUsage, watchedPieceNames,
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


describe('bulk selection helpers', () => {
  const piece = (name: string, usage_projects: number | null, over: Partial<{ categories: string[]; enterprise: number }> = {}) => ({
    name: `@activepieces/piece-${name}`, usage_projects, enterprise: 0, ...over,
  });

  it('treats every plan except a failed one as watched', () => {
    const watched = watchedPieceNames([
      { piece_name: 'a', status: 'active' },
      { piece_name: 'b', status: 'queued' },
      { piece_name: 'c', status: 'failed' },
      { piece_name: 'd', status: 'paused' },
      { piece_name: 'e', status: 'generating' },
    ]);
    expect([...watched].sort()).toEqual(['a', 'b', 'd', 'e']);
  });

  it('picks the top N by Cloud usage, skipping core, unrated and watched pieces, ties by name', () => {
    const pieces = [
      piece('webhook', 9000, { categories: ['CORE'] }),
      piece('slack', 500),
      piece('gmail', 800),
      piece('notion', null),
      piece('asana', 500),
      piece('hubspot', 700),
      piece('linear', 10, { categories: ['PRODUCTIVITY'] }),
    ];
    expect(pickTopByUsage(pieces, 3, new Set(['@activepieces/piece-hubspot']))).toEqual([
      '@activepieces/piece-gmail', '@activepieces/piece-asana', '@activepieces/piece-slack',
    ]);
    expect(pickTopByUsage(pieces, 50, new Set())).toHaveLength(5);
    expect(pickTopByUsage(pieces, 0, new Set())).toEqual([]);
  });

  it('picks Enterprise pieces that are not watched yet, in list order', () => {
    const pieces = [piece('sap', null, { enterprise: 1 }), piece('slack', 500), piece('netsuite', 3, { enterprise: 1 }), piece('oracle', 1, { enterprise: 1 })];
    expect(pickEnterprise(pieces, new Set(['@activepieces/piece-oracle']))).toEqual(['@activepieces/piece-sap', '@activepieces/piece-netsuite']);
  });

  it('adds names up to a cap, keeping the current ones and skipping duplicates', () => {
    expect(addUpTo(['a', 'b'], ['b', 'c', 'd'], 10)).toEqual(['a', 'b', 'c', 'd']);
    expect(addUpTo(['a', 'b'], ['c', 'd', 'e'], 3)).toEqual(['a', 'b', 'c']);
    expect(addUpTo(['a', 'b', 'c'], ['d'], 2)).toEqual(['a', 'b', 'c']);
  });

  it('estimates cost and time for a batch, in minutes under an hour', () => {
    expect(generationEstimate(0)).toBe('0 selected');
    expect(generationEstimate(1)).toBe('1 selected · about $0 · runs one at a time, about 2 min');
    expect(generationEstimate(39)).toBe('39 selected · about $14 · runs one at a time, about 59 min');
    expect(generationEstimate(40)).toBe('40 selected · about $14 · runs one at a time, about 1 h');
    expect(generationEstimate(230)).toBe('230 selected · about $81 · runs one at a time, about 6 h');
    expect(generationEstimate(300)).toBe('300 selected · about $105 · runs one at a time, about 8 h');
  });
});

describe('parsePieceList', () => {
  const known = new Set([
    '@activepieces/piece-salesforce', '@activepieces/piece-google-sheets', '@activepieces/piece-zoho-crm', '@acme/piece-internal',
  ]);

  it('splits on newlines, commas and semicolons, maps short names and keeps scoped names', () => {
    expect(parsePieceList('Salesforce\n Google Sheets ,zoho-crm;@acme/piece-internal', known)).toEqual({
      names: ['@activepieces/piece-salesforce', '@activepieces/piece-google-sheets', '@activepieces/piece-zoho-crm', '@acme/piece-internal'],
      unknown: [],
    });
  });

  it('drops empty entries and duplicates', () => {
    expect(parsePieceList('salesforce\r\n\n , ;SALESFORCE\n@activepieces/piece-salesforce', known)).toEqual({
      names: ['@activepieces/piece-salesforce'],
      unknown: [],
    });
  });

  it('lists entries that are not in the catalog as typed, once each', () => {
    expect(parsePieceList('Monday.com, salesforce, Monday.com, @acme/piece-gone', known)).toEqual({
      names: ['@activepieces/piece-salesforce'],
      unknown: ['Monday.com', '@acme/piece-gone'],
    });
    expect(parsePieceList('   \n', known)).toEqual({ names: [], unknown: [] });
  });
});

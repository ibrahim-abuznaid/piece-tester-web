import { describe, it, expect } from 'vitest';
import {
  compareImportance, countByImportance, describeTargets, effectiveLabel, importanceTitle, matchesImportance,
  changedFields, parseImportanceParam, parseJsonArray, shortPieceName, sourceHealth, toPieceName, toggleImportance,
  addUpTo, findPiece, generationEstimate, parsePieceList, pickEnterprise, pickTopByUsage, watchedPieceNames, clampOffset, pageInfo,
  parseCsv, parsePieceCsv, uploadNote,
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

  describe('pickTopByUsage', () => {
    const pieces = [
      piece('webhook', 9000, { categories: ['CORE'] }),
      piece('slack', 500),
      piece('gmail', 800),
      piece('notion', null),
      piece('asana', 500),
      piece('hubspot', 700),
      piece('linear', 10, { categories: ['PRODUCTIVITY'] }),
    ];

    it('takes the top N rated non-core pieces by Cloud usage, ties by name', () => {
      expect(pickTopByUsage(pieces, 3, new Set())).toEqual([
        '@activepieces/piece-gmail', '@activepieces/piece-hubspot', '@activepieces/piece-asana',
      ]);
      expect(pickTopByUsage(pieces, 50, new Set())).toHaveLength(5);
      expect(pickTopByUsage(pieces, 0, new Set())).toEqual([]);
    });

    it('drops watched pieces after taking the top N, so it never reaches past rank N', () => {
      expect(pickTopByUsage(pieces, 3, new Set(['@activepieces/piece-hubspot']))).toEqual([
        '@activepieces/piece-gmail', '@activepieces/piece-asana',
      ]);
      expect(pickTopByUsage(pieces, 2, new Set(['@activepieces/piece-gmail', '@activepieces/piece-hubspot']))).toEqual([]);
      expect(pickTopByUsage(pieces, 5, new Set(['@activepieces/piece-linear']))).toEqual([
        '@activepieces/piece-gmail', '@activepieces/piece-hubspot', '@activepieces/piece-asana', '@activepieces/piece-slack',
      ]);
    });
  });

  it('picks Enterprise pieces that are not watched yet, in list order', () => {
    const pieces = [piece('sap', null, { enterprise: 1 }), piece('slack', 500), piece('netsuite', 3, { enterprise: 1 }), piece('oracle', 1, { enterprise: 1 })];
    expect(pickEnterprise(pieces, new Set(['@activepieces/piece-oracle']))).toEqual(['@activepieces/piece-sap', '@activepieces/piece-netsuite']);
  });

  it('skips built-in Enterprise pieces: they have no vendor to watch', () => {
    const pieces = [piece('webhook', 900, { enterprise: 1, categories: ['CORE'] }), piece('sap', null, { enterprise: 1 })];
    expect(pickEnterprise(pieces, new Set())).toEqual(['@activepieces/piece-sap']);
  });

  it('adds names up to a cap, keeping the current ones and skipping duplicates', () => {
    expect(addUpTo(['a', 'b'], ['b', 'c', 'd'], 10)).toEqual(['a', 'b', 'c', 'd']);
    expect(addUpTo(['a', 'b'], ['c', 'd', 'e'], 3)).toEqual(['a', 'b', 'c']);
    expect(addUpTo(['a', 'b', 'c'], ['d'], 2)).toEqual(['a', 'b', 'c']);
  });

  it('estimates cost and time for a batch, in minutes under an hour and cents under $10', () => {
    expect(generationEstimate(0)).toBe('0 selected');
    expect(generationEstimate(1)).toBe('1 selected · about $0.35 · runs one at a time, about 2 min');
    expect(generationEstimate(10)).toBe('10 selected · about $3.50 · runs one at a time, about 15 min');
    expect(generationEstimate(28)).toBe('28 selected · about $9.80 · runs one at a time, about 42 min');
    expect(generationEstimate(29)).toBe('29 selected · about $10 · runs one at a time, about 44 min');
    expect(generationEstimate(39)).toBe('39 selected · about $14 · runs one at a time, about 59 min');
    expect(generationEstimate(40)).toBe('40 selected · about $14 · runs one at a time, about 1 h');
    expect(generationEstimate(230)).toBe('230 selected · about $81 · runs one at a time, about 6 h');
    expect(generationEstimate(300)).toBe('300 selected · about $105 · runs one at a time, about 8 h');
  });
});

describe('findPiece', () => {
  const catalog = [
    { name: '@activepieces/piece-monday', displayName: 'Monday.com' },
    { name: '@acme/piece-internal', displayName: 'Internal' },
  ];

  it('matches the package, display or short name, any case', () => {
    for (const text of ['@activepieces/piece-monday', 'monday.com', ' MONDAY.COM ', 'Monday']) {
      expect(findPiece(catalog, text)?.name).toBe('@activepieces/piece-monday');
    }
    expect(findPiece(catalog, '@ACME/Piece-Internal')?.name).toBe('@acme/piece-internal');
  });

  it('finds nothing for blank or unknown text', () => {
    expect(findPiece(catalog, '  ')).toBeUndefined();
    expect(findPiece(catalog, 'monday-com')).toBeUndefined();
  });
});

describe('parsePieceList', () => {
  const catalog = [
    { name: '@activepieces/piece-salesforce', displayName: 'Salesforce' },
    { name: '@activepieces/piece-google-sheets', displayName: 'Google Sheets' },
    { name: '@activepieces/piece-zoho-crm', displayName: 'Zoho CRM' },
    { name: '@activepieces/piece-monday', displayName: 'Monday.com' },
    { name: '@activepieces/piece-twitter', displayName: 'X (Twitter)' },
    { name: '@acme/piece-internal', displayName: 'Internal' },
  ];

  it('splits on newlines, commas and semicolons, maps short names and keeps scoped names', () => {
    expect(parsePieceList('Salesforce\n Google Sheets ,zoho-crm;@acme/piece-internal', catalog)).toEqual({
      names: ['@activepieces/piece-salesforce', '@activepieces/piece-google-sheets', '@activepieces/piece-zoho-crm', '@acme/piece-internal'],
      unknown: [],
    });
  });

  it('matches display names the slug rule cannot reach, any case', () => {
    expect(parsePieceList('Monday.com\nX (Twitter)', catalog)).toEqual({
      names: ['@activepieces/piece-monday', '@activepieces/piece-twitter'],
      unknown: [],
    });
    expect(parsePieceList('MONDAY.COM; x (twitter); zoho crm', catalog)).toEqual({
      names: ['@activepieces/piece-monday', '@activepieces/piece-twitter', '@activepieces/piece-zoho-crm'],
      unknown: [],
    });
  });

  it('strips a leading "piece-" from a short name', () => {
    expect(parsePieceList('piece-salesforce\nPiece-Zoho CRM', catalog)).toEqual({
      names: ['@activepieces/piece-salesforce', '@activepieces/piece-zoho-crm'],
      unknown: [],
    });
  });

  it('drops empty entries and duplicates, however they were written', () => {
    expect(parsePieceList('salesforce\r\n\n , ;SALESFORCE\n@activepieces/piece-salesforce', catalog)).toEqual({
      names: ['@activepieces/piece-salesforce'],
      unknown: [],
    });
    expect(parsePieceList('Monday.com\nmonday\n@activepieces/piece-monday', catalog)).toEqual({
      names: ['@activepieces/piece-monday'],
      unknown: [],
    });
  });

  it('lists entries that are not in the catalog as typed, once each', () => {
    expect(parsePieceList('Workday Pro, salesforce, Workday Pro, @acme/piece-gone', catalog)).toEqual({
      names: ['@activepieces/piece-salesforce'],
      unknown: ['Workday Pro', '@acme/piece-gone'],
    });
    expect(parsePieceList('Monday.com', [])).toEqual({ names: [], unknown: ['Monday.com'] });
    expect(parsePieceList('   \n', catalog)).toEqual({ names: [], unknown: [] });
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

describe('parseCsv', () => {
  it('splits rows and cells, keeping quoted commas, quotes and line breaks', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",z\n')).toEqual([
      ['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z'],
    ]);
  });

  it('uses semicolons or tabs when the first line has more of them than commas', () => {
    expect(parseCsv('name;rank\nslack;1,5')).toEqual([['name', 'rank'], ['slack', '1,5']]);
    expect(parseCsv('name\trank\nslack\t1')).toEqual([['name', 'rank'], ['slack', '1']]);
  });

  it('drops blank lines and a byte-order mark', () => {
    expect(parseCsv('\uFEFFslack\n\n  \ngmail')).toEqual([['slack'], ['gmail']]);
  });
});

describe('parsePieceCsv', () => {
  const catalog = [
    { name: '@activepieces/piece-slack', displayName: 'Slack' },
    { name: '@activepieces/piece-gmail', displayName: 'Gmail' },
    { name: '@activepieces/piece-google-sheets', displayName: 'Google Sheets' },
    { name: '@activepieces/piece-ai', displayName: 'AI' },
  ];

  it('reads the column that holds piece names and skips its header', () => {
    const csv = 'Rank,Piece,Category\n1,Slack,AI\n2,google-sheets,AI\n3,@activepieces/piece-gmail,Other\n4,Custom piece (customer-built),Custom\n';
    expect(parsePieceCsv(csv, catalog)).toEqual({
      names: ['@activepieces/piece-slack', '@activepieces/piece-google-sheets', '@activepieces/piece-gmail'],
      unknown: ['Custom piece (customer-built)'],
    });
  });

  it('takes API names, repo folder names and repo paths', () => {
    const csv = 'piece_name\n@activepieces/piece-slack\npiece-gmail\npackages/pieces/community/google-sheets\n';
    expect(parsePieceCsv(csv, catalog)).toEqual({
      names: ['@activepieces/piece-slack', '@activepieces/piece-gmail', '@activepieces/piece-google-sheets'],
      unknown: [],
    });
  });

  it('keeps the first row when it is a piece, and drops blanks and duplicates', () => {
    expect(parsePieceCsv('slack\n\nSLACK\ngmail\n,\n', catalog)).toEqual({
      names: ['@activepieces/piece-slack', '@activepieces/piece-gmail'],
      unknown: [],
    });
  });

  it('returns nothing when no column has a piece', () => {
    expect(parsePieceCsv('a,b\n1,2\n', catalog)).toEqual({ names: [], unknown: [] });
    expect(parsePieceCsv('', catalog)).toEqual({ names: [], unknown: [] });
  });
});

describe('uploadNote', () => {
  const none = { found: 0, added: 0, builtIn: 0, watched: 0, capped: 0, unknown: [] as string[] };

  it('says when the file named no pieces', () => {
    expect(uploadNote('x.csv', none, 300)).toBe('No piece names found in x.csv.');
  });

  it('counts what was added, skipped as watched, capped and not found', () => {
    expect(uploadNote('top.csv', { found: 24, added: 18, builtIn: 3, watched: 2, capped: 1, unknown: ['Foo'] }, 300))
      .toBe('top.csv: added 18 pieces. Skipped 3 built-in pieces (no vendor to watch). 2 already have watchers. '
        + 'A batch holds at most 300; 1 not added. Not found: Foo.');
    expect(uploadNote('h.csv', { ...none, found: 1, builtIn: 1 }, 300)).toBe('h.csv: added 0 pieces. Skipped 1 built-in piece (no vendor to watch).');
    expect(uploadNote('one.csv', { ...none, found: 1, added: 1 }, 300)).toBe('one.csv: added 1 piece.');
    expect(uploadNote('w.csv', { ...none, found: 1, watched: 1 }, 300)).toBe('w.csv: added 0 pieces. 1 already has a watcher.');
  });

  it('lists at most 10 unknown entries', () => {
    const unknown = Array.from({ length: 12 }, (_, i) => `p${i}`);
    expect(uploadNote('u.csv', { ...none, unknown }, 300))
      .toBe('u.csv: added 0 pieces. Not found: p0, p1, p2, p3, p4, p5, p6, p7, p8, p9 and 2 more.');
  });
});

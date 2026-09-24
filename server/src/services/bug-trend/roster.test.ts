import { describe, it, expect } from 'vitest';
import {
  validateRoster, parseRoster, matchRosterSeed, seedRosterIfEmpty, DEFAULT_ROSTER_NAMES,
  type LinearUser,
} from './roster.js';

const users: LinearUser[] = [
  { id: 'u-ibrahim', name: 'Ibrahim Abu Znaid', displayName: 'ibrahim' },
  { id: 'u-kishan', name: 'kishan parmar', displayName: 'kishan' },
  { id: 'u-sanket', name: 'S. Nannaware', displayName: 'Sanket Nannaware' },
  { id: 'u-other', name: 'Someone Else', displayName: 'someone' },
];

describe('validateRoster', () => {
  it('accepts an empty list', () => {
    expect(validateRoster([])).toEqual([]);
  });
  it('rejects a non-array', () => {
    expect(validateRoster({ id: 'u1', name: 'A' })).toBeNull();
    expect(validateRoster('[]')).toBeNull();
  });
  it('rejects an entry without a string id or name', () => {
    expect(validateRoster([{ id: '', name: 'A' }])).toBeNull();
    expect(validateRoster([{ id: 'u1' }])).toBeNull();
    expect(validateRoster([null])).toBeNull();
  });
  it('keeps only id and name, and drops duplicate ids', () => {
    expect(validateRoster([
      { id: 'u1', name: 'A', extra: true },
      { id: 'u1', name: 'A again' },
      { id: 'u2', name: 'B' },
    ])).toEqual([{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }]);
  });
});

describe('parseRoster', () => {
  it('parses a stored roster', () => {
    expect(parseRoster('[{"id":"u1","name":"A"}]')).toEqual([{ id: 'u1', name: 'A' }]);
  });
  it('returns [] for malformed JSON or a wrong shape instead of throwing', () => {
    expect(parseRoster('not json')).toEqual([]);
    expect(parseRoster('{"id":"u1"}')).toEqual([]);
    expect(parseRoster('')).toEqual([]);
  });
});

describe('matchRosterSeed', () => {
  it('matches name or displayName case-insensitively and saves by id', () => {
    const r = matchRosterSeed(users, ['Ibrahim Abu Znaid', 'Kishan Parmar', 'Sanket Nannaware']);
    expect(r.matched).toEqual([
      { id: 'u-ibrahim', name: 'Ibrahim Abu Znaid' },
      { id: 'u-kishan', name: 'kishan parmar' },
      { id: 'u-sanket', name: 'S. Nannaware' },
    ]);
    expect(r.notFound).toEqual([]);
  });
  it('reports names with no matching user', () => {
    const r = matchRosterSeed(users, ['Talal Jaber']);
    expect(r.matched).toEqual([]);
    expect(r.notFound).toEqual(['Talal Jaber']);
  });
});

describe('seedRosterIfEmpty', () => {
  it('does nothing when a roster is already saved', async () => {
    let called = false;
    const r = await seedRosterIfEmpty('[{"id":"u1","name":"A"}]', async () => { called = true; return users; });
    expect(r).toEqual({ roster: null, seeded: [], notFound: [] });
    expect(called).toBe(false);
  });
  it('seeds from the default names when the roster is empty', async () => {
    const r = await seedRosterIfEmpty('[]', async () => users);
    expect(r.roster?.map(m => m.id)).toEqual(['u-ibrahim', 'u-kishan', 'u-sanket']);
    expect(r.seeded).toEqual(['Ibrahim Abu Znaid', 'kishan parmar', 'S. Nannaware']);
    expect(r.notFound).toEqual(['Odai Thalji', 'Talal Jaber']);
  });
  it('treats a corrupted stored roster as empty', async () => {
    const r = await seedRosterIfEmpty('garbage', async () => users);
    expect(r.roster?.length).toBe(3);
  });
  it('reports every default name as not found when loading users fails', async () => {
    const r = await seedRosterIfEmpty('[]', async () => { throw new Error('Linear down'); });
    expect(r).toEqual({ roster: null, seeded: [], notFound: DEFAULT_ROSTER_NAMES });
  });
});

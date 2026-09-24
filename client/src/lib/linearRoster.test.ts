import { describe, it, expect } from 'vitest';
import { buildRosterRows } from './linearRoster';
import type { LinearUser } from './api';

const users: LinearUser[] = [
  { id: 'u-zed', name: 'Zed Person', displayName: 'zed' },
  { id: 'u-kishan', name: 'Kishan Parmar', displayName: 'kishan' },
  { id: 'u-amy', name: 'Amy Other', displayName: 'amy' },
];

describe('buildRosterRows', () => {
  it('lists saved roster members first, then everyone else by name', () => {
    const rows = buildRosterRows(users, [{ id: 'u-zed', name: 'Zed Person' }], ['u-zed'], '');
    expect(rows.map(r => r.id)).toEqual(['u-zed', 'u-amy', 'u-kishan']);
    expect(rows.map(r => r.checked)).toEqual([true, false, false]);
  });

  it('orders by the saved roster, so ticking a box does not move rows', () => {
    const rows = buildRosterRows(users, [{ id: 'u-zed', name: 'Zed Person' }, { id: 'u-kishan', name: 'Kishan Parmar' }], ['u-zed'], '');
    expect(rows.map(r => r.id)).toEqual(['u-zed', 'u-amy', 'u-kishan']);
    expect(rows.find(r => r.id === 'u-kishan')!.checked).toBe(true);
  });

  it('keeps a roster member who is no longer active in Linear, checked and flagged', () => {
    const rows = buildRosterRows(users, [{ id: 'u-gone', name: 'Gone Person' }], ['u-gone'], '');
    expect(rows[0]).toEqual({ id: 'u-gone', name: 'Gone Person', detail: 'not active in Linear', checked: true, inactive: true });
  });

  it('filters by name or displayName, case-insensitively', () => {
    expect(buildRosterRows(users, [], [], 'KISH').map(r => r.id)).toEqual(['u-kishan']);
    expect(buildRosterRows(users, [], [], 'amy').map(r => r.id)).toEqual(['u-amy']);
  });
});

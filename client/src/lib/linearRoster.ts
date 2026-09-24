import type { LinearUser, RosterMember } from './api';

export interface RosterRow { id: string; name: string; detail: string; checked: boolean; inactive: boolean }

/**
 * Checklist rows for the roster picker. Sorted by the SAVED roster (not the one being edited) so rows
 * don't jump while ticking. Roster members missing from Linear's active users stay visible so they can be removed.
 */
export function buildRosterRows(users: LinearUser[], roster: RosterMember[], savedIds: string[], search: string): RosterRow[] {
  const checked = new Set(roster.map(m => m.id));
  const saved = new Set(savedIds);
  const activeIds = new Set(users.map(u => u.id));
  const rows: RosterRow[] = [
    ...roster.filter(m => !activeIds.has(m.id))
      .map(m => ({ id: m.id, name: m.name, detail: 'not active in Linear', checked: true, inactive: true })),
    ...users.map(u => ({ id: u.id, name: u.name, detail: u.displayName, checked: checked.has(u.id), inactive: false })),
  ];
  const q = search.trim().toLowerCase();
  return rows
    .filter(r => !q || r.name.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q))
    .sort((a, b) => Number(b.inactive) - Number(a.inactive)
      || Number(saved.has(b.id)) - Number(saved.has(a.id))
      || a.name.localeCompare(b.name));
}

import type { LinearUser, RosterMember } from './api';

export interface RosterRow { id: string; name: string; detail: string; checked: boolean; inactive: boolean }

/**
 * Checklist rows for the roster picker. Sorted by the SAVED roster (not the one being edited) so rows
 * don't jump while ticking. Saved or edited members missing from Linear's active users stay visible
 * (unticked ones too, until saved) so they can be removed or re-ticked.
 */
export function buildRosterRows(users: LinearUser[], roster: RosterMember[], saved: RosterMember[], search: string): RosterRow[] {
  const checked = new Set(roster.map(m => m.id));
  const savedIds = new Set(saved.map(m => m.id));
  const activeIds = new Set(users.map(u => u.id));
  const listed = new Map<string, RosterMember>();
  for (const m of [...saved, ...roster]) if (!listed.has(m.id)) listed.set(m.id, m);
  const rows: RosterRow[] = [
    ...[...listed.values()].filter(m => !activeIds.has(m.id))
      .map(m => ({ id: m.id, name: m.name, detail: 'not active in Linear', checked: checked.has(m.id), inactive: true })),
    ...users.map(u => ({ id: u.id, name: u.name, detail: u.displayName, checked: checked.has(u.id), inactive: false })),
  ];
  const q = search.trim().toLowerCase();
  return rows
    .filter(r => !q || r.name.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q))
    .sort((a, b) => Number(b.inactive) - Number(a.inactive)
      || Number(savedIds.has(b.id)) - Number(savedIds.has(a.id))
      || a.name.localeCompare(b.name));
}

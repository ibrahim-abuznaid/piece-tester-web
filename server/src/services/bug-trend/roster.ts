/** A Pieces Team member counted by the Bug Trend page, keyed by Linear user ID. */
export interface RosterMember { id: string; name: string }

export interface LinearUser { id: string; name: string; displayName: string }

/** Display names used once, to pre-check the roster the first time a key is saved. */
export const DEFAULT_ROSTER_NAMES = [
  'Ibrahim Abu Znaid',
  'Kishan Parmar',
  'Sanket Nannaware',
  'Odai Thalji',
  'Talal Jaber',
];

/** Returns a clean roster, or null when the input is not a list of { id, name }. */
export function validateRoster(input: unknown): RosterMember[] | null {
  if (!Array.isArray(input)) return null;
  const out: RosterMember[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') return null;
    const { id, name } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string') return null;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/** Reads the stored roster; anything unreadable counts as an empty roster. */
export function parseRoster(json: string): RosterMember[] {
  try {
    return validateRoster(JSON.parse(json)) ?? [];
  } catch {
    return [];
  }
}

export function matchRosterSeed(users: LinearUser[], names: string[]): { matched: RosterMember[]; notFound: string[] } {
  const matched: RosterMember[] = [];
  const notFound: string[] = [];
  for (const wanted of names) {
    const w = wanted.trim().toLowerCase();
    const user = users.find(u => u.name.trim().toLowerCase() === w || u.displayName.trim().toLowerCase() === w);
    if (user) matched.push({ id: user.id, name: user.name });
    else notFound.push(wanted);
  }
  return { matched, notFound };
}

/** Seeds the roster from DEFAULT_ROSTER_NAMES when none is saved. roster is null when nothing should be written. */
export async function seedRosterIfEmpty(
  currentJson: string,
  loadUsers: () => Promise<LinearUser[]>,
): Promise<{ roster: RosterMember[] | null; seeded: string[]; notFound: string[] }> {
  if (parseRoster(currentJson).length > 0) return { roster: null, seeded: [], notFound: [] };
  let users: LinearUser[];
  try {
    users = await loadUsers();
  } catch {
    return { roster: null, seeded: [], notFound: [...DEFAULT_ROSTER_NAMES] };
  }
  const { matched, notFound } = matchRosterSeed(users, DEFAULT_ROSTER_NAMES);
  const roster = validateRoster(matched) ?? [];
  return { roster, seeded: roster.map(m => m.name), notFound };
}

/**
 * Parse a timestamp coming from the DB. SQLite `datetime('now')` yields
 * "YYYY-MM-DD HH:MM:SS" (UTC, no zone), which JS would parse as LOCAL time;
 * `toISOString()` values already carry a 'T' and 'Z'. Normalize the former to
 * UTC so both encodings compare on the same clock. Returns ms since epoch.
 */
export function parseDbTime(s: string): number {
  const norm = s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z';
  return new Date(norm).getTime();
}

/** Whole-second duration between two DB timestamps, or null if either is absent. */
export function runDurationSeconds(startedAt?: string | null, completedAt?: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  return Math.round((parseDbTime(completedAt) - parseDbTime(startedAt)) / 1000);
}

/** Local-time string for a DB timestamp (normalized from UTC). */
export function formatDbTime(s: string): string {
  try { return new Date(parseDbTime(s)).toLocaleTimeString(); } catch { return s; }
}

/** Local date+time string for a DB timestamp (normalized from UTC). */
export function formatDbDateTime(s: string): string {
  try { return new Date(parseDbTime(s)).toLocaleString(); } catch { return s; }
}

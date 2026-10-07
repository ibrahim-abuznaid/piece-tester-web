import cron from 'node-cron';
import type { WatchConfigPatch, WatchConfigRow } from '../../db/vendor-watch-queries.js';

const MAX_ENTERPRISE_PIECES = 200;
const MAX_THRESHOLD = 1_000_000;
const PIECE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

type SavedThresholds = Pick<WatchConfigRow, 'importance_high_min' | 'importance_medium_min'>;

/**
 * Validate a PUT /config body. Only fields present in the body end up in the patch.
 * `saved` supplies the threshold the body leaves out, so High stays above Medium.
 */
export function parseConfigPatch(
  body: Record<string, unknown>,
  saved?: SavedThresholds,
): { patch: WatchConfigPatch; error?: string } {
  const patch: WatchConfigPatch = {};
  const flag = (v: unknown) => (v === true || v === 1 || v === '1' ? 1 : 0);
  if (body.enabled !== undefined) patch.enabled = flag(body.enabled);
  if (body.auto_file_enabled !== undefined) patch.auto_file_enabled = flag(body.auto_file_enabled);
  if (body.cron_expression !== undefined) {
    const v = String(body.cron_expression).trim();
    if (!cron.validate(v)) return { patch, error: `Invalid cron expression: "${v}"` };
    patch.cron_expression = v;
  }
  if (body.timezone !== undefined) {
    const v = String(body.timezone).trim();
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
    } catch {
      return { patch, error: `Unknown timezone: "${v}"` };
    }
    patch.timezone = v;
  }
  if (body.linear_team_key !== undefined) {
    const v = String(body.linear_team_key).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(v)) return { patch, error: 'Linear team key must look like PIE' };
    patch.linear_team_key = v;
  }
  if (body.linear_label !== undefined) {
    const v = String(body.linear_label).trim();
    if (!v || v.length > 80) return { patch, error: 'Linear label must be 1–80 characters' };
    if (v.toLowerCase() === 'piece-tester') return { patch, error: 'Do not use the piece-tester label: Bug Trend counts those issues as tester bugs' };
    patch.linear_label = v;
  }
  if (body.classifier_model !== undefined) {
    const v = String(body.classifier_model).trim();
    if (v.length > 100) return { patch, error: 'Model name is too long' };
    patch.classifier_model = v;
  }
  if (body.dead_after_failures !== undefined) {
    const n = Number(body.dead_after_failures);
    if (!Number.isInteger(n) || n < 1 || n > 30) return { patch, error: 'dead_after_failures must be a whole number from 1 to 30' };
    patch.dead_after_failures = n;
  }
  for (const key of ['importance_high_min', 'importance_medium_min'] as const) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < 1 || n > MAX_THRESHOLD) {
      return { patch, error: `${key} must be a whole number from 1 to ${MAX_THRESHOLD.toLocaleString('en-US')}` };
    }
    patch[key] = n;
  }
  const high = patch.importance_high_min ?? saved?.importance_high_min;
  const medium = patch.importance_medium_min ?? saved?.importance_medium_min;
  const thresholdChanged = patch.importance_high_min !== undefined || patch.importance_medium_min !== undefined;
  if (thresholdChanged && high !== undefined && medium !== undefined && high <= medium) {
    return { patch, error: `High must be above Medium (got High ${high}, Medium ${medium})` };
  }
  if (body.enterprise_pieces !== undefined) {
    const v = body.enterprise_pieces;
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
      return { patch, error: 'enterprise_pieces must be a list of piece names' };
    }
    const names = [...new Set(v.map(x => x.trim()).filter(Boolean))];
    const bad = names.find(n => !PIECE_NAME.test(n));
    if (bad) return { patch, error: `Not a piece name: "${bad}"` };
    if (names.length > MAX_ENTERPRISE_PIECES) return { patch, error: `At most ${MAX_ENTERPRISE_PIECES} enterprise pieces` };
    patch.enterprise_pieces = JSON.stringify(names);
  }
  return { patch };
}

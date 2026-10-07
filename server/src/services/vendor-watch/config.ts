import cron from 'node-cron';
import type { WatchConfigPatch } from '../../db/vendor-watch-queries.js';

/** Validate a PUT /config body. Only fields present in the body end up in the patch. */
export function parseConfigPatch(body: Record<string, unknown>): { patch: WatchConfigPatch; error?: string } {
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
    if (v === 'piece-tester') return { patch, error: 'Do not use the piece-tester label: Bug Trend counts those issues as tester bugs' };
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
  return { patch };
}

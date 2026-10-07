import { getDb } from './schema.js';
import type { FindingDraft } from '../services/vendor-watch/types.js';
import type { PlanResult } from './vendor-watch-queries.js';

/** Wipe every vendor-watch table and put the config row back to its defaults. Tests only. */
export function resetVendorWatch(): void {
  getDb().exec(`
    DELETE FROM vendor_findings;
    DELETE FROM watch_runs;
    DELETE FROM watch_snapshots;
    DELETE FROM watch_sources;
    DELETE FROM watch_plans;
    UPDATE vendor_watch_config SET enabled = 0, cron_expression = '0 4 * * *', timezone = 'UTC',
      auto_file_enabled = 0, linear_team_key = 'PIE', linear_label = 'vendor-watch',
      classifier_model = '', dead_after_failures = 3 WHERE id = 1;
  `);
}

export function samplePlanResult(over: Partial<PlanResult> = {}): PlanResult {
  return {
    piece_version: '0.5.0',
    piece_display_name: 'Acme',
    vendor_name: 'Acme',
    api_base_urls: ['https://api.acme.dev/v1'],
    api_version: 'v1',
    auth_type: 'API key',
    endpoint_inventory: [
      { target: 'send_message', target_kind: 'action', method: 'POST', path: '/v1/messages' },
      { target: 'new_order', target_kind: 'trigger', method: 'GET', path: '/v1/orders' },
    ],
    generation_note: 'ok',
    generation_cost_usd: 0.42,
    ...over,
  };
}

export function sampleDraft(over: Partial<FindingDraft> = {}): FindingDraft {
  return {
    kind: 'deprecation',
    severity: 'high',
    affected_targets: ['send_message'],
    effective_date: '2027-01-31',
    title: 'Messages v1 is deprecated',
    summary: 'POST /v1/messages will be removed.',
    suggested_action: 'Move to /v2/messages.',
    evidence_url: 'https://acme.dev/changelog',
    evidence_excerpt: 'POST /v1/messages will be removed on 2027-01-31',
    evidence_verified: true,
    is_baseline: false,
    signature: 'sig-1',
    ...over,
  };
}

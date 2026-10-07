import Anthropic from '@anthropic-ai/sdk';
import { buildAnthropicClientOptions, type MessagesClient } from '../anthropic-client.js';
import { calculateCost, extractUsage, type CostTracker } from '../../agents/v2/cost-tracker.js';
import { getSettings } from '../../db/queries.js';
import { validateClassifierFindings } from './findings.js';
import type { EndpointRef, FindingDraft, SourceKind } from './types.js';

export const MAX_CLASSIFIER_CHARS = 15_000;

export interface ClassifyInput {
  pieceName: string;
  pieceDisplayName: string;
  vendorName: string;
  apiVersion: string;
  authType: string;
  inventory: EndpointRef[];
  source: { label: string; url: string; kind: SourceKind };
  mode: 'change' | 'baseline';
  text: string;
  /** YYYY-MM-DD */
  today: string;
}

export interface ClassifyResult {
  findings: FindingDraft[];
  costUsd: number;
}

export function capText(text: string, max = MAX_CLASSIFIER_CHARS): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

const REPORT_TOOL = {
  name: 'report_findings',
  description: 'Report every vendor change in the text that matters to this piece. Report an empty list when nothing does.',
  input_schema: {
    type: 'object' as const,
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['breaking', 'deprecation', 'auth_change', 'new_feature', 'other'] },
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            affected_targets: {
              type: 'array', items: { type: 'string' },
              description: 'Target names from the inventory this change hits; ["*"] when it hits every target (auth, base URL, API version, shutdown); [] when it hits nothing the piece uses.',
            },
            effective_date: { type: ['string', 'null'], description: 'YYYY-MM-DD when the change takes effect, or null if the text gives no date.' },
            title: { type: 'string', description: 'At most 90 characters, plain words, e.g. "Conversations API v1 sunsets on 2027-03-01".' },
            summary: { type: 'string', description: 'At most 600 characters: what changes and what it means for this piece.' },
            suggested_action: { type: 'string', description: 'One sentence: what the Pieces team should do.' },
            evidence_excerpt: { type: 'string', description: 'A VERBATIM quote of at most 300 characters, copied from the text, that proves this finding.' },
          },
          required: ['kind', 'severity', 'affected_targets', 'effective_date', 'title', 'summary', 'suggested_action', 'evidence_excerpt'],
        },
      },
    },
    required: ['findings'],
  },
};

export const CLASSIFIER_SYSTEM = `You read vendor API changelogs for the Activepieces Pieces team and decide which changes matter to one piece.

A piece is an integration: its actions and triggers call the vendor endpoints listed in its endpoint inventory. Your job is to catch changes that will BREAK the piece before customers notice.

Kinds:
- breaking: something the piece relies on stops working or changes shape (endpoint removed, field removed or renamed, new required parameter, API version sunset, vendor shutting down).
- deprecation: something is deprecated or scheduled for removal but still works today.
- auth_change: authentication changes (scopes, token format, OAuth endpoints, API key retirement).
- new_feature: new endpoints or capabilities the piece could add.
- other: a real change that is none of the above.

Severity:
- critical: the vendor is shutting down, or something the piece uses stops working within 30 days of today or already has.
- high: something the piece uses is removed or breaks on a stated date more than 30 days out, or is already deprecated.
- medium: a deprecation with no date, or a change to an endpoint the piece uses that may change its output.
- low: a new feature, or a change to something the piece does not use.

Rules:
- Match changes to the inventory by endpoint path, SDK method name or feature name, and put the matching target names in affected_targets. Use ["*"] only for changes that hit every target (auth, base URL, API version, vendor shutdown).
- evidence_excerpt MUST be copied word for word from the text. Never paraphrase it.
- Marketing posts, docs typo fixes, UI-only changes and changes to products the piece does not call are NOT findings. An empty list is the normal answer.
- One finding per distinct change.`;

const BASELINE_NOTE = 'This is the FIRST read of this source, so the text is history, not news. Report only deprecations, sunsets, breaking changes and auth changes that are still upcoming or took effect in the last 90 days. Do not report new features or anything older.';

export function buildClassifierPrompt(input: ClassifyInput): string {
  const { text, truncated } = capText(input.text);
  const inventory = input.inventory.length
    ? input.inventory.map(e => `- ${e.target} (${e.target_kind}): ${e.method} ${e.path}`).join('\n')
    : '- (no endpoint inventory)';
  return [
    `Today: ${input.today}`,
    `Piece: ${input.pieceDisplayName} (${input.pieceName})`,
    `Vendor: ${input.vendorName || 'unknown'} · API version: ${input.apiVersion || 'unknown'} · Auth: ${input.authType || 'unknown'}`,
    '',
    'Endpoint inventory:',
    inventory,
    '',
    `Source: ${input.source.label ? `${input.source.label} (${input.source.kind})` : input.source.kind} — ${input.source.url}`,
    input.mode === 'baseline' ? BASELINE_NOTE : 'This text is NEW since the last check.',
    '',
    '<text>',
    text,
    '</text>',
    truncated ? `(The text was cut at ${MAX_CLASSIFIER_CHARS} characters.)` : '',
  ].join('\n');
}

/** The tool's `findings` as an array, accepting one JSON-encoded string; null when it is anything else. */
function findingsList(value: unknown): unknown[] | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return Array.isArray(value) ? value : null;
}

/** One Claude call over the new text of one source. Throws on a missing, truncated or malformed tool call so the caller keeps the old snapshot. */
export async function classifyChange(
  input: ClassifyInput,
  deps: { client?: MessagesClient; model?: string; costTracker?: CostTracker } = {},
): Promise<ClassifyResult> {
  const settings = getSettings();
  if (!deps.client && !settings.anthropic_api_key) throw new Error('Anthropic API key not configured. Go to Settings to add it.');
  const client: MessagesClient = deps.client ?? new Anthropic(buildAnthropicClientOptions(settings.anthropic_api_key));
  const model = deps.model || settings.ai_model || 'claude-sonnet-4-6';

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: CLASSIFIER_SYSTEM,
    tools: [REPORT_TOOL],
    tool_choice: { type: 'tool', name: REPORT_TOOL.name },
    messages: [{ role: 'user', content: buildClassifierPrompt(input) }],
  });
  deps.costTracker?.trackResponse(model, response, 'vendor_watch_classifier');
  const costUsd = calculateCost(model, extractUsage(response));

  if (response?.stop_reason === 'max_tokens') throw new Error('Classifier output was truncated');
  const call = (response?.content ?? []).find(
    (b): b is Anthropic.ToolUseBlock => b?.type === 'tool_use' && b?.name === REPORT_TOOL.name,
  );
  if (!call) throw new Error('Classifier returned no report_findings call');
  const raw = findingsList((call.input as { findings?: unknown } | null)?.findings);
  if (!raw) throw new Error('Classifier returned malformed report_findings input');

  const findings = validateClassifierFindings(raw, {
    sourceText: capText(input.text).text,
    inventoryTargets: input.inventory.map(e => e.target),
    evidenceUrl: input.source.url,
    isBaseline: input.mode === 'baseline',
  });
  return { findings, costUsd };
}

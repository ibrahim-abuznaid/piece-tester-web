import { sha1 } from './normalize.js';
import { resolveEntry, targetsUsingOp } from './endpoint-match.js';
import type { OpenApiDiff, OpMap } from './openapi.js';
import type { EndpointRef, FindingDraft, FindingKind, Severity } from './types.js';

const MAX_LISTED = 20;

function finding(
  kind: FindingKind, severity: Severity, targets: string[], title: string, summary: string,
  suggested: string, evidence: string, url: string, signature: string, isBaseline: boolean,
): FindingDraft {
  return {
    kind, severity, affected_targets: targets, effective_date: null, title: title.slice(0, 90), summary,
    suggested_action: suggested, evidence_url: url, evidence_excerpt: evidence, evidence_verified: true,
    is_baseline: isBaseline, signature,
  };
}

const who = (targets: string[]) => targets.map(t => `\`${t}\``).join(', ');

/**
 * Deterministic findings from a spec diff. Changes to operations the piece calls are high; the rest are low.
 * Removed ops resolve against `prev`, and only entries that resolve to nothing in `next` count, so a
 * base-path move is not a removal. Everything else resolves against `next`.
 */
export function openApiFindings(
  diff: OpenApiDiff, inventory: EndpointRef[], sourceUrl: string, prev: OpMap, next: OpMap,
): FindingDraft[] {
  const out: FindingDraft[] = [];
  const gone = inventory.filter(e => resolveEntry(e, next).length === 0);
  for (const op of diff.removed) {
    const t = targetsUsingOp(gone, op, prev);
    out.push(t.length
      ? finding('breaking', 'high', t, `Endpoint removed: ${op}`,
        `The vendor's OpenAPI spec no longer has ${op}, which ${who(t)} call.`,
        'Find out whether the endpoint moved or was replaced, then update the affected targets.',
        op, sourceUrl, `breaking|${op}`, false)
      : finding('other', 'low', [], `Unused endpoint removed: ${op}`,
        `${op} was removed from the spec. The piece does not call it.`,
        'No action needed.', op, sourceUrl, `other|removed|${op}`, false));
  }
  for (const op of diff.newlyDeprecated) {
    const t = targetsUsingOp(inventory, op, next);
    out.push(t.length
      ? finding('deprecation', 'high', t, `Endpoint deprecated: ${op}`,
        `The vendor's OpenAPI spec now marks ${op} as deprecated; ${who(t)} call it.`,
        'Check the vendor changelog for the replacement and the removal date, then migrate the affected targets.',
        op, sourceUrl, `deprecation|${op}`, false)
      : finding('other', 'low', [], `Unused endpoint deprecated: ${op}`,
        `${op} is now deprecated. The piece does not call it.`,
        'No action needed.', op, sourceUrl, `other|deprecated|${op}`, false));
  }
  for (const { op, param } of diff.newRequiredParams) {
    const t = targetsUsingOp(inventory, op, next);
    out.push(t.length
      ? finding('breaking', 'high', t, `New required parameter on ${op}`,
        `${op} now requires ${param}; ${who(t)} call it.`,
        `Send ${param} from the affected targets, or confirm they already do.`,
        `${op} ${param}`, sourceUrl, `breaking|${op}|${param}`, false)
      : finding('other', 'low', [], `New required parameter on unused ${op}`,
        `${op} now requires ${param}. The piece does not call it.`,
        'No action needed.', `${op} ${param}`, sourceUrl, `other|param|${op}|${param}`, false));
  }
  if (diff.added.length) {
    const listed = diff.added.slice(0, MAX_LISTED);
    const more = diff.added.length - listed.length;
    out.push(finding('new_feature', 'low', [],
      `${diff.added.length} new endpoint${diff.added.length === 1 ? '' : 's'} in the API`,
      `New in the spec: ${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
      'Consider whether any of these should become new actions or triggers.',
      listed.join('\n'), sourceUrl, `new_feature|${sha1(diff.added.join('\n'))}`, false));
  }
  return out;
}

/** First read of a spec: only operations that are already deprecated AND still called by the piece. */
export function openApiBaselineFindings(ops: OpMap, inventory: EndpointRef[], sourceUrl: string): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const [op, info] of Object.entries(ops)) {
    if (!info.deprecated) continue;
    const t = targetsUsingOp(inventory, op, ops);
    if (!t.length) continue;
    out.push(finding('deprecation', 'medium', t, `Piece calls a deprecated endpoint: ${op}`,
      `The vendor's OpenAPI spec marks ${op} as deprecated, and ${who(t)} still call it.`,
      'Check the vendor docs for the replacement and plan the migration.',
      op, sourceUrl, `deprecation|${op}`, true));
  }
  return out;
}

import { collapseWhitespace, sha1 } from './normalize.js';
import { FINDING_KINDS, SEVERITIES, type FindingDraft, type FindingKind, type Severity, type SourceKind } from './types.js';

const MIN_EXCERPT_CHARS = 12;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Lowercase, drop quote marks, collapse whitespace: how excerpts are compared with source text. */
export function normalizeForMatch(s: string): string {
  return collapseWhitespace(s.toLowerCase().replace(/[“”"'‘’`]/g, ''));
}

export function classifierSignature(kind: FindingKind, targets: string[], effectiveDate: string | null, excerpt: string): string {
  return sha1([kind, [...targets].sort().join(','), effectiveDate ?? '', normalizeForMatch(excerpt).slice(0, 120)].join('|'));
}

function asDate(v: unknown): string | null {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export interface ValidationContext {
  /** Exactly the text the classifier was shown. */
  sourceText: string;
  inventoryTargets: string[];
  evidenceUrl: string;
  isBaseline: boolean;
}

/**
 * Turn the classifier's raw tool input into drafts we can trust: known kinds/severities only
 * (vendor_dead is reserved for the liveness check), real targets only, real dates only, and
 * evidence_verified only when the quote is actually in the text.
 */
export function validateClassifierFindings(raw: unknown, ctx: ValidationContext): FindingDraft[] {
  if (!Array.isArray(raw)) return [];
  const haystack = normalizeForMatch(ctx.sourceText);
  const known = new Set(ctx.inventoryTargets);
  const out: FindingDraft[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const kind = o.kind as FindingKind;
    const severity = o.severity as Severity;
    if (!FINDING_KINDS.includes(kind) || kind === 'vendor_dead' || !SEVERITIES.includes(severity)) continue;
    const title = str(o.title, 90);
    if (!title) continue;
    const excerpt = str(o.evidence_excerpt, 300);
    const listed: unknown[] = Array.isArray(o.affected_targets) ? o.affected_targets : [];
    const strings = listed.filter((t): t is string => typeof t === 'string');
    const targets = strings.includes('*') ? ['*'] : [...new Set(strings.filter(t => known.has(t)))];
    const effective_date = asDate(o.effective_date);
    const needle = normalizeForMatch(excerpt);
    out.push({
      kind, severity, affected_targets: targets, effective_date, title,
      summary: str(o.summary, 600),
      suggested_action: str(o.suggested_action, 300),
      evidence_url: ctx.evidenceUrl,
      evidence_excerpt: excerpt,
      evidence_verified: needle.length >= MIN_EXCERPT_CHARS && haystack.includes(needle),
      is_baseline: ctx.isBaseline,
      signature: classifierSignature(kind, targets, effective_date, excerpt),
    });
  }
  return out;
}

const BREAKAGE: ReadonlySet<FindingKind> = new Set(['breaking', 'deprecation', 'auth_change']);

/** The spec's auto-file rule (§4). Everything that fails it waits in the inbox. */
export function shouldAutoFile(
  f: Pick<FindingDraft, 'kind' | 'severity' | 'affected_targets' | 'evidence_verified' | 'is_baseline'>,
  sourceKind: SourceKind | null,
  config: { auto_file_enabled: number },
): boolean {
  if (!config.auto_file_enabled || f.is_baseline) return false;
  if (f.kind === 'vendor_dead') return true;
  if (!BREAKAGE.has(f.kind) || f.affected_targets.length === 0) return false;
  if (f.severity !== 'critical' && f.severity !== 'high') return false;
  return f.evidence_verified || sourceKind === 'openapi';
}

export function vendorDeadFinding(host: string, detail: string, failures: number, isBaseline: boolean, sourceUrl: string): FindingDraft {
  return {
    kind: 'vendor_dead',
    severity: 'critical',
    affected_targets: ['*'],
    effective_date: null,
    title: `Vendor API host ${host} is unreachable`,
    summary: `${host} failed the liveness check ${failures} time(s) in a row (${detail}). The vendor may have shut down or moved its API.`,
    suggested_action: 'Confirm the vendor is gone (DNS, status page, news). If it is, deprecate the piece (deprecated: true on createPiece + version bump); if the API moved, update the base URL.',
    evidence_url: sourceUrl,
    evidence_excerpt: detail,
    evidence_verified: true,
    is_baseline: isBaseline,
    signature: `vendor_dead|${host}`,
  };
}

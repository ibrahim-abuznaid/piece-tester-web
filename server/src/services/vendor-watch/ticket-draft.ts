import { parseTargets, type VendorFindingRow } from '../../db/vendor-watch-queries.js';
import type { EndpointRef, Severity } from './types.js';

export interface TicketContext {
  pieceDisplayName: string;
  pieceName: string;
  pieceVersion: string;
  inventory: EndpointRef[];
  sourceLabel: string;
  today: Date;
}

export interface TicketDraft {
  title: string;
  description: string;
  priority: number;
}

/** Linear priority: 1 Urgent, 2 High, 3 Medium, 4 Low. */
export const PRIORITY_BY_SEVERITY: Record<Severity, number> = { critical: 1, high: 2, medium: 3, low: 4 };

export function daysUntil(date: string, today: Date): number {
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - start) / 86_400_000);
}

export function describeEffectiveDate(date: string | null, today: Date): string {
  if (!date) return 'not stated';
  const d = daysUntil(date, today);
  if (d === 0) return `${date} (today)`;
  const n = Math.abs(d);
  const unit = `day${n === 1 ? '' : 's'}`;
  return d > 0 ? `${date} (in ${n} ${unit})` : `${date} (${n} ${unit} ago)`;
}

export function describeAffects(targets: string[], inventory: EndpointRef[]): string {
  if (targets.includes('*')) return 'the whole piece';
  if (targets.length === 0) return 'nothing the piece uses';
  return targets.map(t => {
    const calls = inventory.filter(e => e.target === t).map(e => `${e.method} ${e.path}`);
    return calls.length ? `\`${t}\` (${calls.join(', ')})` : `\`${t}\``;
  }).join(', ');
}

export function buildTicketDraft(f: VendorFindingRow, ctx: TicketContext, filedBy: 'auto' | 'manual'): TicketDraft {
  const seen = f.created_at.slice(0, 10);
  const lines = [
    '**Vendor change found by Piece Tester vendor watch**',
    '',
    `**Piece:** ${ctx.pieceDisplayName} (\`${ctx.pieceName}\` ${ctx.pieceVersion})`,
    `**What changed:** ${f.summary || f.title}`,
    `**Effective date:** ${describeEffectiveDate(f.effective_date, ctx.today)}`,
    `**Affects:** ${describeAffects(parseTargets(f.affected_targets), ctx.inventory)}`,
    `**Suggested action:** ${f.suggested_action || 'Check the source and decide whether the piece needs a change.'}`,
    '',
  ];
  if (f.evidence_excerpt) lines.push(`> ${f.evidence_excerpt.replace(/\s*\n\s*/g, ' ')}`, '');
  lines.push(f.evidence_url ? `Source: [${ctx.sourceLabel || f.evidence_url}](${f.evidence_url}) · seen ${seen}` : `Seen ${seen}`);
  lines.push(`Finding #${f.id} · ${f.kind} · ${f.severity} · ${filedBy === 'auto' ? 'auto-filed' : 'filed by hand'}`);
  return {
    title: `${ctx.pieceDisplayName}: ${f.title}`.slice(0, 120),
    description: lines.join('\n'),
    priority: PRIORITY_BY_SEVERITY[f.severity] ?? 3,
  };
}

export function buildCommentBody(f: VendorFindingRow): string {
  const lines = [`**Vendor watch saw this again** (finding #${f.id}, ${f.severity})`, '', f.summary || f.title];
  if (f.evidence_excerpt) lines.push('', `> ${f.evidence_excerpt.replace(/\s*\n\s*/g, ' ')}`);
  if (f.evidence_url) lines.push('', `Source: ${f.evidence_url}`);
  return lines.join('\n');
}

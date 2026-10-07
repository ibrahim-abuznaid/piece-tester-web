import { getSettings } from '../../db/queries.js';
import {
  findMergeTarget, getFinding, getPlan, getSource, getWatchConfig, markFindingFiled, parseTargets, setFindingFileError,
  type VendorFindingRow,
} from '../../db/vendor-watch-queries.js';
import { parseInventory } from './findings.js';
import { addLinearComment, createLinearIssue, resolveLinearTargets, type LinearQueryFn } from './linear-filer.js';
import { buildCommentBody, buildTicketDraft, PRIORITY_BY_SEVERITY, type TicketContext, type TicketDraft } from './ticket-draft.js';

export interface FilingPreview {
  draft: TicketDraft;
  mode: 'create' | 'comment';
  existing: { linear_identifier: string; linear_url: string } | null;
}

export interface FileOptions {
  filedBy: 'auto' | 'manual';
  override?: Partial<TicketDraft>;
  query?: LinearQueryFn;
  today?: Date;
}

export class FilingInProgressError extends Error {
  constructor(findingId: number) {
    super(`Finding ${findingId} is already being filed`);
    this.name = 'FilingInProgressError';
  }
}

const filing = new Set<number>();

function mustGet(id: number): VendorFindingRow {
  const f = getFinding(id);
  if (!f) throw new Error(`Finding ${id} not found`);
  return f;
}

function ticketContext(f: VendorFindingRow, today: Date): TicketContext {
  const plan = getPlan(f.plan_id);
  return {
    pieceDisplayName: plan?.piece_display_name || f.piece_name.replace('@activepieces/piece-', ''),
    pieceName: f.piece_name,
    pieceVersion: plan?.piece_version ?? '',
    inventory: parseInventory(plan?.endpoint_inventory ?? ''),
    sourceLabel: f.source_id ? getSource(f.source_id)?.label ?? '' : '',
    today,
  };
}

/** What the inbox "File…" modal shows: a new-ticket draft, or a comment on the matching filed ticket. */
export function previewFiling(findingId: number, today = new Date()): FilingPreview {
  const f = mustGet(findingId);
  const merge = findMergeTarget(f.piece_name, f.kind, parseTargets(f.affected_targets), f.id);
  if (merge) {
    return {
      draft: { title: merge.title, description: buildCommentBody(f), priority: PRIORITY_BY_SEVERITY[f.severity] },
      mode: 'comment',
      existing: { linear_identifier: merge.linear_identifier ?? '', linear_url: merge.linear_url ?? '' },
    };
  }
  return { draft: buildTicketDraft(f, ticketContext(f, today), 'manual'), mode: 'create', existing: null };
}

/**
 * File one finding: comment on a matching filed ticket, or create a new one. On failure the finding stays 'new' with file_error set.
 * A second call for a finding that is still being filed throws FilingInProgressError before touching Linear.
 */
export async function fileFinding(findingId: number, opts: FileOptions): Promise<VendorFindingRow> {
  const f = mustGet(findingId);
  if (f.status !== 'new') throw new Error(`Finding ${findingId} is already ${f.status}`);
  const apiKey = getSettings().linear_api_key;
  const config = getWatchConfig();
  if (filing.has(f.id)) throw new FilingInProgressError(f.id);
  filing.add(f.id);
  try {
    const merge = findMergeTarget(f.piece_name, f.kind, parseTargets(f.affected_targets), f.id);
    if (merge?.linear_issue_id) {
      await addLinearComment(apiKey, merge.linear_issue_id, opts.override?.description?.trim() || buildCommentBody(f), opts.query);
      return markFindingFiled(f.id, {
        filed_by: opts.filedBy, linear_issue_id: merge.linear_issue_id,
        linear_identifier: merge.linear_identifier ?? '', linear_url: merge.linear_url ?? '',
      });
    }
    const targets = await resolveLinearTargets(apiKey, config.linear_team_key, config.linear_label, opts.query);
    const base = buildTicketDraft(f, ticketContext(f, opts.today ?? new Date()), opts.filedBy);
    const issue = await createLinearIssue(apiKey, targets, {
      title: opts.override?.title?.trim() || base.title,
      description: opts.override?.description?.trim() || base.description,
      priority: opts.override?.priority ?? base.priority,
    }, opts.query);
    return markFindingFiled(f.id, {
      filed_by: opts.filedBy, linear_issue_id: issue.id, linear_identifier: issue.identifier, linear_url: issue.url,
    });
  } catch (err: any) {
    setFindingFileError(f.id, err?.message || String(err));
    throw err;
  } finally {
    filing.delete(f.id);
  }
}

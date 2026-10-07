import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { updateSettings } from '../../db/queries.js';
import { beginPlanGeneration, completePlanGeneration, insertFinding, getFinding, replaceSources } from '../../db/vendor-watch-queries.js';
import { resetVendorWatch, samplePlanResult, sampleDraft } from '../../db/vendor-watch-test-utils.js';
import { clearLinearTargetCache, type LinearQueryFn } from './linear-filer.js';
import { fileFinding, previewFiling } from './filing.js';

function fakeLinear(opts: { label?: boolean } = {}) {
  const calls: { op: string; variables: any }[] = [];
  const q = (async (_key: string, query: string, variables: any = {}) => {
    const op = ['VendorWatchTeam', 'VendorWatchLabel', 'VendorWatchCreateIssue', 'VendorWatchComment'].find(n => query.includes(n))!;
    calls.push({ op, variables });
    if (op === 'VendorWatchTeam') return { teams: { nodes: [{ id: 'team-1', key: 'PIE', states: { nodes: [{ id: 'st-t', name: 'Triage', type: 'triage' }] } }] } };
    if (op === 'VendorWatchLabel') return { issueLabels: { nodes: opts.label === false ? [] : [{ id: 'lab-1', name: 'vendor-watch', team: { id: 'team-1' } }] } };
    if (op === 'VendorWatchCreateIssue') return { issueCreate: { success: true, issue: { id: 'iss-1', identifier: 'PIE-900', url: 'https://linear.app/x/PIE-900' } } };
    return { commentCreate: { success: true } };
  }) as unknown as LinearQueryFn;
  return { q, calls };
}

function setup() {
  const p = beginPlanGeneration('@activepieces/piece-acme');
  const plan = completePlanGeneration(p.id, samplePlanResult());
  const [src] = replaceSources(plan.id, [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'Acme changelog' }]);
  const add = (signature: string, over = {}) =>
    insertFinding({ plan_id: plan.id, piece_name: plan.piece_name, source_id: src.id, run_id: null, draft: sampleDraft({ signature, ...over }) })!;
  return { plan, add };
}

describe('fileFinding', () => {
  beforeEach(() => { resetVendorWatch(); clearLinearTargetCache(); updateSettings({ linear_api_key: 'lin_test' }); });
  afterEach(() => updateSettings({ linear_api_key: '' }));

  it('creates a ticket and marks the finding filed', async () => {
    const { add } = setup();
    const f = add('a');
    const { q, calls } = fakeLinear();
    const filed = await fileFinding(f.id, { filedBy: 'auto', query: q });
    expect(filed).toMatchObject({ status: 'filed', filed_by: 'auto', linear_identifier: 'PIE-900', linear_issue_id: 'iss-1', file_error: '' });
    const create = calls.find(c => c.op === 'VendorWatchCreateIssue')!;
    expect(create.variables.input).toMatchObject({ teamId: 'team-1', stateId: 'st-t', labelIds: ['lab-1'], priority: 2 });
    expect(create.variables.input.title).toBe('Acme: Messages v1 is deprecated');
    expect(create.variables.input.description).toContain('Source: [Acme changelog](https://acme.dev/changelog)');
  });

  it('comments on the open ticket for an overlapping finding of the same kind', async () => {
    const { add } = setup();
    const { q, calls } = fakeLinear();
    await fileFinding(add('a').id, { filedBy: 'auto', query: q });
    const second = await fileFinding(add('b').id, { filedBy: 'manual', query: q });
    expect(second).toMatchObject({ status: 'filed', linear_identifier: 'PIE-900', filed_by: 'manual' });
    expect(calls.filter(c => c.op === 'VendorWatchCreateIssue')).toHaveLength(1);
    expect(calls.find(c => c.op === 'VendorWatchComment')!.variables.input.issueId).toBe('iss-1');
  });

  it('uses the edited title, description and priority from the inbox', async () => {
    const { add } = setup();
    const { q, calls } = fakeLinear();
    await fileFinding(add('a').id, { filedBy: 'manual', query: q, override: { title: 'Edited', description: 'Body', priority: 1 } });
    expect(calls.find(c => c.op === 'VendorWatchCreateIssue')!.variables.input).toMatchObject({ title: 'Edited', description: 'Body', priority: 1 });
  });

  it('leaves the finding new with file_error when filing fails', async () => {
    const { add } = setup();
    const f = add('a');
    await expect(fileFinding(f.id, { filedBy: 'auto', query: fakeLinear({ label: false }).q })).rejects.toThrow(/not found in PIE/);
    expect(getFinding(f.id)).toMatchObject({ status: 'new' });
    expect(getFinding(f.id)!.file_error).toContain("Label 'vendor-watch' not found");
    await expect(fileFinding(f.id, { filedBy: 'manual', query: fakeLinear().q })).resolves.toMatchObject({ status: 'filed', file_error: '' });
  });

  it('refuses a second concurrent filing of the same finding before it reaches Linear', async () => {
    const { add } = setup();
    const f = add('a');
    const { q, calls } = fakeLinear();
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const gated = (async (...args: Parameters<LinearQueryFn>) => { await gate; return q(...args); }) as LinearQueryFn;
    const first = fileFinding(f.id, { filedBy: 'auto', query: gated });
    const second = fileFinding(f.id, { filedBy: 'manual', query: gated });
    open();
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a).toMatchObject({ status: 'fulfilled', value: { status: 'filed', filed_by: 'auto', file_error: '' } });
    expect(b).toMatchObject({ status: 'rejected', reason: { message: `Finding ${f.id} is already being filed` } });
    expect(calls.map(c => c.op)).toEqual(['VendorWatchTeam', 'VendorWatchLabel', 'VendorWatchCreateIssue']);
  });

  it('refuses a finding that is not new', async () => {
    const { add } = setup();
    const f = add('a');
    const { q } = fakeLinear();
    await fileFinding(f.id, { filedBy: 'auto', query: q });
    await expect(fileFinding(f.id, { filedBy: 'manual', query: q })).rejects.toThrow(/already filed/);
  });
});

describe('previewFiling', () => {
  beforeEach(() => { resetVendorWatch(); clearLinearTargetCache(); updateSettings({ linear_api_key: 'lin_test' }); });
  afterEach(() => updateSettings({ linear_api_key: '' }));

  it('shows a create draft, then a comment draft once a matching ticket exists', async () => {
    const { add } = setup();
    const first = add('a');
    expect(previewFiling(first.id)).toMatchObject({ mode: 'create', existing: null });
    await fileFinding(first.id, { filedBy: 'auto', query: fakeLinear().q });
    const p = previewFiling(add('b').id);
    expect(p.mode).toBe('comment');
    expect(p.existing).toEqual({ linear_identifier: 'PIE-900', linear_url: 'https://linear.app/x/PIE-900' });
    expect(p.draft.description).toContain('Vendor watch saw this again');
  });
});

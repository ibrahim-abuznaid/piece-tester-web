import { describe, it, expect, beforeEach } from 'vitest';
import { resolveLinearTargets, createLinearIssue, addLinearComment, clearLinearTargetCache, type LinearQueryFn } from './linear-filer.js';

type Handler = (variables: any) => unknown;

function fakeLinear(handlers: Record<string, Handler>) {
  const calls: { op: string; variables: any }[] = [];
  const q = (async (_key: string, query: string, variables: any = {}) => {
    const op = Object.keys(handlers).find(name => query.includes(name));
    if (!op) throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    calls.push({ op, variables });
    return handlers[op](variables);
  }) as unknown as LinearQueryFn;
  return { q, calls };
}

const team = { teams: { nodes: [{ id: 'team-1', key: 'PIE', states: { nodes: [
  { id: 'st-b', name: 'Backlog', type: 'backlog' }, { id: 'st-t', name: 'Triage', type: 'triage' },
] } }] } };

describe('resolveLinearTargets', () => {
  beforeEach(clearLinearTargetCache);

  it('picks the triage state and prefers the team label over a workspace label', async () => {
    const { q } = fakeLinear({
      VendorWatchTeam: () => team,
      VendorWatchLabel: () => ({ issueLabels: { nodes: [
        { id: 'lab-ws', name: 'vendor-watch', team: null },
        { id: 'lab-other', name: 'vendor-watch', team: { id: 'team-9' } },
        { id: 'lab-team', name: 'vendor-watch', team: { id: 'team-1' } },
      ] } }),
    });
    expect(await resolveLinearTargets('k', 'PIE', 'vendor-watch', q)).toEqual({
      teamId: 'team-1', stateId: 'st-t', stateName: 'Triage', labelId: 'lab-team', labelName: 'vendor-watch',
    });
  });

  it('falls back to backlog and to a workspace label', async () => {
    const { q } = fakeLinear({
      VendorWatchTeam: () => ({ teams: { nodes: [{ id: 'team-1', key: 'PIE', states: { nodes: [{ id: 'st-b', name: 'Backlog', type: 'backlog' }] } }] } }),
      VendorWatchLabel: () => ({ issueLabels: { nodes: [{ id: 'lab-ws', name: 'vendor-watch', team: null }] } }),
    });
    const t = await resolveLinearTargets('k', 'PIE', 'vendor-watch', q);
    expect(t).toMatchObject({ stateId: 'st-b', labelId: 'lab-ws' });
  });

  it('says exactly what is missing', async () => {
    const noLabel = fakeLinear({ VendorWatchTeam: () => team, VendorWatchLabel: () => ({ issueLabels: { nodes: [] } }) });
    await expect(resolveLinearTargets('k', 'PIE', 'vendor-watch', noLabel.q)).rejects.toThrow("Label 'vendor-watch' not found in PIE — create it in Linear");
    clearLinearTargetCache();
    const noTeam = fakeLinear({ VendorWatchTeam: () => ({ teams: { nodes: [] } }) });
    await expect(resolveLinearTargets('k', 'NOPE', 'vendor-watch', noTeam.q)).rejects.toThrow("Linear team 'NOPE' not found");
    await expect(resolveLinearTargets('', 'PIE', 'vendor-watch', noTeam.q)).rejects.toThrow(/No Linear API key/);
  });

  it('caches the answer for an hour', async () => {
    const { q, calls } = fakeLinear({
      VendorWatchTeam: () => team,
      VendorWatchLabel: () => ({ issueLabels: { nodes: [{ id: 'lab-ws', name: 'vendor-watch', team: null }] } }),
    });
    await resolveLinearTargets('k', 'PIE', 'vendor-watch', q, 1_000);
    await resolveLinearTargets('k', 'PIE', 'vendor-watch', q, 1_000 + 59 * 60_000);
    expect(calls).toHaveLength(2);
    await resolveLinearTargets('k', 'PIE', 'vendor-watch', q, 1_000 + 61 * 60_000);
    expect(calls).toHaveLength(4);
  });
});

describe('createLinearIssue / addLinearComment', () => {
  const targets = { teamId: 'team-1', stateId: 'st-t', stateName: 'Triage', labelId: 'lab-1', labelName: 'vendor-watch' };

  it('creates the issue in the triage state with only the vendor-watch label', async () => {
    const { q, calls } = fakeLinear({
      VendorWatchCreateIssue: () => ({ issueCreate: { success: true, issue: { id: 'iss-1', identifier: 'PIE-900', url: 'https://linear.app/x/PIE-900' } } }),
    });
    const issue = await createLinearIssue('k', targets, { title: 'T', description: 'D', priority: 2 }, q);
    expect(issue).toEqual({ id: 'iss-1', identifier: 'PIE-900', url: 'https://linear.app/x/PIE-900' });
    expect(calls[0].variables.input).toEqual({ teamId: 'team-1', stateId: 'st-t', labelIds: ['lab-1'], title: 'T', description: 'D', priority: 2 });
  });

  it('throws when Linear reports no success', async () => {
    const { q } = fakeLinear({ VendorWatchCreateIssue: () => ({ issueCreate: { success: false, issue: null } }) });
    await expect(createLinearIssue('k', targets, { title: 'T', description: 'D', priority: 2 }, q)).rejects.toThrow(/did not create/);
  });

  it('adds a comment', async () => {
    const { q, calls } = fakeLinear({ VendorWatchComment: () => ({ commentCreate: { success: true } }) });
    await addLinearComment('k', 'iss-1', 'again', q);
    expect(calls[0].variables.input).toEqual({ issueId: 'iss-1', body: 'again' });
  });
});

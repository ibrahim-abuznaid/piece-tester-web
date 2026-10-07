import { linearQuery, LinearError } from '../bug-trend/linear-client.js';

export type LinearQueryFn = <T>(apiKey: string, query: string, variables?: Record<string, unknown>) => Promise<T>;

export interface LinearTargets {
  teamId: string;
  stateId: string;
  stateName: string;
  labelId: string;
  labelName: string;
}

export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
}

const TEAM_QUERY = `query VendorWatchTeam($key: String!) {
  teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type } } } }
}`;

const LABEL_QUERY = `query VendorWatchLabel($name: String!) {
  issueLabels(filter: { name: { eq: $name } }) { nodes { id name team { id } } }
}`;

const CREATE_ISSUE = `mutation VendorWatchCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

const CREATE_COMMENT = `mutation VendorWatchComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; targets: LinearTargets }>();

export function clearLinearTargetCache(): void {
  cache.clear();
}

/** Team id, its Triage state (else Backlog), and the label by exact name (team label first, then workspace). */
export async function resolveLinearTargets(
  apiKey: string, teamKey: string, labelName: string, q: LinearQueryFn = linearQuery, now = Date.now(),
): Promise<LinearTargets> {
  if (!apiKey) throw new LinearError('No Linear API key saved. Add one in Settings (Bug Trend card).');
  const key = `${teamKey}|${labelName}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.targets;

  const t = await q<{ teams: { nodes: { id: string; states: { nodes: { id: string; name: string; type: string }[] } }[] } }>(
    apiKey, TEAM_QUERY, { key: teamKey });
  const team = t.teams.nodes[0];
  if (!team) throw new LinearError(`Linear team '${teamKey}' not found`);
  const state = team.states.nodes.find(s => s.type === 'triage') ?? team.states.nodes.find(s => s.type === 'backlog');
  if (!state) throw new LinearError(`Linear team '${teamKey}' has no Triage or Backlog state`);

  const l = await q<{ issueLabels: { nodes: { id: string; name: string; team: { id: string } | null }[] } }>(
    apiKey, LABEL_QUERY, { name: labelName });
  const label = l.issueLabels.nodes.find(n => n.team?.id === team.id) ?? l.issueLabels.nodes.find(n => !n.team);
  if (!label) throw new LinearError(`Label '${labelName}' not found in ${teamKey} — create it in Linear`);

  const targets = { teamId: team.id, stateId: state.id, stateName: state.name, labelId: label.id, labelName: label.name };
  cache.set(key, { at: now, targets });
  return targets;
}

export async function createLinearIssue(
  apiKey: string, targets: LinearTargets, issue: { title: string; description: string; priority: number }, q: LinearQueryFn = linearQuery,
): Promise<CreatedIssue> {
  const r = await q<{ issueCreate: { success: boolean; issue: CreatedIssue | null } }>(apiKey, CREATE_ISSUE, {
    input: {
      teamId: targets.teamId, stateId: targets.stateId, labelIds: [targets.labelId],
      title: issue.title, description: issue.description, priority: issue.priority,
    },
  });
  if (!r.issueCreate.success || !r.issueCreate.issue) throw new LinearError('Linear did not create the issue');
  return r.issueCreate.issue;
}

export async function addLinearComment(apiKey: string, issueId: string, body: string, q: LinearQueryFn = linearQuery): Promise<void> {
  const r = await q<{ commentCreate: { success: boolean } }>(apiKey, CREATE_COMMENT, { input: { issueId, body } });
  if (!r.commentCreate.success) throw new LinearError('Linear did not add the comment');
}

import axios from 'axios';
import { classifySource, LINEAR_LABELS, LINEAR_TEAMS, type TrackedBug } from './bug-trend.js';
import type { LinearUser } from './roster.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 50;

export class LinearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearError';
  }
}

export interface TrackedBugsResult {
  bugs: TrackedBug[];
  matched: { GIT: number; PIE: number };
}

interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

interface RawIssue {
  identifier: string;
  title: string;
  url: string;
  createdAt: string;
  completedAt: string | null;
  trashed?: boolean | null;
  state: { type: string } | null;
  team: { key: string } | null;
  assignee: { id: string; name: string } | null;
  labels: { nodes: { name: string }[] } | null;
}

const ISSUES_QUERY = `query TrackedBugs($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: 100, after: $after, includeArchived: true) {
    nodes {
      identifier title url createdAt completedAt trashed
      state { type }
      team { key }
      assignee { id name }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const USERS_QUERY = `query ActiveUsers($after: String) {
  users(first: 100, after: $after) {
    nodes { id name displayName active }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Personal API keys go in Authorization as-is (no Bearer). Error messages never include the key. */
async function linearQuery<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let res;
  try {
    res = await axios.post(LINEAR_GRAPHQL_URL, { query, variables }, {
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (err: any) {
    throw new LinearError(`Couldn't reach Linear: ${err?.code || err?.message || 'network error'}`);
  }
  if (res.status === 401 || res.status === 403) throw new LinearError('Linear rejected the API key');
  const errors = res.data?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    if (errors[0]?.extensions?.code === 'AUTHENTICATION_ERROR') throw new LinearError('Linear rejected the API key');
    throw new LinearError(String(errors[0]?.message || 'Linear returned an error'));
  }
  if (res.status >= 400 || !res.data?.data) throw new LinearError(`Linear request failed (HTTP ${res.status})`);
  return res.data.data as T;
}

async function fetchAllPages<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: any) => Connection<T>,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
    const conn = pick(await linearQuery(apiKey, query, { ...variables, after }));
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new LinearError(`Stopped after ${MAX_PAGES} pages of Linear results`);
}

function normalizeIssue(n: RawIssue): TrackedBug | null {
  if (n.trashed || n.state?.type === 'canceled') return null;
  return {
    identifier: n.identifier,
    title: n.title,
    url: n.url,
    team: n.team?.key === LINEAR_TEAMS.pie ? 'PIE' : 'GIT',
    source: classifySource((n.labels?.nodes ?? []).map(l => l.name)),
    assigneeName: n.assignee?.name ?? null,
    createdAt: n.createdAt,
    completedAt: n.completedAt ?? null,
  };
}

export async function fetchTrackedBugs(apiKey: string, rosterIds: string[]): Promise<TrackedBugsResult> {
  const issues = (filter: Record<string, unknown>) =>
    fetchAllPages<RawIssue>(apiKey, ISSUES_QUERY, { filter }, d => d.issues);
  const git = rosterIds.length === 0 ? [] : await issues({
    team: { key: { eq: LINEAR_TEAMS.git } },
    labels: { some: { name: { eq: LINEAR_LABELS.gitBug } } },
    assignee: { id: { in: rosterIds } },
  });
  const pie = await issues({
    team: { key: { eq: LINEAR_TEAMS.pie } },
    labels: { some: { name: { eq: LINEAR_LABELS.pieTester } } },
  });
  const bugs = [...git, ...pie].map(normalizeIssue).filter((b): b is TrackedBug => b !== null);
  return { bugs, matched: { GIT: git.length, PIE: pie.length } };
}

export async function fetchViewer(apiKey: string): Promise<{ id: string; name: string }> {
  const data = await linearQuery<{ viewer: { id: string; name: string } }>(apiKey, 'query { viewer { id name } }');
  return data.viewer;
}

export async function fetchActiveUsers(apiKey: string): Promise<LinearUser[]> {
  const users = await fetchAllPages<LinearUser & { active: boolean }>(apiKey, USERS_QUERY, {}, d => d.users);
  return users.filter(u => u.active).map(({ id, name, displayName }) => ({ id, name, displayName }));
}

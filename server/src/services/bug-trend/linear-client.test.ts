import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn() } }));

import axios from 'axios';
import { fetchTrackedBugs, fetchViewer, fetchActiveUsers, LinearError } from './linear-client.js';

// Cast so tests can resolve partial { status, data } objects instead of full AxiosResponses.
const post = axios.post as unknown as Mock;
const KEY = 'lin_api_TESTKEYDONOTLEAK';

function issue(p: Record<string, unknown> = {}) {
  return {
    identifier: 'GIT-1', title: 'Broken', url: 'https://linear.app/x/issue/GIT-1',
    createdAt: '2026-09-01T10:00:00.000Z', completedAt: null,
    state: { type: 'started' }, team: { key: 'GIT' },
    assignee: { id: 'u-kishan', name: 'Kishan Parmar' },
    labels: { nodes: [{ name: '🐛 bug' }] },
    ...p,
  };
}
function page(nodes: unknown[], endCursor: string | null = null) {
  return { status: 200, data: { data: { issues: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } } } };
}

beforeEach(() => post.mockReset());

describe('fetchTrackedBugs', () => {
  it('follows endCursor across pages, then queries PIE', async () => {
    post
      .mockResolvedValueOnce(page([issue({ identifier: 'GIT-1' })], 'c1'))
      .mockResolvedValueOnce(page([issue({ identifier: 'GIT-2' })]))
      .mockResolvedValueOnce(page([issue({ identifier: 'PIE-9', team: { key: 'PIE' }, labels: { nodes: [{ name: 'piece-tester' }] } })]));
    const r = await fetchTrackedBugs(KEY, ['u-kishan']);
    expect(r.bugs.map(b => b.identifier)).toEqual(['GIT-1', 'GIT-2', 'PIE-9']);
    expect((post.mock.calls[0][1] as any).variables.after).toBeNull();
    expect((post.mock.calls[1][1] as any).variables.after).toBe('c1');
    expect(r.matched).toEqual({ GIT: 2, PIE: 1 });
  });

  it('sends the key without Bearer, asks for archived issues, and filters GIT by label and roster', async () => {
    post.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([]));
    await fetchTrackedBugs(KEY, ['u-kishan', 'u-sanket']);
    const [url, body, config] = post.mock.calls[0] as any[];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(config.headers.Authorization).toBe(KEY);
    expect(body.query).toContain('includeArchived: true');
    expect(body.variables.filter).toEqual({
      team: { key: { eq: 'GIT' } },
      labels: { some: { name: { eq: '🐛 bug' } } },
      assignee: { id: { in: ['u-kishan', 'u-sanket'] } },
    });
    expect((post.mock.calls[1][1] as any).variables.filter).toEqual({
      team: { key: { eq: 'PIE' } },
      labels: { some: { name: { eq: 'piece-tester' } } },
    });
  });

  it('skips the GIT query when the roster is empty', async () => {
    post.mockResolvedValueOnce(page([]));
    const r = await fetchTrackedBugs(KEY, []);
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0][1] as any).variables.filter.team.key.eq).toBe('PIE');
    expect(r.matched).toEqual({ GIT: 0, PIE: 0 });
  });

  it('drops canceled issues, classifies the source, and keeps them in the matched count', async () => {
    post
      .mockResolvedValueOnce(page([
        issue({ identifier: 'GIT-1', labels: { nodes: [{ name: '🐛 bug' }, { name: '🛟 support' }] } }),
        issue({ identifier: 'GIT-2', state: { type: 'canceled' } }),
        issue({ identifier: 'GIT-3', assignee: null, completedAt: '2026-09-03T10:00:00.000Z' }),
      ]))
      .mockResolvedValueOnce(page([]));
    const r = await fetchTrackedBugs(KEY, ['u-kishan']);
    expect(r.bugs).toEqual([
      { identifier: 'GIT-1', title: 'Broken', url: 'https://linear.app/x/issue/GIT-1', team: 'GIT', source: 'support',
        assigneeName: 'Kishan Parmar', createdAt: '2026-09-01T10:00:00.000Z', completedAt: null },
      { identifier: 'GIT-3', title: 'Broken', url: 'https://linear.app/x/issue/GIT-1', team: 'GIT', source: 'internal',
        assigneeName: null, createdAt: '2026-09-01T10:00:00.000Z', completedAt: '2026-09-03T10:00:00.000Z' },
    ]);
    expect(r.matched.GIT).toBe(3);
  });
});

describe('Linear errors', () => {
  const expectLinearError = async (p: Promise<unknown>, message: string) => {
    const err = await p.then(() => null, e => e);
    expect(err).toBeInstanceOf(LinearError);
    expect(err.message).toBe(message);
    expect(err.message).not.toContain(KEY);
  };

  it('maps HTTP 401 to a rejected-key error', async () => {
    post.mockResolvedValueOnce({ status: 401, data: {} });
    await expectLinearError(fetchViewer(KEY), 'Linear rejected the API key');
  });

  it('maps an AUTHENTICATION_ERROR GraphQL error to a rejected-key error', async () => {
    post.mockResolvedValueOnce({ status: 400, data: { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] } });
    await expectLinearError(fetchViewer(KEY), 'Linear rejected the API key');
  });

  it('surfaces the first GraphQL error message', async () => {
    post.mockResolvedValueOnce({ status: 200, data: { errors: [{ message: 'Query too complex' }] } });
    await expectLinearError(fetchViewer(KEY), 'Query too complex');
  });

  it('wraps network failures', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await expectLinearError(fetchViewer(KEY), "Couldn't reach Linear: ECONNRESET");
  });
});

describe('fetchViewer / fetchActiveUsers', () => {
  it('returns the viewer', async () => {
    post.mockResolvedValueOnce({ status: 200, data: { data: { viewer: { id: 'u-ibrahim', name: 'Ibrahim Abu Znaid' } } } });
    expect(await fetchViewer(KEY)).toEqual({ id: 'u-ibrahim', name: 'Ibrahim Abu Znaid' });
  });

  it('returns only active users, without the active flag', async () => {
    post.mockResolvedValueOnce({ status: 200, data: { data: { users: {
      nodes: [
        { id: 'u1', name: 'A', displayName: 'a', active: true },
        { id: 'u2', name: 'B', displayName: 'b', active: false },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
    expect(await fetchActiveUsers(KEY)).toEqual([{ id: 'u1', name: 'A', displayName: 'a' }]);
  });
});

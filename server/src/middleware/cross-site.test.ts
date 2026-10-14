import { describe, it, expect } from 'vitest';
import { rejectCrossSiteRequests } from './cross-site.js';

function run(path: string, secFetchSite?: string) {
  const req = { path, headers: secFetchSite ? { 'sec-fetch-site': secFetchSite } : {} } as any;
  const res = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
  };
  let nexted = false;
  rejectCrossSiteRequests(req, res as any, () => { nexted = true; });
  return { nexted, status: res.statusCode };
}

describe('rejectCrossSiteRequests', () => {
  it('blocks an API request another website triggered', () => {
    expect(run('/pieces/gmail/ai-plan', 'cross-site')).toEqual({ nexted: false, status: 403 });
  });

  it('lets the app call its own API', () => {
    expect(run('/pieces/gmail/ai-plan', 'same-origin').nexted).toBe(true);
  });

  it('lets a typed URL or bookmark through', () => {
    expect(run('/settings/mcp-connect', 'none').nexted).toBe(true);
  });

  it('lets non-browser clients through (they send no Sec-Fetch-Site)', () => {
    expect(run('/coverage').nexted).toBe(true);
  });

  it('lets the MCP OAuth provider redirect back to the callback', () => {
    expect(run('/settings/mcp-callback', 'cross-site').nexted).toBe(true);
  });
});

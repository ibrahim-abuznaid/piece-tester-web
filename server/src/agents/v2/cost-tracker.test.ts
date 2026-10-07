import { describe, it, expect } from 'vitest';
import { webSearchCost, WEB_SEARCH_COST_USD } from './cost-tracker.js';

describe('webSearchCost', () => {
  it('charges per web search request', () => {
    expect(WEB_SEARCH_COST_USD).toBe(0.01);
    expect(webSearchCost({ usage: { server_tool_use: { web_search_requests: 3 } } })).toBeCloseTo(0.03);
    expect(webSearchCost({ usage: {} })).toBe(0);
    expect(webSearchCost(undefined)).toBe(0);
  });
});

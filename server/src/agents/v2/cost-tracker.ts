/**
 * AI cost tracking for both v1 and v2 agent systems.
 *
 * Captures token usage from Claude API responses and calculates costs
 * based on per-model pricing. Logs to the ai_usage_logs DB table.
 */

import { logAiUsage } from '../../db/queries.js';
import { randomUUID } from 'crypto';

// Pricing per million tokens (as of 2026-04)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6':        { input: 3.0,  output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-sonnet-4-5-20250929': { input: 3.0,  output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-opus-4':            { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-haiku-3-5':         { input: 0.80, output: 4.0,  cacheWrite: 1.0,  cacheRead: 0.08 },
};

const DEFAULT_PRICING = { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  const cacheWriteCost = (usage.cache_creation_input_tokens / 1_000_000) * pricing.cacheWrite;
  const cacheReadCost = (usage.cache_read_input_tokens / 1_000_000) * pricing.cacheRead;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

/** Extract token usage from a Claude API response. */
export function extractUsage(response: any): TokenUsage {
  const u = response?.usage || {};
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
  };
}

/**
 * Session-scoped cost tracker.
 * Create one per plan-creation or fix session to aggregate costs.
 */
export class CostTracker {
  readonly sessionId: string;
  private pieceName: string;
  private actionName: string;
  private operation: string;
  private version: string;

  private totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  private totalCost = 0;
  private requestCount = 0;

  constructor(params: {
    pieceName: string;
    actionName: string;
    operation: string;
    version: string;
    sessionId?: string;
  }) {
    this.sessionId = params.sessionId || randomUUID();
    this.pieceName = params.pieceName;
    this.actionName = params.actionName;
    this.operation = params.operation;
    this.version = params.version;
  }

  /** Log a single API call's usage. Call after each messages.create(). */
  trackResponse(model: string, response: any, agentRole: string): void {
    const usage = extractUsage(response);
    const cost = calculateCost(model, usage);

    this.totalUsage.input_tokens += usage.input_tokens;
    this.totalUsage.output_tokens += usage.output_tokens;
    this.totalUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    this.totalUsage.cache_read_input_tokens += usage.cache_read_input_tokens;
    this.totalCost += cost;
    this.requestCount++;

    try {
      logAiUsage({
        session_id: this.sessionId,
        piece_name: this.pieceName,
        action_name: this.actionName,
        agent_role: agentRole,
        agent_version: this.version,
        model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cost_usd: cost,
        operation: this.operation,
      });
    } catch {
      // Non-critical: don't fail the agent if logging fails
    }
  }

  /** Get aggregated totals for this session. */
  getTotals() {
    return {
      sessionId: this.sessionId,
      ...this.totalUsage,
      cost_usd: this.totalCost,
      requests: this.requestCount,
    };
  }
}

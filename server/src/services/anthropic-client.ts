/**
 * Bounded Anthropic client options shared by every LLM call in the app.
 *
 * The SDK defaults are a 10-minute per-attempt timeout and 2 retries, so one
 * stalled `messages.create` can silently block for ~30 minutes before it throws
 * (10 min × 3 attempts). Several call sites (notably the batch-setup plan
 * generation path) never thread an abortSignal through, so this per-attempt
 * timeout is the ONLY guard against a single hung call stalling everything.
 *
 * We bound it to 5 minutes per attempt with a single retry (worst case ~10 min).
 * 5 minutes is comfortably above a full-length non-streaming response (the SDK's
 * own estimate treats anything under ~21k tokens as fitting its 10-min ceiling),
 * so legitimate slow generations are not clipped, while a true stall fails fast.
 * One retry keeps resilience to transient 429/529 overload without fanning back
 * out toward the 30-minute worst case.
 */
export const ANTHROPIC_TIMEOUT_MS = 5 * 60_000;
export const ANTHROPIC_MAX_RETRIES = 1;

export interface AnthropicClientOptions {
  apiKey: string;
  timeout: number;
  maxRetries: number;
}

export function buildAnthropicClientOptions(apiKey: string): AnthropicClientOptions {
  return {
    apiKey,
    timeout: ANTHROPIC_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
  };
}

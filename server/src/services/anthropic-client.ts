import type Anthropic from '@anthropic-ai/sdk';

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

/** Model every LLM call uses unless Settings or a worker picks another. */
export const DEFAULT_AI_MODEL = 'claude-sonnet-5-5';

export type Effort = 'low' | 'medium' | 'high';

const EFFORT_MODELS = /^claude-(opus-4-[5-9]|sonnet-4-6|(opus|sonnet|haiku|fable)-5)/;

/**
 * `output_config.effort` for models that take it, nothing for the rest.
 * Sonnet 5.5 thinks by default and its default effort is `high`, so callers
 * pick a lower level on purpose. Sonnet 4.5 and Haiku 4.5 reject the field,
 * so it is left off for them.
 */
export function effortFor(model: string, effort: Effort): Pick<Anthropic.MessageCreateParamsNonStreaming, 'output_config'> {
  return EFFORT_MODELS.test(model) ? { output_config: { effort } } : {};
}

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

/** The one SDK surface the agent runner and the vendor-watch classifier use. Lets tests inject a fake. */
export type MessagesClient = {
  messages: {
    create: (body: Anthropic.MessageCreateParamsNonStreaming, opts?: Anthropic.RequestOptions) => Promise<Anthropic.Message>;
  };
};

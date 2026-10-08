import { describe, it, expect } from 'vitest';
import {
  buildAnthropicClientOptions,
  effortFor,
  ANTHROPIC_TIMEOUT_MS,
  ANTHROPIC_MAX_RETRIES,
  DEFAULT_AI_MODEL,
} from './anthropic-client.js';

const SDK_DEFAULT_TIMEOUT_MS = 10 * 60_000; // Anthropic SDK default: 10 min/attempt
const SDK_DEFAULT_MAX_RETRIES = 2;
const FULL_RESPONSE_HEADROOM_MS = 3 * 60_000; // a full-length response can take ~3 min

describe('bounded Anthropic client options', () => {
  it('passes the api key through unchanged', () => {
    expect(buildAnthropicClientOptions('sk-abc').apiKey).toBe('sk-abc');
  });

  it('bounds the per-attempt timeout below the SDK 10-min default', () => {
    const { timeout } = buildAnthropicClientOptions('sk-test');
    expect(timeout).toBe(ANTHROPIC_TIMEOUT_MS);
    expect(timeout).toBeLessThan(SDK_DEFAULT_TIMEOUT_MS);
  });

  it('leaves headroom for a full-length response so legit slow calls are not clipped', () => {
    const { timeout } = buildAnthropicClientOptions('sk-test');
    expect(timeout).toBeGreaterThanOrEqual(FULL_RESPONSE_HEADROOM_MS);
  });

  it('limits retries below the SDK default so a stall cannot fan out to ~30 min', () => {
    const { maxRetries } = buildAnthropicClientOptions('sk-test');
    expect(maxRetries).toBe(ANTHROPIC_MAX_RETRIES);
    expect(maxRetries).toBeLessThan(SDK_DEFAULT_MAX_RETRIES);
  });

  it('keeps worst-case wall time (timeout × attempts) far below the 30-min default', () => {
    const { timeout, maxRetries } = buildAnthropicClientOptions('sk-test');
    const worstCaseMs = timeout * (1 + maxRetries);
    const sdkWorstCaseMs = SDK_DEFAULT_TIMEOUT_MS * (1 + SDK_DEFAULT_MAX_RETRIES); // 30 min
    expect(worstCaseMs).toBeLessThan(sdkWorstCaseMs / 2); // well under half the old ceiling
  });
});

describe('effortFor', () => {
  it('sets effort on the default model', () => {
    expect(DEFAULT_AI_MODEL).toBe('claude-sonnet-5-5');
    expect(effortFor(DEFAULT_AI_MODEL, 'medium')).toEqual({ output_config: { effort: 'medium' } });
  });

  it('sets effort on the other models that take it', () => {
    for (const model of ['claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-8', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
      expect(effortFor(model, 'low')).toEqual({ output_config: { effort: 'low' } });
    }
  });

  it('leaves effort off for models that reject it', () => {
    for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-haiku-3-5']) {
      expect(effortFor(model, 'low')).toEqual({});
    }
  });
});

import type { StepResult } from './plan-executor.js';

export const MAX_STRING_CHARS = 8 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;

function capStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}…[truncated, ${value.length} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map(capStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capStrings(v)]));
  }
  return value;
}

function capOutput(output: unknown): unknown {
  const capped = capStrings(output);
  const json = JSON.stringify(capped);
  if (json === undefined || json.length <= MAX_OUTPUT_BYTES) return capped;
  return { truncated: true, bytes: json.length, preview: json.slice(0, MAX_OUTPUT_BYTES) };
}

/** The one path from in-memory step results to the stored JSON. Memory keeps the full values. */
export function serializeStepResults(steps: StepResult[]): string {
  return JSON.stringify(steps.map(({ output, ...rest }) => ({ ...(capStrings(rest) as object), output: capOutput(output) })));
}

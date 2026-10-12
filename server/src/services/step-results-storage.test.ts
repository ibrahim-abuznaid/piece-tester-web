import { describe, it, expect } from 'vitest';
import { serializeStepResults, MAX_STRING_CHARS, MAX_OUTPUT_BYTES } from './step-results-storage.js';
import type { StepResult } from './plan-executor.js';

const step = (over: Partial<StepResult> = {}): StepResult => ({
  stepId: 's1', label: 'Step', status: 'completed', output: { id: 1 }, error: null, duration_ms: 10, ...over,
});

describe('serializeStepResults', () => {
  it('round-trips a small result unchanged', () => {
    const steps = [step(), step({ stepId: 's2', status: 'failed', output: null, error: 'boom', errorCategory: 'piece_error' })];
    expect(JSON.parse(serializeStepResults(steps))).toEqual(steps);
  });

  it('cuts a string longer than the limit and says so', () => {
    const long = 'x'.repeat(MAX_STRING_CHARS + 500);
    const [s] = JSON.parse(serializeStepResults([step({ output: { image: long } })]));
    expect(s.output.image.startsWith('x'.repeat(MAX_STRING_CHARS))).toBe(true);
    expect(s.output.image).toContain(`truncated, ${long.length} chars`);
    expect(s.output.image.length).toBeLessThan(MAX_STRING_CHARS + 100);
  });

  it('replaces an output that is still too large with a preview', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ i, text: 'y'.repeat(1000) }));
    const [s] = JSON.parse(serializeStepResults([step({ output: rows })]));
    expect(s.output.truncated).toBe(true);
    expect(s.output.bytes).toBe(JSON.stringify(rows).length);
    expect(s.output.preview.length).toBe(MAX_OUTPUT_BYTES);
    expect(s.status).toBe('completed');
  });

  it('does not change the in-memory step results', () => {
    const long = 'x'.repeat(MAX_STRING_CHARS + 1);
    const steps = [step({ output: { image: long } })];
    serializeStepResults(steps);
    expect((steps[0].output as any).image).toBe(long);
  });
});

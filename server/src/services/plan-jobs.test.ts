import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createJob, completeJob, cancelAllPlanJobs, getActiveJobCountsByPiece } from './plan-jobs.js';

beforeEach(() => { vi.useFakeTimers(); cancelAllPlanJobs(); });
afterEach(() => { vi.useRealTimers(); });

describe('getActiveJobCountsByPiece', () => {
  it('counts running jobs per piece', () => {
    createJob('@ap/piece-alpha', 'v2:a1');
    createJob('@ap/piece-alpha', 'v2:a2');
    createJob('@ap/piece-beta', 'v2:b1');

    const counts = getActiveJobCountsByPiece();
    expect(counts['@ap/piece-alpha']).toBe(2);
    expect(counts['@ap/piece-beta']).toBe(1);
  });

  it('does not count completed jobs', () => {
    const job = createJob('@ap/piece-gamma', 'v2:g1');
    expect(getActiveJobCountsByPiece()['@ap/piece-gamma']).toBe(1);

    completeJob(job, 'done');
    expect(getActiveJobCountsByPiece()['@ap/piece-gamma'] ?? 0).toBe(0);
  });
});

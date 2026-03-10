import { Router } from 'express';
import { listTestRuns, getTestRun, listTestResults, deleteTestRun, deleteAllTestRuns } from '../db/queries.js';

const router = Router();

// List past runs
router.get('/', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = parseInt(req.query.offset as string) || 0;
  const runs = listTestRuns(limit, offset);
  res.json(runs);
});

// Get a single run with results
router.get('/:runId', (req, res) => {
  const runId = parseInt(req.params.runId);
  const run = getTestRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const results = listTestResults(runId);
  res.json({ ...run, results });
});

// Delete all legacy runs (optionally before a date)
router.delete('/', (req, res) => {
  const before = req.query.before as string | undefined;
  const count = deleteAllTestRuns(before);
  res.json({ success: true, deleted: count });
});

// Delete a single legacy run (cascades to test_results)
router.delete('/:runId', (req, res) => {
  const ok = deleteTestRun(parseInt(req.params.runId));
  if (!ok) return res.status(404).json({ error: 'Run not found' });
  res.json({ success: true });
});

export default router;

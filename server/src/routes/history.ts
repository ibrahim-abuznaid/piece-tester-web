import { Router } from 'express';
import { listTestRuns, getTestRun, listTestResults } from '../db/queries.js';

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

export default router;

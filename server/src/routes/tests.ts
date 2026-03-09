import { Router } from 'express';
import { runTests } from '../services/test-engine.js';
import { getTestRun, listTestResults } from '../db/queries.js';

const router = Router();

// Run tests
router.post('/run', async (req, res) => {
  try {
    const pieceNames: string[] | undefined = req.body.pieceNames;
    const runId = await runTests(pieceNames);
    res.json({ runId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Poll status
router.get('/status/:runId', (req, res) => {
  const runId = parseInt(req.params.runId);
  const run = getTestRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const results = listTestResults(runId);
  res.json({ ...run, results });
});

export default router;

import { Router } from 'express';
import * as db from '../db/queries.js';
import { createClient } from '../services/test-engine.js';
import { ActivepiecesClient } from '../services/ap-client.js';
import { reloadScheduler } from '../services/scheduler.js';

const router = Router();

// Piece-centric coverage view over the whole AP catalog.
router.get('/', async (_req, res) => {
  try {
    const client = createClient();
    const catalog = await client.listPieces();
    res.json(db.getCoverage(catalog.map(p => ({
      name: p.name, displayName: p.displayName, logoUrl: p.logoUrl,
    }))));
  } catch (err) {
    res.status(500).json({ error: ActivepiecesClient.formatError(err) });
  }
});

// Add pieces to the schedule matching `cadence` (create it if needed).
router.post('/enroll', (req, res) => {
  const { piece_names, cadence } = req.body ?? {};
  if (!Array.isArray(piece_names) || piece_names.length === 0) {
    return res.status(400).json({ error: 'piece_names (non-empty array) is required' });
  }
  if (!cadence?.cron_expression) {
    return res.status(400).json({ error: 'cadence.cron_expression is required' });
  }
  db.enrollPieces(piece_names, cadence);
  reloadScheduler();
  res.json({ success: true });
});

// Remove pieces from continuous testing.
router.post('/unenroll', (req, res) => {
  const { piece_names } = req.body ?? {};
  if (!Array.isArray(piece_names) || piece_names.length === 0) {
    return res.status(400).json({ error: 'piece_names (non-empty array) is required' });
  }
  db.unenrollPieces(piece_names);
  reloadScheduler();
  res.json({ success: true });
});

// Move pieces to a different cadence.
router.post('/cadence', (req, res) => {
  const { piece_names, cadence } = req.body ?? {};
  if (!Array.isArray(piece_names) || piece_names.length === 0) {
    return res.status(400).json({ error: 'piece_names (non-empty array) is required' });
  }
  if (!cadence?.cron_expression) {
    return res.status(400).json({ error: 'cadence.cron_expression is required' });
  }
  db.setPiecesCadence(piece_names, cadence);
  reloadScheduler();
  res.json({ success: true });
});

export default router;

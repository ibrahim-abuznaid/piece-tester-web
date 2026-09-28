import { Router } from 'express';
import { getSettings } from '../db/queries.js';
import { bugTrendCache, resolveBugTrendRequest } from '../services/bug-trend/bug-trend-service.js';

const router = Router();

/** Bugs opened per week, open bugs per day and KPIs, built from Linear (15-min cache; refresh=1 bypasses it). */
router.get('/', async (req, res) => {
  const s = getSettings();
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
  const { status, body } = await resolveBugTrendRequest(bugTrendCache, {
    apiKey: s.linear_api_key,
    rosterJson: s.bug_trend_roster,
    from,
    refresh: req.query.refresh === '1',
    now: new Date(),
  });
  res.status(status).json(body);
});

export default router;

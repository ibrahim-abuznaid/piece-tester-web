import { Router } from 'express';
import * as db from '../db/queries.js';
import { reloadScheduler } from '../services/scheduler.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(db.listSchedules());
});

router.post('/', (req, res) => {
  const { piece_name, cron_expression, label, timezone, schedule_config, targets } = req.body;
  if (!cron_expression) return res.status(400).json({ error: 'cron_expression is required' });
  const schedule = db.createSchedule({
    piece_name: piece_name || undefined,
    cron_expression,
    label: label || '',
    timezone: timezone || 'UTC',
    schedule_config: schedule_config || '{}',
    targets: targets ? JSON.stringify(targets) : '[]',
  });
  reloadScheduler();
  res.status(201).json(schedule);
});

router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const body = { ...req.body };
  // Serialize targets array to JSON string for the DB layer
  if (Array.isArray(body.targets)) {
    body.targets = JSON.stringify(body.targets);
  }
  const schedule = db.updateSchedule(id, body);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  reloadScheduler();
  res.json(schedule);
});

router.delete('/:id', (req, res) => {
  const ok = db.deleteSchedule(parseInt(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Schedule not found' });
  reloadScheduler();
  res.json({ success: true });
});

export default router;

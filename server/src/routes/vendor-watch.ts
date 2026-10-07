import { Router } from 'express';
import { getSettings } from '../db/queries.js';
import {
  countOpenFindings, deletePlan, dismissFinding, getFinding, getPlan, getPlanByPiece, getSource, getWatchConfig,
  listFindings, listPlans, listRuns, listSources, setPlanStatus, setSourceEnabled, updateWatchConfig,
} from '../db/vendor-watch-queries.js';
import type { FindingStatus } from '../services/vendor-watch/types.js';
import { LinearError } from '../services/bug-trend/linear-client.js';
import { parseConfigPatch } from '../services/vendor-watch/config.js';
import { isCycleRunning, reloadVendorWatch, runWatchCycle } from '../services/vendor-watch/cron.js';
import { fileFinding, FilingInProgressError, previewFiling } from '../services/vendor-watch/filing.js';
import { generateWatchPlansInBackground } from '../services/vendor-watch/generate.js';
import { clearLinearTargetCache, resolveLinearTargets } from '../services/vendor-watch/linear-filer.js';
import { startWatchRun } from '../services/vendor-watch/runner.js';

const router = Router();
const MAX_BATCH = 100;
const FINDING_STATUSES: FindingStatus[] = ['new', 'filed', 'dismissed'];
const NO_ANTHROPIC_KEY = 'Anthropic API key not configured. Go to Settings to add it.';

const idParam = (v: string) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ── Config ──

router.get('/config', (_req, res) => {
  res.json(getWatchConfig());
});

router.put('/config', (req, res) => {
  const { patch, error } = parseConfigPatch(req.body ?? {});
  if (error) { res.status(400).json({ error }); return; }
  const row = updateWatchConfig(patch);
  if (patch.linear_team_key !== undefined || patch.linear_label !== undefined) clearLinearTargetCache();
  reloadVendorWatch();
  res.json(row);
});

// Read-only: resolves team, triage state and label with the saved key. Never writes to Linear.
router.post('/config/test-linear', async (_req, res) => {
  try {
    const c = getWatchConfig();
    clearLinearTargetCache();
    const t = await resolveLinearTargets(getSettings().linear_api_key, c.linear_team_key, c.linear_label);
    res.json({ ok: true, team: c.linear_team_key, state: t.stateName, label: t.labelName });
  } catch (err: any) {
    res.status(err instanceof LinearError ? 400 : 500).json({ ok: false, error: err.message });
  }
});

// ── Plans ──

router.get('/plans', (_req, res) => {
  res.json(listPlans());
});

router.get('/plans/by-piece/:pieceName', (req, res) => {
  const plan = getPlanByPiece(req.params.pieceName);
  res.json(plan ? { ...plan, open_findings: countOpenFindings(plan.piece_name) } : null);
});

router.get('/plans/:id', (req, res) => {
  const id = idParam(req.params.id);
  const plan = id ? getPlan(id) : undefined;
  if (!plan) { res.status(404).json({ error: 'Watch plan not found' }); return; }
  res.json({ plan, sources: listSources(plan.id), runs: listRuns(plan.id, 20) });
});

router.post('/plans/generate', (req, res) => {
  const name = typeof req.body?.piece_name === 'string' ? req.body.piece_name.trim() : '';
  if (!name) { res.status(400).json({ error: 'piece_name is required' }); return; }
  if (!getSettings().anthropic_api_key) { res.status(400).json({ error: NO_ANTHROPIC_KEY }); return; }
  const [plan_id] = generateWatchPlansInBackground([name]);
  res.status(202).json({ plan_id });
});

router.post('/plans/generate-batch', (req, res) => {
  const names: string[] = Array.isArray(req.body?.piece_names)
    ? req.body.piece_names.filter((n: unknown): n is string => typeof n === 'string' && n.trim() !== '')
    : [];
  if (names.length === 0) { res.status(400).json({ error: 'piece_names must be a non-empty list' }); return; }
  if (names.length > MAX_BATCH) { res.status(400).json({ error: `At most ${MAX_BATCH} pieces per batch` }); return; }
  if (!getSettings().anthropic_api_key) { res.status(400).json({ error: NO_ANTHROPIC_KEY }); return; }
  res.status(202).json({ plan_ids: generateWatchPlansInBackground(names) });
});

router.post('/plans/:id/run', (req, res) => {
  const id = idParam(req.params.id);
  const plan = id ? getPlan(id) : undefined;
  if (!plan) { res.status(404).json({ error: 'Watch plan not found' }); return; }
  if (plan.status === 'generating' || plan.status === 'failed') {
    res.status(409).json({ error: `Plan is ${plan.status}; generate it first` });
    return;
  }
  const handle = startWatchRun(plan.id, 'manual');
  handle.done.catch(err => console.error(`[vendor-watch] manual run of plan ${plan.id} failed:`, err));
  res.status(202).json({ run_id: handle.runId });
});

router.patch('/plans/:id', (req, res) => {
  const id = idParam(req.params.id);
  const status = req.body?.status;
  if (status !== 'active' && status !== 'paused') { res.status(400).json({ error: "status must be 'active' or 'paused'" }); return; }
  const plan = id ? getPlan(id) : undefined;
  if (!plan) { res.status(404).json({ error: 'Watch plan not found' }); return; }
  if (plan.status === 'generating') { res.status(409).json({ error: 'Plan is generating' }); return; }
  res.json(setPlanStatus(plan.id, status));
});

router.delete('/plans/:id', (req, res) => {
  const id = idParam(req.params.id);
  const plan = id ? getPlan(id) : undefined;
  if (!plan) { res.status(404).json({ error: 'Watch plan not found' }); return; }
  if (plan.status === 'generating') { res.status(409).json({ error: 'Plan is generating' }); return; }
  deletePlan(plan.id);
  res.json({ ok: true });
});

router.patch('/sources/:id', (req, res) => {
  const id = idParam(req.params.id);
  if (!id || !getSource(id)) { res.status(404).json({ error: 'Source not found' }); return; }
  res.json(setSourceEnabled(id, !!req.body?.enabled));
});

router.post('/run-cycle', (_req, res) => {
  if (isCycleRunning()) { res.status(409).json({ error: 'A watch cycle is already running' }); return; }
  runWatchCycle({ runPlan: (id, c) => startWatchRun(id, 'manual', { cycleId: c }).done })
    .catch(err => console.error('[vendor-watch] manual cycle failed:', err));
  res.status(202).json({ started: true });
});

// ── Findings ──

router.get('/findings', (req, res) => {
  const status = FINDING_STATUSES.find(s => s === req.query.status);
  const piece = typeof req.query.piece === 'string' && req.query.piece ? req.query.piece : undefined;
  res.json(listFindings({ status, piece }));
});

router.get('/findings/:id/draft', (req, res) => {
  const id = idParam(req.params.id);
  if (!id || !getFinding(id)) { res.status(404).json({ error: 'Finding not found' }); return; }
  res.json(previewFiling(id));
});

router.post('/findings/:id/file', async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id || !getFinding(id)) { res.status(404).json({ error: 'Finding not found' }); return; }
    const { title, description, priority } = req.body ?? {};
    const row = await fileFinding(id, {
      filedBy: 'manual',
      override: {
        title: typeof title === 'string' ? title.slice(0, 200) : undefined,
        description: typeof description === 'string' ? description : undefined,
        priority: [0, 1, 2, 3, 4].includes(priority) ? priority : undefined,
      },
    });
    res.json(row);
  } catch (err: any) {
    const status = err instanceof FilingInProgressError ? 409 : err instanceof LinearError ? 502 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.post('/findings/:id/dismiss', (req, res) => {
  const id = idParam(req.params.id);
  const before = id ? getFinding(id) : undefined;
  if (!before) { res.status(404).json({ error: 'Finding not found' }); return; }
  if (before.status !== 'new') { res.status(409).json({ error: `Finding is already ${before.status}` }); return; }
  res.json(dismissFinding(before.id));
});

export default router;

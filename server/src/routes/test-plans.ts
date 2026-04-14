import { Router } from 'express';
import * as db from '../db/queries.js';
import { executePlan, resumePlanRun, type PlanProgress } from '../services/plan-executor.js';

const router = Router();

// ── SSE helper ──
function setupSSE(res: any) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// List plans for a piece
router.get('/', (req, res) => {
  const pieceName = req.query.piece as string | undefined;
  const plans = db.listTestPlans(pieceName);
  res.json(plans.map(p => ({
    ...p,
    steps: safeParseJson(p.steps),
  })));
});

router.get('/export', (req, res) => {
  const pieceName = req.query.piece as string | undefined;
  if (!pieceName) {
    return res.status(400).json({ error: 'piece query param is required' });
  }

  const actionsParam = req.query.actions as string | undefined;
  const actionNames = actionsParam
    ? actionsParam.split(',').map(a => a.trim()).filter(Boolean)
    : [];

  const plans = actionNames.length > 0
    ? db.listTestPlansForActions(pieceName, actionNames)
    : db.listTestPlans(pieceName);

  res.json({
    exported_at: new Date().toISOString(),
    piece_name: pieceName,
    action_names: actionNames,
    plans: plans.map(p => ({
      ...p,
      steps: safeParseJson(p.steps),
    })),
  });
});

// Get plan by piece + action (must be before /:id to avoid matching "by-action" as id)
router.get('/by-action/:pieceName/:actionName', (req, res) => {
  const plan = db.getTestPlanByAction(req.params.pieceName, req.params.actionName);
  if (!plan) return res.status(404).json({ error: 'No plan found' });
  res.json({ ...plan, steps: safeParseJson(plan.steps) });
});

// ── Global plan run history (must be before /runs/:runId) ──
router.get('/runs/all', (req, res) => {
  const pieceName = req.query.piece as string | undefined;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const runs = db.listAllPlanRuns({ pieceName, limit, offset });
  res.json(runs.map(r => ({
    ...r,
    step_results: safeParseJson(r.step_results),
  })));
});

// Get plan by ID
router.get('/:id', (req, res) => {
  const plan = db.getTestPlan(parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  res.json({ ...plan, steps: safeParseJson(plan.steps) });
});

// Update plan steps / status
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const updates: Record<string, any> = {};
  if (req.body.steps !== undefined) {
    updates.steps = typeof req.body.steps === 'string'
      ? req.body.steps
      : JSON.stringify(req.body.steps);
  }
  if (req.body.status !== undefined) updates.status = req.body.status;
  if (req.body.agent_memory !== undefined) updates.agent_memory = req.body.agent_memory;

  const plan = db.updateTestPlan(id, updates);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  res.json({ ...plan, steps: safeParseJson(plan.steps) });
});

// Delete plan
router.delete('/:id', (req, res) => {
  const ok = db.deleteTestPlan(parseInt(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Plan not found' });
  res.json({ success: true });
});

router.delete('/', (req, res) => {
  const pieceName = req.query.piece as string | undefined;
  if (!pieceName) {
    return res.status(400).json({ error: 'piece query param is required' });
  }

  const actionsParam = req.query.actions as string | undefined;
  const actionNames = actionsParam
    ? actionsParam.split(',').map(a => a.trim()).filter(Boolean)
    : undefined;

  const deleted = db.deleteTestPlansByPiece(pieceName, actionNames);
  res.json({ success: true, deleted });
});

// ── Execute plan (SSE streaming) ──
router.post('/:id/run', async (req, res) => {
  req.setTimeout(300_000);
  const sendEvent = setupSSE(res);

  const ac = new AbortController();
  res.on('close', () => {
    ac.abort();
    console.log(`[plan-run] Client disconnected for plan ${req.params.id}, aborting execution.`);
  });

  const planId = parseInt(req.params.id);
  const plan = db.getTestPlan(planId);
  if (!plan) {
    sendEvent('error', { message: 'Plan not found' });
    res.end();
    return;
  }

  const triggerType = (req.body?.trigger_type as string) || 'manual';

  try {
    const onProgress = (progress: PlanProgress) => {
      if (!ac.signal.aborted) sendEvent('progress', progress);
    };

    const finalRun = await executePlan(planId, onProgress, triggerType, ac.signal);
    if (!ac.signal.aborted) {
      sendEvent('done', {
        runId: finalRun.id,
        status: finalRun.status,
        step_results: safeParseJson(finalRun.step_results),
      });
    }
  } catch (err: any) {
    console.error('[plan-run] Error:', err.message);
    if (!ac.signal.aborted) sendEvent('error', { message: err.message || 'Unknown error' });
  }

  res.end();
});

// ── Execute plan in background (non-SSE, returns immediately) ──
router.post('/:id/run-background', async (req, res) => {
  const planId = parseInt(req.params.id);
  const plan = db.getTestPlan(planId);
  if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }

  const triggerType = (req.body?.trigger_type as string) || 'retest';

  // executePlan creates its own run record internally; fire and forget
  executePlan(planId, () => {}, triggerType).catch(err => {
    console.error(`[plan-run-bg] Background execution failed for plan ${planId}:`, err.message);
  });

  // Find the just-created run (latest for this plan)
  const runs = db.listPlanRuns(planId);
  const latest = runs[0];

  res.json({ run_id: latest?.id ?? null, plan_id: planId });
});

// ── Delete all plan runs (optionally before a date) ──
router.delete('/runs', (req, res) => {
  const before = req.query.before as string | undefined;
  const count = db.deleteAllPlanRuns(before);
  res.json({ success: true, deleted: count });
});

// ── Delete a single plan run ──
router.delete('/runs/:runId', (req, res) => {
  const ok = db.deletePlanRun(parseInt(req.params.runId));
  if (!ok) return res.status(404).json({ error: 'Run not found' });
  res.json({ success: true });
});

// ── Get a plan run ──
router.get('/runs/:runId', (req, res) => {
  const run = db.getPlanRun(parseInt(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ ...run, step_results: safeParseJson(run.step_results) });
});

// ── List runs for a plan ──
router.get('/:id/runs', (req, res) => {
  const runs = db.listPlanRuns(parseInt(req.params.id));
  res.json(runs.map(r => ({
    ...r,
    step_results: safeParseJson(r.step_results),
  })));
});

// ── Resume a paused run (human input or approval) ──
router.post('/runs/:runId/respond', (req, res) => {
  const runId = parseInt(req.params.runId);
  const run = db.getPlanRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  if (!['paused_for_human', 'paused_for_approval'].includes(run.status)) {
    return res.status(400).json({ error: `Run is not paused (status: ${run.status})` });
  }

  const { stepId, approved, humanResponse } = req.body;
  if (!stepId) return res.status(400).json({ error: 'stepId is required' });

  try {
    resumePlanRun(runId, { stepId, approved, humanResponse });
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

function safeParseJson(s: string) {
  try { return JSON.parse(s); } catch { return []; }
}

export default router;

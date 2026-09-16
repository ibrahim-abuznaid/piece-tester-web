import { Router } from 'express';
import { createClient } from '../services/test-engine.js';
import { type AgentLogEntry } from '../services/ai-config-generator.js';
import { createTestPlanV2, fixTestPlanV2, createTriggerTestPlanV2 } from '../agents/v2/index.js';
import { detectBrokenInputMappings } from '../agents/v2/tools/inspect-output.js';
import {
  createTestPlan, updateTestPlan, listTestPlans,
  createSetupRun, addSetupRunItems, updateSetupRunItem, finalizeSetupRun,
  getSetupRun, listSetupRuns, listSetupRunItems,
} from '../db/queries.js';
import { executePlan } from '../services/plan-executor.js';
import { itemsForSelection } from '../services/batch-selection.js';
import { extractAndStoreLessons } from '../services/lesson-extractor.js';
import { createSchedulesForRun } from '../services/setup-scheduler.js';
import type { Cadence } from '../services/schedule-planner.js';
import {
  getJob, createJob, emitJobEvent, completeJob,
  getBatchQueue, getBatchQueueStatus, createBatchQueue, emitBatchEvent, completeBatchQueue, cancelBatchQueue,
  subscribeToBatchWithCleanup,
  type BatchQueueItem, type BatchQueue,
} from '../services/plan-jobs.js';

const router = Router();

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

async function runBatchInBackground(queue: BatchQueue) {
  const client = createClient();

  for (let i = 0; i < queue.items.length; i++) {
    if (queue.cancelled) break;

    const item = queue.items[i];
    queue.currentIndex = i;

    if (item.status === 'skipped') {
      if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'skipped' });
      emitBatchEvent(queue, 'item_update', { index: i, ...item });
      continue;
    }

    item.status = 'running';
    if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'running' });
    emitBatchEvent(queue, 'item_update', { index: i, ...item });

    try {
      const piece = await client.getPieceMetadata(item.pieceName);
      const actionName = item.actionName;
      let planId: number | undefined;

      const onLog = (log: AgentLogEntry) => {
        emitBatchEvent(queue, 'log', { index: i, pieceName: item.pieceName, actionName, log });
      };

      if (item.targetType === 'trigger') {
        if (!piece.triggers?.[actionName]) {
          item.status = 'error';
          item.error = `Trigger "${actionName}" not found`;
          if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'error', error: item.error });
          emitBatchEvent(queue, 'item_update', { index: i, ...item });
          continue;
        }

        const planResult = await createTriggerTestPlanV2({
          pieceMeta: piece,
          triggerName: actionName,
          onLog: (l: any) => onLog(l),
        });

        if (queue.cancelled) break;

        const saved = createTestPlan({
          piece_name: item.pieceName,
          target_action: actionName,
          target_type: 'trigger',
          steps: JSON.stringify(planResult.steps),
          status: 'draft',
          agent_memory: planResult.agentMemory || '',
        });
        planId = saved.id;

        emitBatchEvent(queue, 'plan_created', {
          index: i, pieceName: item.pieceName, actionName, planId: saved.id, steps: planResult.steps, status: 'draft',
        });

        // triggers: single auto-test, no fixer loop (unlike the action path)
        const hasHumanInput = planResult.steps.some((s: any) => s.type === 'human_input');
        if (!hasHumanInput && planResult.steps.length > 0) {
          onLog({ timestamp: Date.now(), type: 'thinking', message: 'Auto-testing trigger plan...' });
          const finalRun = await executePlan(saved.id, () => {}, 'auto_test');
          if (queue.cancelled) break;
          if (finalRun.status === 'completed') {
            onLog({ timestamp: Date.now(), type: 'done', message: 'Auto-test passed!' });
            updateTestPlan(saved.id, { status: 'approved' });
            emitBatchEvent(queue, 'plan_approved', { index: i, pieceName: item.pieceName, actionName, planId: saved.id });
          } else {
            onLog({ timestamp: Date.now(), type: 'error', message: 'Auto-test did not pass. Left as draft.' });
          }
        }
      } else {
        if (!piece.actions[actionName]) {
          item.status = 'error';
          item.error = `Action "${actionName}" not found`;
          if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'error', error: item.error });
          emitBatchEvent(queue, 'item_update', { index: i, ...item });
          continue;
        }

        // Create the plan (v2 multi-agent planner — same as the per-piece flow)
        const planResult = await createTestPlanV2({ pieceMeta: piece, actionName, onLog: (l: any) => onLog(l) });

        if (queue.cancelled) break;

        const saved = createTestPlan({
          piece_name: item.pieceName,
          target_action: actionName,
          steps: JSON.stringify(planResult.steps),
          status: 'draft',
          agent_memory: planResult.agentMemory || '',
        });
        planId = saved.id;

        emitBatchEvent(queue, 'plan_created', {
          index: i,
          pieceName: item.pieceName,
          actionName,
          planId: saved.id,
          steps: planResult.steps,
          status: 'draft',
        });

        // Auto-test if no human input steps
        const hasHumanInputSteps = planResult.steps.some((s: any) => s.type === 'human_input');

        if (!hasHumanInputSteps && planResult.steps.length > 0) {
          const MAX_FIX_ATTEMPTS = 3;
          let currentSteps = planResult.steps;
          let currentMemory = planResult.agentMemory;
          let autoTestPassed = false;

          for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
            if (queue.cancelled) break;

            onLog({ timestamp: Date.now(), type: 'thinking', message: `Auto-testing plan (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS + 1})...` });

            const finalRun = await executePlan(saved.id, () => {}, 'auto_test');

            if (queue.cancelled) break;

            if (finalRun.status === 'completed') {
              onLog({ timestamp: Date.now(), type: 'done', message: 'Auto-test passed!' });
              autoTestPassed = true;
              updateTestPlan(saved.id, { status: 'approved' });

              if (attempt > 0) {
                extractAndStoreLessons(
                  item.pieceName, piece.displayName,
                  planResult.steps, JSON.parse(finalRun.step_results || '[]'), currentSteps,
                ).catch(() => {});
              }

              emitBatchEvent(queue, 'plan_approved', {
                index: i, pieceName: item.pieceName, actionName, planId: saved.id,
              });
              break;
            }

            if (attempt >= MAX_FIX_ATTEMPTS) {
              onLog({ timestamp: Date.now(), type: 'error', message: `Auto-test still failing after ${MAX_FIX_ATTEMPTS + 1} attempts.` });
              break;
            }

            onLog({ timestamp: Date.now(), type: 'thinking', message: 'Auto-test failed, running v2 fixer...' });
            const stepResults = JSON.parse(finalRun.step_results || '[]');
            const brokenMappings = detectBrokenInputMappings(currentSteps, stepResults);

            const fixResult = await fixTestPlanV2({
              pieceMeta: piece,
              actionName,
              previousSteps: currentSteps,
              stepResults,
              brokenMappings,
              agentMemory: currentMemory,
              onLog: (l: any) => onLog(l),
            });

            if (queue.cancelled) break;

            updateTestPlan(saved.id, {
              steps: JSON.stringify(fixResult.steps),
              agent_memory: fixResult.agentMemory || currentMemory || '',
            });

            currentSteps = fixResult.steps;
            currentMemory = fixResult.agentMemory || currentMemory;
          }
        }
      }

      item.status = 'done';
      if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'done', plan_id: planId ?? null });
      emitBatchEvent(queue, 'item_update', { index: i, ...item });

    } catch (err: any) {
      if (queue.cancelled) break;
      console.error(`[batch-setup] Error for ${item.pieceName}/${item.actionName}:`, err.message);
      item.status = 'error';
      item.error = err.message;
      if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'error', error: err.message });
      emitBatchEvent(queue, 'item_update', { index: i, ...item });
    }
  }

  const finalStatus = queue.cancelled ? 'cancelled' : 'done';

  let scheduleIds: number[] = [];
  if (!queue.cancelled && queue.setupRunId) {
    const run = getSetupRun(queue.setupRunId);
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(run?.config ?? '{}'); } catch { /* malformed config — treat as empty */ }
    const cadence = (run?.cadence ?? 'none') as Cadence;
    if (cfg.scheduleEnabled) {
      const selectedPieces: string[] = cfg.pieceNames ?? [];
      const eligible = selectedPieces.filter(p => listTestPlans(p).some(pl => pl.status === 'approved'));
      try {
        scheduleIds = createSchedulesForRun({
          pieceNames: eligible,
          cadence,
          customCron: cfg.customCron || undefined,
        });
      } catch (e: any) {
        console.error('[batch-setup] auto-schedule failed:', e.message);
      }
    }
  }

  if (queue.setupRunId) {
    finalizeSetupRun(queue.setupRunId, {
      status: finalStatus,
      schedule_ids: scheduleIds,
      schedules_created: scheduleIds.length,
    });
  }

  completeBatchQueue(queue, finalStatus);
  emitBatchEvent(queue, 'batch_done', { status: queue.status, setupRunId: queue.setupRunId, schedulesCreated: scheduleIds.length });
}

// ── Start batch setup ──
type BatchTarget = { type: 'action' | 'trigger'; name: string };
type BatchSelection = { pieceName: string; targets?: BatchTarget[] };

router.post('/start', async (req, res) => {
  const { selections: rawSelections, pieceNames, schedule } = req.body as {
    selections?: BatchSelection[];
    pieceNames?: string[];
    schedule?: { enabled?: boolean; cadence?: Cadence; customCron?: string };
  };

  const selections: BatchSelection[] =
    Array.isArray(rawSelections) && rawSelections.length > 0
      ? rawSelections
      : Array.isArray(pieceNames) && pieceNames.length > 0
        ? pieceNames.map(pieceName => ({ pieceName }))
        : [];

  if (selections.length === 0) {
    return res.status(400).json({ error: 'pieceNames array is required' });
  }

  const existing = getBatchQueue();
  if (existing && existing.status === 'running') {
    return res.status(409).json({ error: 'A batch is already running' });
  }

  try {
    const client = createClient();
    const items: BatchQueueItem[] = [];

    for (const selection of selections) {
      const { pieceName } = selection;
      const piece = await client.getPieceMetadata(pieceName);
      const existingTargets = new Set(listTestPlans(pieceName).map(p => `${p.target_type}:${p.target_action}`));

      items.push(...itemsForSelection(piece, selection, existingTargets));
    }

    const pieceNamesDistinct = [...new Set(selections.map(s => s.pieceName))];
    const cadence: Cadence = schedule?.enabled === false ? 'none' : (schedule?.cadence ?? 'monthly');
    const run = createSetupRun({
      cadence,
      cron_template: '',
      config: JSON.stringify({ scheduleEnabled: schedule?.enabled !== false, customCron: schedule?.customCron ?? '', pieceNames: pieceNamesDistinct }),
    });
    const savedItems = addSetupRunItems(run.id, items.map(i => ({
      piece_name: i.pieceName,
      piece_display_name: i.pieceDisplayName,
      target_type: i.targetType,
      target_name: i.actionName,
      target_display_name: i.actionDisplayName,
      status: i.status,
    })));
    items.forEach((i, idx) => { i.setupItemId = savedItems[idx].id; });

    const queue = createBatchQueue(items);
    queue.setupRunId = run.id;
    runBatchInBackground(queue);

    res.json({
      id: queue.id,
      setupRunId: run.id,
      totalItems: items.length,
      pendingItems: items.filter(i => i.status === 'pending').length,
      skippedItems: items.filter(i => i.status === 'skipped').length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get batch status ──
router.get('/status', (_req, res) => {
  const status = getBatchQueueStatus();
  if (!status) {
    return res.json(null);
  }
  res.json(status);
});

// ── Subscribe to batch events (SSE) ──
router.get('/subscribe', (req, res) => {
  const queue = getBatchQueue();
  if (!queue) {
    return res.status(404).json({ error: 'No batch queue exists' });
  }

  req.setTimeout(600_000);
  const sendEvent = setupSSE(res);
  const unsubscribe = subscribeToBatchWithCleanup(queue, sendEvent, () => res.end());
  res.on('close', () => { unsubscribe(); });
});

// ── Cancel batch ──
router.post('/cancel', (_req, res) => {
  const cancelled = cancelBatchQueue();
  if (!cancelled) {
    return res.status(404).json({ error: 'No running batch to cancel' });
  }
  res.json({ success: true });
});

// ── Setup run history ──
router.get('/runs', (_req, res) => {
  res.json(listSetupRuns());
});

router.get('/runs/:id', (req, res) => {
  const run = getSetupRun(parseInt(req.params.id));
  if (!run) return res.status(404).json({ error: 'Setup run not found' });
  res.json({ run, items: listSetupRunItems(run.id) });
});

export default router;

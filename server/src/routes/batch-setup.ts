import { Router } from 'express';
import { createClient } from '../services/test-engine.js';
import { type AgentLogEntry } from '../services/ai-config-generator.js';
import { createTestPlanV2, fixTestPlanV2, createTriggerTestPlanV2 } from '../agents/v2/index.js';
import { detectBrokenInputMappings } from '../agents/v2/tools/inspect-output.js';
import { resolvePlanGenBudgetMs } from '../agents/v2/plan-budget.js';
import {
  createTestPlan, updateTestPlan, listTestPlans,
  createSetupRun, addSetupRunItems, updateSetupRunItem, finalizeSetupRun,
  getSetupRun, listSetupRuns, listSetupRunItems, getSettings,
} from '../db/queries.js';
import { executePlan } from '../services/plan-executor.js';
import { boundConcurrency } from '../services/concurrency.js';
import { itemsForSelection } from '../services/batch-selection.js';
import { extractAndStoreLessons } from '../services/lesson-extractor.js';
import { checkPieceConnectionForPlanning } from '../services/plan-connection-gate.js';
import { createSchedulesForRun } from '../services/setup-scheduler.js';
import type { Cadence } from '../services/schedule-planner.js';
import {
  getBatch, listBatches, getBatchStatus, createBatchQueue, cancelBatch, activeBatchPieceNames,
  emitBatchEvent, completeBatchQueue, subscribeToBatchWithCleanup,
  type BatchQueueItem, type BatchQueue,
} from '../services/plan-jobs.js';
import { groupByPiece } from '../services/batch-grouping.js';
import { configureBatchScheduler, submitPieceUnit } from '../services/batch-scheduler.js';

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

// Global cap = Settings value → env → 3, clamped. Shared across ALL batches.
configureBatchScheduler(() =>
  boundConcurrency(getSettings().batch_concurrency || Number(process.env.BATCH_CONCURRENCY) || 3));

async function processBatchItem(
  queue: BatchQueue,
  client: ReturnType<typeof createClient>,
  item: BatchQueueItem,
  i: number,
): Promise<void> {
  if (queue.cancelled) return;
  queue.currentIndex = i;

  if (item.status === 'skipped') {
    if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'skipped' });
    emitBatchEvent(queue, 'item_update', { index: i, ...item });
    return;
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

    const conn = await checkPieceConnectionForPlanning(client, item.pieceName, piece.displayName);
    if (!conn.ok) {
      item.status = 'error';
      item.error = conn.reason;
      if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'error', error: conn.reason });
      onLog({ timestamp: Date.now(), type: 'error', message: conn.reason! });
      emitBatchEvent(queue, 'item_update', { index: i, ...item });
      return;
    }

    if (item.targetType === 'trigger') {
      if (!piece.triggers?.[actionName]) {
        item.status = 'error';
        item.error = `Trigger "${actionName}" not found`;
        if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'error', error: item.error });
        emitBatchEvent(queue, 'item_update', { index: i, ...item });
        return;
      }

      const planResult = await createTriggerTestPlanV2({
        pieceMeta: piece,
        triggerName: actionName,
        onLog: (l: any) => onLog(l),
      });

      if (queue.cancelled) return;

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
        if (queue.cancelled) return;
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
        return;
      }

      // One wall-clock budget for this action, shared by the write phase and
      // the auto-test loop below, so a single action can't crawl to the 600s cap.
      const deadlineAt = Date.now() + resolvePlanGenBudgetMs(process.env.PLAN_GEN_BUDGET_MS);

      // Create the plan (v2 multi-agent planner — same as the per-piece flow)
      const planResult = await createTestPlanV2({ pieceMeta: piece, actionName, onLog: (l: any) => onLog(l), deadlineAt });

      if (queue.cancelled) return;

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
          if (Date.now() >= deadlineAt) {
            onLog({ timestamp: Date.now(), type: 'error', message: 'Time budget exceeded — stopping auto-test and leaving the plan as-is.' });
            break;
          }

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
    if (queue.cancelled) return;
    console.error(`[batch-setup] Error for ${item.pieceName}/${item.actionName}:`, err.message);
    item.status = 'error';
    item.error = err.message;
    if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'error', error: err.message });
    emitBatchEvent(queue, 'item_update', { index: i, ...item });
  }
}

async function runBatchInBackground(queue: BatchQueue) {
  const client = createClient();
  const groups = groupByPiece(queue.items);

  // Each piece is one unit submitted to the global scheduler (a single cap across all batches).
  // Targets within a piece run serially. Cancellation is honoured by processBatchItem's internal
  // queue.cancelled checks and the per-target guard below.
  await Promise.all(groups.map(group => submitPieceUnit(queue.id, async () => {
    for (const { item, index } of group) {
      if (queue.cancelled) break;
      try {
        await processBatchItem(queue, client, item, index);
      } catch (err: any) {
        // processBatchItem catches its own errors; this guard just ensures one unexpected
        // failure can't reject the pool and skip finalization / abandon the other items.
        console.error(`[batch-setup] Unexpected failure for ${item.pieceName}/${item.actionName}:`, err?.message);
        item.status = 'error';
        item.error = err?.message ?? 'Unknown error';
        if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'error', error: item.error });
        emitBatchEvent(queue, 'item_update', { index, ...item });
      }
    }
  })));

  const finalStatus = queue.cancelled ? 'cancelled' : 'done';

  let scheduleIds: number[] = [];
  try {
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
  } catch (err: any) {
    console.error('[batch-setup] finalization failed:', err?.message);
  } finally {
    // Always complete the batch — otherwise it stays 'running' forever and its pieces
    // stay locked out of every future batch (activeBatchPieceNames).
    completeBatchQueue(queue, finalStatus);
    emitBatchEvent(queue, 'batch_done', { status: queue.status, setupRunId: queue.setupRunId, schedulesCreated: scheduleIds.length });
  }
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

  const active = activeBatchPieceNames();
  const skippedPieces = selections.filter(s => active.has(s.pieceName)).map(s => s.pieceName);
  const usable = selections.filter(s => !active.has(s.pieceName));
  if (usable.length === 0) {
    return res.status(409).json({ error: 'All selected pieces are already in an active batch.', skippedPieces });
  }

  try {
    const client = createClient();
    const items: BatchQueueItem[] = [];

    for (const selection of usable) {
      const { pieceName } = selection;
      const piece = await client.getPieceMetadata(pieceName);
      const existingTargets = new Set(listTestPlans(pieceName).map(p => `${p.target_type}:${p.target_action}`));

      items.push(...itemsForSelection(piece, selection, existingTargets));
    }

    const pieceNamesDistinct = [...new Set(usable.map(s => s.pieceName))];
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
    runBatchInBackground(queue).catch(err => console.error('[batch-setup] background run error:', err?.message));

    res.json({
      id: queue.id,
      setupRunId: run.id,
      totalItems: items.length,
      skippedPieces,
      pendingItems: items.filter(i => i.status === 'pending').length,
      skippedItems: items.filter(i => i.status === 'skipped').length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Setup run history ── (registered before /:id/... so it isn't captured as an id)
router.get('/runs', (_req, res) => {
  res.json(listSetupRuns());
});

router.get('/runs/:id', (req, res) => {
  const run = getSetupRun(parseInt(req.params.id));
  if (!run) return res.status(404).json({ error: 'Setup run not found' });
  res.json({ run, items: listSetupRunItems(run.id) });
});

// ── List all batches ── (registered before /:id/status so 'batches' isn't read as an id)
router.get('/batches', (_req, res) => {
  res.json(listBatches().map(q => getBatchStatus(q.id)));
});

// ── Get batch status ──
router.get('/:id/status', (req, res) => {
  const s = getBatchStatus(req.params.id);
  return s ? res.json(s) : res.json(null);
});

// ── Subscribe to batch events (SSE) ──
router.get('/:id/subscribe', (req, res) => {
  const queue = getBatch(req.params.id);
  if (!queue) return res.status(404).json({ error: 'No such batch' });
  req.setTimeout(600_000);
  const sendEvent = setupSSE(res);
  const unsubscribe = subscribeToBatchWithCleanup(queue, sendEvent, () => res.end());
  res.on('close', () => { unsubscribe(); });
});

// ── Cancel batch ──
router.post('/:id/cancel', (req, res) => {
  return cancelBatch(req.params.id)
    ? res.json({ success: true })
    : res.status(404).json({ error: 'No running batch to cancel' });
});

export default router;

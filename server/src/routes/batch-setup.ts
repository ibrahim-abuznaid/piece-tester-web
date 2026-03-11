import { Router } from 'express';
import { createClient } from '../services/test-engine.js';
import { createTestPlanWithAi, fixTestPlanWithAi, type AgentLogEntry } from '../services/ai-config-generator.js';
import { createTestPlan, updateTestPlan, listTestPlans } from '../db/queries.js';
import { executePlan } from '../services/plan-executor.js';
import { extractAndStoreLessons } from '../services/lesson-extractor.js';
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
      emitBatchEvent(queue, 'item_update', { index: i, ...item });
      continue;
    }

    item.status = 'running';
    emitBatchEvent(queue, 'item_update', { index: i, ...item });

    try {
      const piece = await client.getPieceMetadata(item.pieceName);
      const actionName = item.actionName;

      if (!piece.actions[actionName]) {
        item.status = 'error';
        item.error = `Action "${actionName}" not found`;
        emitBatchEvent(queue, 'item_update', { index: i, ...item });
        continue;
      }

      const onLog = (log: AgentLogEntry) => {
        emitBatchEvent(queue, 'log', { index: i, pieceName: item.pieceName, actionName, log });
      };

      // Create the plan
      const planResult = await createTestPlanWithAi(piece, actionName, onLog);

      if (queue.cancelled) break;

      const saved = createTestPlan({
        piece_name: item.pieceName,
        target_action: actionName,
        steps: JSON.stringify(planResult.steps),
        status: 'draft',
        agent_memory: planResult.agentMemory || '',
      });

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

          onLog({ timestamp: Date.now(), type: 'thinking', message: 'Auto-test failed, running AI fix...' });
          const stepResults = JSON.parse(finalRun.step_results || '[]');

          const fixResult = await fixTestPlanWithAi(
            piece, actionName, currentSteps, stepResults, currentMemory, onLog,
          );

          if (queue.cancelled) break;

          updateTestPlan(saved.id, {
            steps: JSON.stringify(fixResult.steps),
            agent_memory: fixResult.agentMemory || currentMemory || '',
          });

          currentSteps = fixResult.steps;
          currentMemory = fixResult.agentMemory || currentMemory;
        }
      }

      item.status = 'done';
      emitBatchEvent(queue, 'item_update', { index: i, ...item });

    } catch (err: any) {
      if (queue.cancelled) break;
      console.error(`[batch-setup] Error for ${item.pieceName}/${item.actionName}:`, err.message);
      item.status = 'error';
      item.error = err.message;
      emitBatchEvent(queue, 'item_update', { index: i, ...item });
    }
  }

  completeBatchQueue(queue, queue.cancelled ? 'cancelled' : 'done');
  emitBatchEvent(queue, 'batch_done', { status: queue.status });
}

// ── Start batch setup ──
router.post('/start', async (req, res) => {
  const { pieceNames } = req.body;
  if (!pieceNames || !Array.isArray(pieceNames) || pieceNames.length === 0) {
    return res.status(400).json({ error: 'pieceNames array is required' });
  }

  const existing = getBatchQueue();
  if (existing && existing.status === 'running') {
    return res.status(409).json({ error: 'A batch is already running' });
  }

  try {
    const client = createClient();
    const items: BatchQueueItem[] = [];

    for (const pieceName of pieceNames) {
      const piece = await client.getPieceMetadata(pieceName);
      const existingPlans = listTestPlans(pieceName);
      const existingActionSet = new Set(existingPlans.map(p => p.target_action));

      for (const [actionName, actionMeta] of Object.entries(piece.actions || {})) {
        items.push({
          pieceName,
          pieceDisplayName: piece.displayName,
          actionName,
          actionDisplayName: (actionMeta as any).displayName || actionName,
          status: existingActionSet.has(actionName) ? 'skipped' : 'pending',
        });
      }
    }

    const queue = createBatchQueue(items);
    runBatchInBackground(queue);

    res.json({
      id: queue.id,
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

export default router;

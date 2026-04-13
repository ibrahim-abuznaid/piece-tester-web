import { Router } from 'express';
import { createClient } from '../services/test-engine.js';
import { ActivepiecesClient } from '../services/ap-client.js';
import { generateTestConfig } from '../services/test-config-generator.js';
import { configureActionWithAi, fixActionWithAi, createTestPlanWithAi, fixTestPlanWithAi, type AgentLogEntry, type AiActionResult } from '../services/ai-config-generator.js';
import { createTestPlan, getTestPlanByAction, updateTestPlan, getLessonsForPiece, deleteLesson, addLesson } from '../db/queries.js';
import { executePlan } from '../services/plan-executor.js';
import { extractAndStoreLessons } from '../services/lesson-extractor.js';
import { getJob, createJob, emitJobEvent, completeJob, getActiveJobsForPiece, subscribeToJobWithCleanup, type PlanJob } from '../services/plan-jobs.js';
import { createTestPlanV2, fixTestPlanV2 } from '../agents/v2/index.js';
import type { AgentLogEntry as V2LogEntry } from '../agents/v2/types.js';
import { detectBrokenInputMappings } from '../agents/v2/tools/inspect-output.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const client = createClient();
    const pieces = await client.listPieces();
    res.json(pieces);
  } catch (err) {
    res.status(500).json({ error: ActivepiecesClient.formatError(err) });
  }
});

router.get('/:name', async (req, res) => {
  try {
    const client = createClient();
    const piece = await client.getPieceMetadata(req.params.name);
    res.json(piece);
  } catch (err) {
    res.status(500).json({ error: ActivepiecesClient.formatError(err) });
  }
});

router.get('/:name/auto-config', async (req, res) => {
  try {
    const client = createClient();
    const piece = await client.getPieceMetadata(req.params.name);
    const config = generateTestConfig(piece);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: ActivepiecesClient.formatError(err) });
  }
});

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

// ── Per-action AI configuration via SSE ──
router.get('/:name/actions/:action/ai-config', async (req, res) => {
  req.setTimeout(300_000);
  const sendEvent = setupSSE(res);

  // Abort AI agent when client disconnects
  const ac = new AbortController();
  res.on('close', () => { ac.abort(); console.log('[ai-config] Client disconnected, aborting agent.'); });

  try {
    const client = createClient();
    const piece = await client.getPieceMetadata(req.params.name);
    const actionName = req.params.action;

    if (!piece.actions[actionName]) {
      sendEvent('error', { message: `Action "${actionName}" not found` });
      res.end();
      return;
    }

    // Pass previous memory if provided via query string
    const previousMemory = req.query.memory as string | undefined;
    const onLog = (log: AgentLogEntry) => { if (!ac.signal.aborted) sendEvent('log', log); };
    const result = await configureActionWithAi(piece, actionName, onLog, previousMemory || undefined, ac.signal);

    if (!ac.signal.aborted) {
      sendEvent('result', result);
      sendEvent('done', {});
    }
  } catch (err: any) {
    if (ac.signal.aborted) {
      console.log('[ai-config] Agent aborted (client disconnect).');
    } else {
      console.error('[ai-config] SSE error:', err.message);
      sendEvent('error', { message: err.message || 'Unknown error' });
    }
  }

  res.end();
});

// ── Fix failed test via SSE ──
router.post('/:name/actions/:action/ai-fix', async (req, res) => {
  req.setTimeout(300_000);
  const sendEvent = setupSSE(res);

  const ac = new AbortController();
  res.on('close', () => { ac.abort(); console.log('[ai-fix] Client disconnected, aborting agent.'); });

  try {
    const client = createClient();
    const piece = await client.getPieceMetadata(req.params.name);
    const actionName = req.params.action;

    if (!piece.actions[actionName]) {
      sendEvent('error', { message: `Action "${actionName}" not found` });
      res.end();
      return;
    }

    const { previousConfig, testError, agentMemory } = req.body;
    if (!testError) {
      sendEvent('error', { message: 'testError is required' });
      res.end();
      return;
    }

    const onLog = (log: AgentLogEntry) => { if (!ac.signal.aborted) sendEvent('log', log); };
    const result = await fixActionWithAi(piece, actionName, previousConfig || {}, testError, agentMemory, onLog, ac.signal);

    if (!ac.signal.aborted) {
      sendEvent('result', result);
      sendEvent('done', {});
    }
  } catch (err: any) {
    if (ac.signal.aborted) {
      console.log('[ai-fix] Agent aborted (client disconnect).');
    } else {
      console.error('[ai-fix] SSE error:', err.message);
      sendEvent('error', { message: err.message || 'Unknown error' });
    }
  }

  res.end();
});

// ── Background job runner for AI plan creation ──
function runPlanJobInBackground(job: PlanJob, pieceName: string, actionName: string, previousMemory?: string) {
  (async () => {
    try {
      const client = createClient();
      const piece = await client.getPieceMetadata(pieceName);

      if (!piece.actions[actionName]) {
        emitJobEvent(job, 'error', { message: `Action "${actionName}" not found` });
        emitJobEvent(job, 'done', {});
        completeJob(job, 'error');
        return;
      }

      const onLog = (log: AgentLogEntry) => emitJobEvent(job, 'log', log);

      // ── Step 1: Create plan ──
      const planResult = await createTestPlanWithAi(piece, actionName, onLog, previousMemory || undefined);

      const saved = createTestPlan({
        piece_name: pieceName,
        target_action: actionName,
        steps: JSON.stringify(planResult.steps),
        status: 'draft',
        agent_memory: planResult.agentMemory || '',
      });

      emitJobEvent(job, 'result', {
        planId: saved.id,
        steps: planResult.steps,
        note: planResult.note,
        agentMemory: planResult.agentMemory,
        status: 'draft',
      });

      // ── Step 2: Auto-test the plan ──
      const hasHumanInputSteps = planResult.steps.some((s: any) => s.type === 'human_input');

      if (!hasHumanInputSteps && planResult.steps.length > 0) {
        const MAX_FIX_ATTEMPTS = 3;
        let currentSteps = planResult.steps;
        let currentMemory = planResult.agentMemory;
        let autoTestPassed = false;

        for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
          onLog({ timestamp: Date.now(), type: 'thinking', message: `Auto-testing plan (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS + 1})...` });

          const finalRun = await executePlan(saved.id, (progress) => {
            emitJobEvent(job, 'plan_progress', progress);
          }, 'auto_test');

          if (finalRun.status === 'completed') {
            onLog({ timestamp: Date.now(), type: 'done', message: 'Auto-test passed! Plan is verified and working.' });
            autoTestPassed = true;
            updateTestPlan(saved.id, { status: 'approved' });

            if (attempt > 0) {
              const stepsBeforeFix = planResult.steps;
              const firstFailedResults = JSON.parse(finalRun.step_results || '[]');
              extractAndStoreLessons(
                pieceName, piece.displayName,
                stepsBeforeFix, firstFailedResults, currentSteps,
              ).then(lessons => {
                if (lessons.length > 0) {
                  console.log(`[lessons] Extracted ${lessons.length} lesson(s) for ${pieceName} from auto-fix.`);
                }
              }).catch(() => {});
            }

            emitJobEvent(job, 'result', {
              planId: saved.id,
              steps: currentSteps,
              note: planResult.note,
              agentMemory: currentMemory,
              status: 'approved',
              autoTestPassed: true,
              autoTestAttempts: attempt + 1,
            });
            break;
          }

          if (attempt >= MAX_FIX_ATTEMPTS) {
            onLog({ timestamp: Date.now(), type: 'error', message: `Auto-test still failing after ${MAX_FIX_ATTEMPTS + 1} attempt(s). You can run "Fix with AI" manually.` });
            break;
          }

          onLog({ timestamp: Date.now(), type: 'thinking', message: 'Auto-test failed, running AI fix agent...' });
          const stepResults = JSON.parse(finalRun.step_results || '[]');

          const fixResult = await fixTestPlanWithAi(
            piece, actionName, currentSteps, stepResults, currentMemory, onLog,
          );

          updateTestPlan(saved.id, {
            steps: JSON.stringify(fixResult.steps),
            agent_memory: fixResult.agentMemory || currentMemory || '',
          });

          currentSteps = fixResult.steps;
          currentMemory = fixResult.agentMemory || currentMemory;

          emitJobEvent(job, 'result', {
            planId: saved.id,
            steps: fixResult.steps,
            note: fixResult.note || planResult.note,
            agentMemory: fixResult.agentMemory,
            status: 'draft',
          });
        }

        if (!autoTestPassed) {
          console.log(`[ai-plan] Auto-test did not pass for ${actionName} after all attempts.`);
        }
      } else if (hasHumanInputSteps) {
        onLog({ timestamp: Date.now(), type: 'thinking', message: 'Plan has human_input steps — skipping auto-test (requires manual input).' });
      }

      emitJobEvent(job, 'done', {});
      completeJob(job, 'done');
    } catch (err: any) {
      console.error(`[ai-plan] Background job error for ${actionName}:`, err.message);
      emitJobEvent(job, 'error', { message: err.message || 'Unknown error' });
      emitJobEvent(job, 'done', {});
      completeJob(job, 'error');
    }
  })();
}

// ── AI test plan creation via SSE (background job) ──
router.get('/:name/actions/:action/ai-plan', async (req, res) => {
  req.setTimeout(600_000);
  const sendEvent = setupSSE(res);
  const pieceName = req.params.name;
  const actionName = req.params.action;

  let existingJob = getJob(pieceName, actionName);

  if (existingJob && existingJob.status === 'running') {
    // Job already running — subscribe to it (replays buffered events)
    console.log(`[ai-plan] Client reconnecting to running job for ${actionName}`);
    const unsubscribe = subscribeToJobWithCleanup(existingJob, sendEvent, () => res.end());
    res.on('close', () => { unsubscribe(); console.log(`[ai-plan] Client disconnected from ${actionName} (job continues)`); });
    return;
  }

  // Start new background job
  const previousMemory = req.query.memory as string | undefined;
  const job = createJob(pieceName, actionName);
  runPlanJobInBackground(job, pieceName, actionName, previousMemory);

  // Subscribe this client to the job
  const unsubscribe = subscribeToJobWithCleanup(job, sendEvent, () => res.end());
  res.on('close', () => { unsubscribe(); console.log(`[ai-plan] Client disconnected from ${actionName} (job continues in background)`); });
});

// ── Check active AI plan jobs for a piece ──
router.get('/:name/ai-plan-jobs', (req, res) => {
  res.json(getActiveJobsForPiece(req.params.name));
});

// ── Subscribe to an existing AI plan job (reconnect) ──
router.get('/:name/actions/:action/ai-plan/subscribe', (req, res) => {
  const job = getJob(req.params.name, req.params.action);
  if (!job) {
    res.status(404).json({ error: 'No active job for this action' });
    return;
  }

  req.setTimeout(600_000);
  const sendEvent = setupSSE(res);
  const unsubscribe = subscribeToJobWithCleanup(job, sendEvent, () => res.end());
  res.on('close', () => { unsubscribe(); });
});

// ── Fix failed test plan via SSE ──
router.post('/:name/actions/:action/ai-plan-fix', async (req, res) => {
  req.setTimeout(300_000);
  const sendEvent = setupSSE(res);

  const ac = new AbortController();
  res.on('close', () => { ac.abort(); console.log(`[ai-plan-fix] Client disconnected for ${req.params.action}, aborting agent.`); });

  try {
    const client = createClient();
    const piece = await client.getPieceMetadata(req.params.name);
    const actionName = req.params.action;

    if (!piece.actions[actionName]) {
      sendEvent('error', { message: `Action "${actionName}" not found` });
      res.end();
      return;
    }

    const { previousSteps, stepResults, agentMemory } = req.body;
    if (!previousSteps || !stepResults) {
      sendEvent('error', { message: 'previousSteps and stepResults are required' });
      res.end();
      return;
    }

    const onLog = (log: AgentLogEntry) => { if (!ac.signal.aborted) sendEvent('log', log); };
    const planResult = await fixTestPlanWithAi(piece, actionName, previousSteps, stepResults, agentMemory, onLog, ac.signal);

    if (ac.signal.aborted) {
      res.end();
      return;
    }

    // Update existing plan in DB
    const existing = getTestPlanByAction(req.params.name, actionName);
    let saved;
    if (existing) {
      saved = updateTestPlan(existing.id, {
        steps: JSON.stringify(planResult.steps),
        agent_memory: planResult.agentMemory || existing.agent_memory,
      });
    } else {
      saved = createTestPlan({
        piece_name: req.params.name,
        target_action: actionName,
        steps: JSON.stringify(planResult.steps),
        status: 'draft',
        agent_memory: planResult.agentMemory || '',
      });
    }

    // Extract lessons asynchronously (non-blocking) — manual fix path
    extractAndStoreLessons(
      req.params.name, piece.displayName,
      previousSteps, stepResults, planResult.steps,
    ).then(lessons => {
      if (lessons.length > 0) {
        console.log(`[lessons] Extracted ${lessons.length} lesson(s) for ${req.params.name} from manual fix.`);
      }
    }).catch(() => {});

    sendEvent('result', {
      planId: saved!.id,
      steps: planResult.steps,
      note: planResult.note,
      agentMemory: planResult.agentMemory,
      status: saved!.status,
    });
    sendEvent('done', {});
  } catch (err: any) {
    if (ac.signal.aborted) {
      console.log(`[ai-plan-fix] Agent for ${req.params.action} aborted (client disconnect).`);
    } else {
      console.error('[ai-plan-fix] SSE error:', err.message);
      sendEvent('error', { message: err.message || 'Unknown error' });
    }
  }

  res.end();
});

// ══════════════════════════════════════════════════════════════
// Plan Creator v2 routes (multi-agent orchestration)
// ══════════════════════════════════════════════════════════════

function runPlanJobV2InBackground(job: PlanJob, pieceName: string, actionName: string, previousMemory?: string) {
  (async () => {
    try {
      const client = createClient();
      const piece = await client.getPieceMetadata(pieceName);

      if (!piece.actions[actionName]) {
        emitJobEvent(job, 'error', { message: `Action "${actionName}" not found` });
        emitJobEvent(job, 'done', {});
        completeJob(job, 'error');
        return;
      }

      const onLog = (log: V2LogEntry) => emitJobEvent(job, 'log', log);

      const planResult = await createTestPlanV2({
        pieceMeta: piece,
        actionName,
        previousMemory: previousMemory || undefined,
        onLog,
      });

      const saved = createTestPlan({
        piece_name: pieceName,
        target_action: actionName,
        steps: JSON.stringify(planResult.steps),
        status: 'draft',
        agent_memory: planResult.agentMemory || '',
      });

      emitJobEvent(job, 'result', {
        planId: saved.id,
        steps: planResult.steps,
        note: planResult.note,
        agentMemory: planResult.agentMemory,
        status: 'draft',
        version: 'v2',
      });

      // Auto-test the plan (same logic as v1)
      const hasHumanInputSteps = planResult.steps.some((s: any) => s.type === 'human_input');

      if (!hasHumanInputSteps && planResult.steps.length > 0) {
        const MAX_FIX_ATTEMPTS = 3;
        let currentSteps = planResult.steps;
        let currentMemory = planResult.agentMemory;
        let autoTestPassed = false;

        for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
          onLog({ timestamp: Date.now(), type: 'thinking', role: 'coordinator', message: `Auto-testing plan (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS + 1})...` });

          const finalRun = await executePlan(saved.id, (progress) => {
            emitJobEvent(job, 'plan_progress', progress);
          }, 'auto_test');

          if (finalRun.status === 'completed') {
            onLog({ timestamp: Date.now(), type: 'done', role: 'coordinator', message: 'Auto-test passed! Plan is verified and working.' });
            autoTestPassed = true;
            updateTestPlan(saved.id, { status: 'approved' });

            if (attempt > 0) {
              extractAndStoreLessons(
                pieceName, piece.displayName,
                planResult.steps, JSON.parse(finalRun.step_results || '[]'), currentSteps,
              ).catch(() => {});
            }

            emitJobEvent(job, 'result', {
              planId: saved.id,
              steps: currentSteps,
              note: planResult.note,
              agentMemory: currentMemory,
              status: 'approved',
              autoTestPassed: true,
              autoTestAttempts: attempt + 1,
              version: 'v2',
            });
            break;
          }

          if (attempt >= MAX_FIX_ATTEMPTS) {
            onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: `Auto-test still failing after ${MAX_FIX_ATTEMPTS + 1} attempt(s).` });
            break;
          }

          onLog({ timestamp: Date.now(), type: 'thinking', role: 'coordinator', message: 'Auto-test failed, running v2 fixer...' });
          const stepResults = JSON.parse(finalRun.step_results || '[]');
          const brokenMappings = detectBrokenInputMappings(currentSteps, stepResults);

          const fixResult = await fixTestPlanV2({
            pieceMeta: piece,
            actionName,
            previousSteps: currentSteps,
            stepResults,
            brokenMappings,
            agentMemory: currentMemory,
            onLog,
          });

          updateTestPlan(saved.id, {
            steps: JSON.stringify(fixResult.steps),
            agent_memory: fixResult.agentMemory || currentMemory || '',
          });

          currentSteps = fixResult.steps;
          currentMemory = fixResult.agentMemory || currentMemory;

          emitJobEvent(job, 'result', {
            planId: saved.id,
            steps: fixResult.steps,
            note: fixResult.note || planResult.note,
            agentMemory: fixResult.agentMemory,
            status: 'draft',
            version: 'v2',
          });
        }
      } else if (hasHumanInputSteps) {
        onLog({ timestamp: Date.now(), type: 'thinking', role: 'coordinator', message: 'Plan has human_input steps — skipping auto-test.' });
      }

      emitJobEvent(job, 'done', {});
      completeJob(job, 'done');
    } catch (err: any) {
      console.error(`[ai-plan-v2] Background job error for ${actionName}:`, err.message);
      emitJobEvent(job, 'error', { message: err.message || 'Unknown error' });
      emitJobEvent(job, 'done', {});
      completeJob(job, 'error');
    }
  })();
}

router.get('/:name/actions/:action/ai-plan-v2', async (req, res) => {
  req.setTimeout(600_000);
  const sendEvent = setupSSE(res);
  const pieceName = req.params.name;
  const actionName = req.params.action;

  const jobKey = `v2:${actionName}`;
  let existingJob = getJob(pieceName, jobKey);

  if (existingJob && existingJob.status === 'running') {
    console.log(`[ai-plan-v2] Client reconnecting to running job for ${actionName}`);
    const unsubscribe = subscribeToJobWithCleanup(existingJob, sendEvent, () => res.end());
    res.on('close', () => { unsubscribe(); });
    return;
  }

  const previousMemory = req.query.memory as string | undefined;
  const job = createJob(pieceName, jobKey);
  runPlanJobV2InBackground(job, pieceName, actionName, previousMemory);

  const unsubscribe = subscribeToJobWithCleanup(job, sendEvent, () => res.end());
  res.on('close', () => { unsubscribe(); console.log(`[ai-plan-v2] Client disconnected from ${actionName} (job continues)`); });
});

router.post('/:name/actions/:action/ai-plan-fix-v2', async (req, res) => {
  req.setTimeout(300_000);
  const sendEvent = setupSSE(res);

  const ac = new AbortController();
  res.on('close', () => { ac.abort(); });

  try {
    const client = createClient();
    const piece = await client.getPieceMetadata(req.params.name);
    const actionName = req.params.action;

    if (!piece.actions[actionName]) {
      sendEvent('error', { message: `Action "${actionName}" not found` });
      res.end();
      return;
    }

    const { previousSteps, stepResults, agentMemory } = req.body;
    if (!previousSteps || !stepResults) {
      sendEvent('error', { message: 'previousSteps and stepResults are required' });
      res.end();
      return;
    }

    const brokenMappings = detectBrokenInputMappings(previousSteps, stepResults);
    const onLog = (log: V2LogEntry) => { if (!ac.signal.aborted) sendEvent('log', log); };
    const planResult = await fixTestPlanV2({
      pieceMeta: piece,
      actionName,
      previousSteps,
      stepResults,
      brokenMappings,
      agentMemory,
      onLog,
      abortSignal: ac.signal,
    });

    if (ac.signal.aborted) { res.end(); return; }

    const existing = getTestPlanByAction(req.params.name, actionName);
    let saved;
    if (existing) {
      saved = updateTestPlan(existing.id, {
        steps: JSON.stringify(planResult.steps),
        agent_memory: planResult.agentMemory || existing.agent_memory,
      });
    } else {
      saved = createTestPlan({
        piece_name: req.params.name,
        target_action: actionName,
        steps: JSON.stringify(planResult.steps),
        status: 'draft',
        agent_memory: planResult.agentMemory || '',
      });
    }

    extractAndStoreLessons(
      req.params.name, piece.displayName,
      previousSteps, stepResults, planResult.steps,
    ).catch(() => {});

    sendEvent('result', {
      planId: saved!.id,
      steps: planResult.steps,
      note: planResult.note,
      agentMemory: planResult.agentMemory,
      status: saved!.status,
      version: 'v2',
    });
    sendEvent('done', {});
  } catch (err: any) {
    if (!ac.signal.aborted) {
      console.error('[ai-plan-fix-v2] SSE error:', err.message);
      sendEvent('error', { message: err.message || 'Unknown error' });
    }
  }

  res.end();
});

// ── Piece Lessons API ──

router.get('/:name/lessons', (req, res) => {
  res.json(getLessonsForPiece(req.params.name));
});

router.post('/:name/lessons', (req, res) => {
  const { lesson } = req.body;
  if (!lesson || typeof lesson !== 'string') return res.status(400).json({ error: 'lesson text required' });
  const row = addLesson(req.params.name, lesson.trim(), 'manual');
  res.json(row);
});

router.delete('/:name/lessons/:id', (req, res) => {
  const ok = deleteLesson(parseInt(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Lesson not found' });
  res.json({ success: true });
});

export default router;

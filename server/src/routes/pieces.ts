import { Router } from 'express';
import { createClient } from '../services/test-engine.js';
import { ActivepiecesClient } from '../services/ap-client.js';
import { generateTestConfig } from '../services/test-config-generator.js';
import { configureActionWithAi, fixActionWithAi, createTestPlanWithAi, fixTestPlanWithAi, type AgentLogEntry, type AiActionResult } from '../services/ai-config-generator.js';
import { createTestPlan, getTestPlanByAction, updateTestPlan, getLessonsForPiece, deleteLesson, addLesson } from '../db/queries.js';
import { executePlan } from '../services/plan-executor.js';
import { extractAndStoreLessons } from '../services/lesson-extractor.js';

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

// ── AI test plan creation via SSE ──
router.get('/:name/actions/:action/ai-plan', async (req, res) => {
  req.setTimeout(600_000); // 10 min: plan creation + auto-test + up to 2 fix attempts
  const sendEvent = setupSSE(res);

  const ac = new AbortController();
  res.on('close', () => { ac.abort(); console.log(`[ai-plan] Client disconnected for ${req.params.action}, aborting agent.`); });

  try {
    const client = createClient();
    const piece = await client.getPieceMetadata(req.params.name);
    const actionName = req.params.action;

    if (!piece.actions[actionName]) {
      sendEvent('error', { message: `Action "${actionName}" not found` });
      res.end();
      return;
    }

    const previousMemory = req.query.memory as string | undefined;
    const onLog = (log: AgentLogEntry) => { if (!ac.signal.aborted) sendEvent('log', log); };

    // ── Step 1: Create plan ──
    const planResult = await createTestPlanWithAi(piece, actionName, onLog, previousMemory || undefined, ac.signal);

    if (ac.signal.aborted) {
      console.log(`[ai-plan] Agent for ${actionName} aborted, skipping DB save.`);
      res.end();
      return;
    }

    // Save to DB
    const saved = createTestPlan({
      piece_name: req.params.name,
      target_action: actionName,
      steps: JSON.stringify(planResult.steps),
      status: 'draft',
      agent_memory: planResult.agentMemory || '',
    });

    // Send initial plan so the client can display it immediately
    sendEvent('result', {
      planId: saved.id,
      steps: planResult.steps,
      note: planResult.note,
      agentMemory: planResult.agentMemory,
      status: 'draft',
    });

    // ── Step 2: Auto-test the plan ──
    // Only skip if the plan needs genuine human input — approval steps run automatically in auto_test.
    const hasHumanInputSteps = planResult.steps.some(s => s.type === 'human_input');

    if (!hasHumanInputSteps && planResult.steps.length > 0) {
      const MAX_FIX_ATTEMPTS = 3; // 4 total executions max (1 initial + 3 fix attempts)
      let currentSteps = planResult.steps;
      let currentMemory = planResult.agentMemory;
      let autoTestPassed = false;

      for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        if (ac.signal.aborted) break;

        onLog({ timestamp: Date.now(), type: 'thinking', message: `Auto-testing plan (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS + 1})...` });

        const finalRun = await executePlan(saved.id, (progress) => {
          if (!ac.signal.aborted) sendEvent('plan_progress', progress);
        }, 'auto_test');

        if (ac.signal.aborted) break;

        if (finalRun.status === 'completed') {
          onLog({ timestamp: Date.now(), type: 'done', message: 'Auto-test passed! Plan is verified and working.' });
          autoTestPassed = true;

          // Auto-approve since it passed
          updateTestPlan(saved.id, { status: 'approved' });

          // If the plan required fixes before passing, extract lessons asynchronously
          if (attempt > 0) {
            const stepsBeforeFix = planResult.steps;
            const firstFailedResults = JSON.parse(finalRun.step_results || '[]');
            extractAndStoreLessons(
              req.params.name, piece.displayName,
              stepsBeforeFix, firstFailedResults, currentSteps,
            ).then(lessons => {
              if (lessons.length > 0) {
                console.log(`[lessons] Extracted ${lessons.length} lesson(s) for ${req.params.name} from auto-fix.`);
              }
            }).catch(() => {});
          }

          sendEvent('result', {
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

        // ── Auto-fix ──
        onLog({ timestamp: Date.now(), type: 'thinking', message: 'Auto-test failed, running AI fix agent...' });
        const stepResults = JSON.parse(finalRun.step_results || '[]');

        const fixResult = await fixTestPlanWithAi(
          piece, actionName, currentSteps, stepResults, currentMemory, onLog, ac.signal,
        );

        if (ac.signal.aborted) break;

        // Persist fixed steps
        updateTestPlan(saved.id, {
          steps: JSON.stringify(fixResult.steps),
          agent_memory: fixResult.agentMemory || currentMemory || '',
        });

        currentSteps = fixResult.steps;
        currentMemory = fixResult.agentMemory || currentMemory;

        // Send updated plan so client sees the fixed version
        sendEvent('result', {
          planId: saved.id,
          steps: fixResult.steps,
          note: fixResult.note || planResult.note,
          agentMemory: fixResult.agentMemory,
          status: 'draft',
        });
      }

      if (!autoTestPassed && !ac.signal.aborted) {
        // Keep draft status, user can fix manually
        console.log(`[ai-plan] Auto-test did not pass for ${actionName} after all attempts.`);
      }
    } else if (hasHumanInputSteps) {
      onLog({ timestamp: Date.now(), type: 'thinking', message: 'Plan has human_input steps — skipping auto-test (requires manual input).' });
    }

    if (!ac.signal.aborted) sendEvent('done', {});
  } catch (err: any) {
    if (ac.signal.aborted) {
      console.log(`[ai-plan] Agent for ${req.params.action} aborted (client disconnect).`);
    } else {
      console.error('[ai-plan] SSE error:', err.message);
      sendEvent('error', { message: err.message || 'Unknown error' });
    }
  }

  res.end();
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

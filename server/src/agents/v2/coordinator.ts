/**
 * Coordinator -- the brain of Plan Creator v2.
 *
 * Implements a phased workflow:
 * 1. Research (parallel workers)
 * 2. Synthesis (coordinator reads findings, writes precise spec)
 * 3. Planning (planner worker creates the plan)
 * 4. Verification (verifier worker tries to break the plan)
 * 5. Fix loop (if verification fails, up to N attempts)
 */

import type { PieceMetadataFull } from '../../services/ap-client.js';
import type {
  OnLogCallback, TestPlanResult, CoordinatorState,
  ResearchFindings, VerificationResult, TestPlanStep,
} from './types.js';
import type { BrokenMapping } from './tools/inspect-output.js';
import { runResearchWorker } from './workers/research.js';
import { runPlannerWorker } from './workers/planner.js';
import { runVerifierWorker } from './workers/verifier.js';
import { runFixerWorker } from './workers/fixer.js';
import { synthesizePlannerSpec, parseResearchFindings } from './prompts/coordinator.js';
import { CostTracker } from './cost-tracker.js';

const MAX_FIX_ATTEMPTS = 2;
const WRITE_HEAVY_ACTION_RE = /(^|_)(send|create|update|delete|archive|move|reply|post|insert|remove|upload|draft)(_|$)/i;

interface DeterministicPlanValidationResult {
  ok: boolean;
  issues: string[];
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Coordinator aborted: client disconnected');
}

function validatePlanDeterministically(actionName: string, steps: TestPlanStep[], targetEffect: 'read' | 'write' | 'unknown'): DeterministicPlanValidationResult {
  const issues: string[] = [];
  const testSteps = steps.filter(step => step.type === 'test');

  if (testSteps.length !== 1) {
    issues.push(`Expected exactly one test step, found ${testSteps.length}.`);
  }

  if (targetEffect === 'read') {
    for (const step of steps) {
      if (step.type === 'test' || step.type === 'human_input') {
        continue;
      }
      if (WRITE_HEAVY_ACTION_RE.test(step.actionName)) {
        issues.push(
          `Read-only target action "${actionName}" should not include write-heavy ${step.type} step "${step.id}" using action "${step.actionName}".`,
        );
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

function inferTargetEffect(actionName: string, targetEffect: 'read' | 'write' | 'unknown'): 'read' | 'write' | 'unknown' {
  if (targetEffect !== 'unknown') {
    return targetEffect;
  }
  if (/(^|_)(get|find|search|list|fetch|lookup|read|retrieve|view|check|inspect)(_|$)/i.test(actionName)) {
    return 'read';
  }
  if (WRITE_HEAVY_ACTION_RE.test(actionName)) {
    return 'write';
  }
  return 'unknown';
}

/**
 * Create a new test plan using the multi-agent v2 system.
 */
export async function createTestPlanV2(params: {
  pieceMeta: PieceMetadataFull;
  actionName: string;
  previousMemory?: string;
  onLog: OnLogCallback;
  abortSignal?: AbortSignal;
}): Promise<TestPlanResult & { costSummary?: ReturnType<CostTracker['getTotals']> }> {
  const { pieceMeta, actionName, previousMemory, onLog, abortSignal } = params;

  const costTracker = new CostTracker({
    pieceName: pieceMeta.name,
    actionName,
    operation: 'create',
    version: 'v2',
  });

  const state: CoordinatorState = {
    phases: [],
    fixAttempts: 0,
    maxFixAttempts: MAX_FIX_ATTEMPTS,
  };

  function logPhase(name: CoordinatorState['phases'][0]['name'], message: string) {
    onLog({ timestamp: Date.now(), type: 'phase', role: 'coordinator', message, detail: name });
  }

  function withCost<T extends TestPlanResult>(plan: T): T & { costSummary: ReturnType<CostTracker['getTotals']> } {
    const totals = costTracker.getTotals();
    onLog({ timestamp: Date.now(), type: 'done', role: 'coordinator', message: `Total cost: $${totals.cost_usd.toFixed(4)} (${totals.requests} API calls, ${totals.input_tokens + totals.output_tokens} tokens)` });
    return { ...plan, costSummary: totals };
  }

  // ── Phase 1: Research ──
  logPhase('research', 'Phase 1: Starting research worker...');
  state.phases.push({ name: 'research', startedAt: Date.now() });
  checkAborted(abortSignal);

  onLog({ timestamp: Date.now(), type: 'worker_spawn', role: 'coordinator', message: 'Spawning research worker to analyze source code and explore API...' });

  let findings: ResearchFindings;
  try {
    findings = await runResearchWorker({
      pieceMeta,
      actionName,
      previousMemory,
      onLog,
      abortSignal,
      costTracker,
    });
    state.researchFindings = findings;
  } catch (err: any) {
    if (err.message?.includes('aborted')) throw err;
    onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: `Research worker failed: ${err.message}. Proceeding with minimal context.` });
    findings = {
      targetEffect: 'unknown',
      sourceAnalysis: { actionFile: null, pieceSourceSummary: '', requiredProps: [], optionalProps: [], dropdownValues: {}, outputShape: '', helperNotes: '' },
      discoveredResources: [],
      recommendations: '',
    };
  }

  onLog({ timestamp: Date.now(), type: 'worker_complete', role: 'coordinator', message: `Research complete. Found ${findings.discoveredResources.length} resources.` });
  state.phases[state.phases.length - 1].completedAt = Date.now();

  // ── Phase 2: Synthesis ──
  logPhase('synthesis', 'Phase 2: Synthesizing research into planner spec...');
  state.phases.push({ name: 'synthesis', startedAt: Date.now() });
  checkAborted(abortSignal);

  const synthesizedSpec = synthesizePlannerSpec(pieceMeta, actionName, findings, previousMemory);
  const effectiveTargetEffect = inferTargetEffect(actionName, findings.targetEffect);
  state.synthesizedSpec = synthesizedSpec;

  onLog({ timestamp: Date.now(), type: 'decision', role: 'coordinator', message: `Synthesized spec (${synthesizedSpec.length} chars) with ${findings.discoveredResources.length} resources and research findings.` });
  state.phases[state.phases.length - 1].completedAt = Date.now();

  // ── Phase 3: Planning ──
  logPhase('planning', 'Phase 3: Spawning planner worker...');
  state.phases.push({ name: 'planning', startedAt: Date.now() });
  checkAborted(abortSignal);

  onLog({ timestamp: Date.now(), type: 'worker_spawn', role: 'coordinator', message: 'Spawning planner worker with synthesized spec...' });

  let plan: TestPlanResult;
  try {
    plan = await runPlannerWorker({
      pieceMeta,
      actionName,
      synthesizedSpec,
      onLog,
      abortSignal,
      costTracker,
    });
  } catch (err: any) {
    if (err.message?.includes('aborted')) throw err;
    onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: `Planner worker failed: ${err.message}` });
    return withCost({ steps: [], note: `Plan creation failed: ${err.message}`, agentMemory: undefined });
  }

  if (plan.steps.length === 0) {
    onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: 'Planner produced an empty plan.' });
    return withCost(plan);
  }

  const deterministicValidation = validatePlanDeterministically(actionName, plan.steps, effectiveTargetEffect);

  onLog({ timestamp: Date.now(), type: 'worker_complete', role: 'coordinator', message: `Planner created a ${plan.steps.length}-step plan.` });
  state.plan = plan;
  state.phases[state.phases.length - 1].completedAt = Date.now();

  // ── Phase 4: Verification ──
  logPhase('verification', 'Phase 4: Spawning verifier worker...');
  state.phases.push({ name: 'verification', startedAt: Date.now() });
  checkAborted(abortSignal);

  onLog({ timestamp: Date.now(), type: 'worker_spawn', role: 'coordinator', message: 'Spawning verifier worker to adversarially validate the plan...' });

  let verification: VerificationResult;
  try {
    verification = await runVerifierWorker({
      pieceMeta,
      actionName,
      steps: plan.steps,
      planNote: plan.note,
      onLog,
      abortSignal,
      costTracker,
    });
    state.verification = verification;
  } catch (err: any) {
    if (err.message?.includes('aborted')) throw err;
    onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: `Verifier failed: ${err.message}. Accepting plan without verification.` });
    state.phases[state.phases.length - 1].completedAt = Date.now();
    return withCost(plan);
  }

  onLog({
    timestamp: Date.now(), type: 'worker_complete', role: 'coordinator',
    message: `Verification verdict: ${verification.verdict} (${verification.issues.length} issues)`,
    detail: verification.summary,
  });
  state.phases[state.phases.length - 1].completedAt = Date.now();

  // ── Phase 5: Fix loop (if verification failed) ──
  let currentPlan = plan;
  let currentVerification = verification;

  if (!deterministicValidation.ok) {
    for (const issue of deterministicValidation.issues) {
      onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: issue });
    }
    currentVerification = {
      verdict: 'FAIL',
      issues: deterministicValidation.issues.map(message => ({ severity: 'error', message })),
      summary: 'Deterministic validation rejected the planner output.',
    };
  } else if (verification.verdict === 'PASS') {
    logPhase('complete', 'Plan verified successfully. Done.');
    return withCost(plan);
  }

  while (state.fixAttempts < state.maxFixAttempts) {
    state.fixAttempts++;
    logPhase('fixing', `Phase 5: Fix attempt ${state.fixAttempts}/${state.maxFixAttempts}...`);
    state.phases.push({ name: 'fixing', startedAt: Date.now() });
    checkAborted(abortSignal);

    onLog({
      timestamp: Date.now(), type: 'worker_spawn', role: 'coordinator',
      message: `Spawning fixer worker (attempt ${state.fixAttempts}) to address ${currentVerification.issues.length} issues...`,
    });

    let fixedPlan: TestPlanResult;
    try {
      fixedPlan = await runFixerWorker({
        pieceMeta,
        actionName,
        previousSteps: currentPlan.steps,
        verificationResult: currentVerification,
        agentMemory: currentPlan.agentMemory,
        onLog,
        abortSignal,
        costTracker,
      });
    } catch (err: any) {
      if (err.message?.includes('aborted')) throw err;
      onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: `Fixer failed: ${err.message}. Returning last plan.` });
      break;
    }

    if (fixedPlan.steps.length === 0) {
      onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: 'Fixer produced empty plan. Returning previous plan.' });
      break;
    }

    onLog({ timestamp: Date.now(), type: 'worker_complete', role: 'coordinator', message: `Fixer produced a ${fixedPlan.steps.length}-step plan.` });
    state.phases[state.phases.length - 1].completedAt = Date.now();

    // Re-verify the fixed plan
    checkAborted(abortSignal);
    onLog({ timestamp: Date.now(), type: 'worker_spawn', role: 'coordinator', message: 'Re-verifying fixed plan...' });

    try {
      const reVerification = await runVerifierWorker({
        pieceMeta,
        actionName,
        steps: fixedPlan.steps,
        planNote: fixedPlan.note,
        onLog,
        abortSignal,
        costTracker,
      });

      onLog({
        timestamp: Date.now(), type: 'worker_complete', role: 'coordinator',
        message: `Re-verification verdict: ${reVerification.verdict}`,
      });

      const reValidation = validatePlanDeterministically(actionName, fixedPlan.steps, effectiveTargetEffect);
      if (!reValidation.ok) {
        for (const issue of reValidation.issues) {
          onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: issue });
        }
        currentPlan = fixedPlan;
        currentVerification = {
          verdict: 'FAIL',
          issues: reValidation.issues.map(message => ({ severity: 'error', message })),
          summary: 'Deterministic validation rejected the fixed plan.',
        };
        continue;
      }

      if (reVerification.verdict === 'PASS') {
        logPhase('complete', 'Fixed plan verified successfully. Done.');
        return withCost(fixedPlan);
      }

      currentPlan = fixedPlan;
      currentVerification = reVerification;
    } catch (err: any) {
      if (err.message?.includes('aborted')) throw err;
      onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: `Re-verification failed: ${err.message}. Returning fixed plan.` });
      return withCost(fixedPlan);
    }
  }

  onLog({
    timestamp: Date.now(), type: 'done', role: 'coordinator',
    message: `Returning plan after ${state.fixAttempts} fix attempts. Last verdict: ${currentVerification.verdict}`,
  });
  return withCost(currentPlan);
}

/**
 * Fix a failed test plan (post-execution failure) using the v2 system.
 */
export async function fixTestPlanV2(params: {
  pieceMeta: PieceMetadataFull;
  actionName: string;
  previousSteps: TestPlanStep[];
  stepResults: { stepId: string; status: string; output: unknown; error: string | null; duration_ms: number }[];
  brokenMappings?: BrokenMapping[];
  agentMemory?: string;
  onLog: OnLogCallback;
  abortSignal?: AbortSignal;
}): Promise<TestPlanResult & { costSummary?: ReturnType<CostTracker['getTotals']> }> {
  const { pieceMeta, actionName, onLog, abortSignal } = params;

  const costTracker = new CostTracker({
    pieceName: pieceMeta.name,
    actionName,
    operation: 'fix',
    version: 'v2',
  });

  function withCost<T extends TestPlanResult>(plan: T): T & { costSummary: ReturnType<CostTracker['getTotals']> } {
    const totals = costTracker.getTotals();
    onLog({ timestamp: Date.now(), type: 'done', role: 'coordinator', message: `Fix cost: $${totals.cost_usd.toFixed(4)} (${totals.requests} API calls, ${totals.input_tokens + totals.output_tokens} tokens)` });
    return { ...plan, costSummary: totals };
  }

  onLog({ timestamp: Date.now(), type: 'phase', role: 'coordinator', message: 'Fixing failed plan (post-execution)...' });
  onLog({ timestamp: Date.now(), type: 'worker_spawn', role: 'coordinator', message: 'Spawning fixer worker with execution results...' });

  let fixedPlan: TestPlanResult;
  try {
    fixedPlan = await runFixerWorker({
      pieceMeta,
      actionName,
      previousSteps: params.previousSteps,
      stepResults: params.stepResults,
      brokenMappings: params.brokenMappings,
      agentMemory: params.agentMemory,
      onLog,
      abortSignal,
      costTracker,
    });
  } catch (err: any) {
    if (err.message?.includes('aborted')) throw err;
    onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: `Fixer failed: ${err.message}` });
    return withCost({ steps: params.previousSteps, note: 'Fix attempt failed.', agentMemory: params.agentMemory });
  }

  onLog({ timestamp: Date.now(), type: 'worker_complete', role: 'coordinator', message: `Fixer produced a ${fixedPlan.steps.length}-step plan.` });

  // Verify the fix
  onLog({ timestamp: Date.now(), type: 'worker_spawn', role: 'coordinator', message: 'Verifying fixed plan...' });

  try {
    const verification = await runVerifierWorker({
      pieceMeta,
      actionName,
      steps: fixedPlan.steps,
      planNote: fixedPlan.note,
      onLog,
      abortSignal,
      costTracker,
    });

    onLog({
      timestamp: Date.now(), type: 'worker_complete', role: 'coordinator',
      message: `Verification verdict: ${verification.verdict}`,
      detail: verification.summary,
    });

    if (verification.verdict === 'FAIL' && verification.issues.some(i => i.severity === 'error')) {
      onLog({ timestamp: Date.now(), type: 'worker_spawn', role: 'coordinator', message: 'Fix has issues, attempting one more fix...' });

      try {
        const reFix = await runFixerWorker({
          pieceMeta,
          actionName,
          previousSteps: fixedPlan.steps,
          verificationResult: verification,
          agentMemory: fixedPlan.agentMemory,
          onLog,
          abortSignal,
          costTracker,
        });
        if (reFix.steps.length > 0) fixedPlan = reFix;
      } catch { /* use previous fixed plan */ }
    }
  } catch (err: any) {
    if (err.message?.includes('aborted')) throw err;
    onLog({ timestamp: Date.now(), type: 'error', role: 'coordinator', message: `Verification failed: ${err.message}. Returning fixed plan without verification.` });
  }

  onLog({ timestamp: Date.now(), type: 'done', role: 'coordinator', message: 'Fix complete.' });
  return withCost(fixedPlan);
}

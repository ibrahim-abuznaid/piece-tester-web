/**
 * Plan Executor -- runs multi-step test plans sequentially,
 * resolving inputMapping between steps, and pausing for human-in-the-loop.
 */

import { EventEmitter } from 'events';
import {
  createPlanRun, getPlanRun, updatePlanRun,
  getTestPlan, getConnectionByPiece, type TestPlanRunRow, type WaveInfo,
} from '../db/queries.js';
import { executeActionOnAP, type TestPlanStep, type PlanAssertion } from './ai-config-generator.js';
import {
  executeTriggerOnAP, armTriggerSimulation, captureTriggerEvents, cancelTriggerSimulation,
  type TriggerSimContext,
} from './trigger-engine.js';
import { createClient } from './test-engine.js';
import { checkImportedConnectionHealth } from './connection-health.js';
import type { PieceMetadataFull } from './ap-client.js';

// ── Types ──

/**
 * Why a thrown step failed, classified deterministically from the error
 * (status codes + message) — NOT by an LLM. Lets a red be read honestly:
 * an expired token is `auth`, a 500 is `transient`, a real piece bug is
 * `piece_error`. Only `piece_error` (and `unknown`) implicate the piece.
 */
export type ErrorCategory = 'auth' | 'rate_limit' | 'transient' | 'bad_request' | 'not_found' | 'piece_error' | 'unknown';

/** The evaluated result of one output assertion against a step's output. */
export interface AssertionResult {
  path: string;
  op: string;
  expected?: unknown;
  actual?: unknown;
  passed: boolean;
  description?: string;
}

export interface StepResult {
  stepId: string;
  label?: string;   // human-readable step label (e.g. "Create test ticket")
  status: 'pending' | 'running' | 'completed' | 'failed' | 'assert_failed' | 'skipped' | 'waiting';
  output: unknown;
  error: string | null;
  duration_ms: number;
  humanResponse?: string;
  /** Live progress log lines (e.g. webhook subscribe/receive during trigger steps). */
  logs?: string[];
  /** Evaluated output assertions (the oracle). Present when the step defined assertions. */
  assertions?: AssertionResult[];
  /** For `failed` (threw) steps: deterministic classification of the error. */
  errorCategory?: ErrorCategory;
}

// ── Assertions (the oracle) & deterministic error classification ──

/** Read a dotted path out of a value. '' returns the whole value. */
function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function evaluateAssertion(output: unknown, a: PlanAssertion): AssertionResult {
  const actual = getByPath(output, a.path);
  let passed = false;
  switch (a.op) {
    case 'exists': passed = actual !== undefined && actual !== null; break;
    case 'not_empty': passed = !isEmptyValue(actual); break;
    case 'equals': passed = JSON.stringify(actual) === JSON.stringify(a.value); break;
    case 'contains':
      if (typeof actual === 'string') passed = actual.includes(String(a.value));
      else if (Array.isArray(actual)) passed = actual.some(x => JSON.stringify(x) === JSON.stringify(a.value));
      break;
    case 'matches':
      try { passed = typeof actual === 'string' && new RegExp(String(a.value)).test(actual); } catch { passed = false; }
      break;
    case 'gt': passed = typeof actual === 'number' && actual > Number(a.value); break;
    case 'lt': passed = typeof actual === 'number' && actual < Number(a.value); break;
    case 'type': passed = (Array.isArray(actual) ? 'array' : typeof actual) === String(a.value); break;
    default: passed = false;
  }
  return { path: a.path, op: a.op, expected: a.value, actual, passed, description: a.description };
}

/** Build a one-line human summary of which assertions failed. */
function summarizeFailedAssertions(results: AssertionResult[]): string {
  const failed = results.filter(r => !r.passed);
  const parts = failed.map(r => {
    const target = r.path || 'output';
    const exp = r.expected !== undefined ? ` ${JSON.stringify(r.expected)}` : '';
    const got = JSON.stringify(r.actual);
    return `${target} ${r.op}${exp} (got ${got === undefined ? 'undefined' : got.slice(0, 80)})`;
  });
  return `Output did not match ${failed.length} expectation${failed.length > 1 ? 's' : ''}: ${parts.join('; ')}`;
}

/** Deterministically classify a thrown step error from its message/status code. */
function classifyError(message: string): ErrorCategory {
  const m = (message || '').toLowerCase();
  if (/\b(401|403)\b/.test(m) || /unauthor|forbidden|invalid token|token (is )?expired|expired token|credential|permission|access denied|not authenticated/.test(m)) return 'auth';
  if (/\b429\b/.test(m) || /rate.?limit|too many requests|quota exceeded/.test(m)) return 'rate_limit';
  if (/\b(500|502|503|504)\b/.test(m) || /timeout|timed out|econnreset|econnrefused|socket hang up|network error|temporarily unavailable|service unavailable|getaddrinfo|enotfound/.test(m)) return 'transient';
  if (/\b(400|422)\b/.test(m) || /validation|invalid (input|value|parameter|param|request|body|argument)|is required|missing required|must be a|bad request/.test(m)) return 'bad_request';
  if (/\b404\b/.test(m) || /not found|does not exist|no such/.test(m)) return 'not_found';
  return 'piece_error';
}

export interface PlanProgress {
  type: 'step_start' | 'step_complete' | 'step_failed' | 'paused_for_human' | 'paused_for_approval' | 'plan_complete' | 'plan_failed' | 'plan_blocked' | 'error';
  runId: number;
  stepId?: string;
  stepResult?: StepResult;
  pausedPrompt?: string;
  message?: string;
  stepResults?: StepResult[];
}

// ── In-memory resume signals ──
// Key: runId, Value: EventEmitter that emits 'resume' with { stepId, approved?, humanResponse? }

const resumeEmitters = new Map<number, EventEmitter>();

export function getResumeEmitter(runId: number): EventEmitter {
  if (!resumeEmitters.has(runId)) {
    resumeEmitters.set(runId, new EventEmitter());
  }
  return resumeEmitters.get(runId)!;
}

function cleanupEmitter(runId: number) {
  resumeEmitters.delete(runId);
}

// ── Built-in runtime token resolver ──
// Replaces {{$uuid}}, {{$timestamp}}, {{$isodate}} inside string values.
// These are evaluated fresh on EVERY plan execution, enabling unique-per-run values.

function resolveBuiltinTokens(input: Record<string, unknown>): Record<string, unknown> {
  // Generate once per step execution so all fields in one step share the same values
  const uuid = crypto.randomUUID();
  const timestamp = String(Date.now());
  const isodate = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  function substituteInValue(val: unknown): unknown {
    if (typeof val === 'string') {
      return val
        .replace(/\{\{\$uuid\}\}/g, uuid)
        .replace(/\{\{\$timestamp\}\}/g, timestamp)
        .replace(/\{\{\$isodate\}\}/g, isodate);
    }
    if (Array.isArray(val)) return val.map(substituteInValue);
    if (val !== null && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) out[k] = substituteInValue(v);
      return out;
    }
    return val;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) result[k] = substituteInValue(v);
  return result;
}

// ── InputMapping resolver ──

/**
 * Set a value at a (possibly dotted) field path, creating intermediate objects.
 * e.g. setDeep(obj, "variables.id", v) -> obj.variables = { ...obj.variables, id: v }.
 * A plain key with no dots behaves like obj[field] = v.
 */
function setDeep(target: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cursor[key] === null || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function resolveInputMapping(
  step: TestPlanStep,
  previousResults: Map<string, StepResult>,
): Record<string, unknown> {
  const resolved = { ...step.input };

  if (!step.inputMapping || Object.keys(step.inputMapping).length === 0) {
    return resolveBuiltinTokens(resolved);
  }

  for (const [fieldName, expression] of Object.entries(step.inputMapping)) {
    // expression format: ${steps.<stepId>.output.<path>} or ${steps.<stepId>.humanResponse}
    const match = expression.match(/^\$\{steps\.([^.]+)\.(.+)\}$/);
    if (!match) {
      // Not a valid expression, use as literal
      setDeep(resolved, fieldName, expression);
      continue;
    }

    const [, refStepId, pathStr] = match;
    const refResult = previousResults.get(refStepId);
    if (!refResult) {
      console.warn(`[plan-executor] inputMapping: step "${refStepId}" not found in results`);
      continue;
    }

    // Navigate the path (e.g. "output.ts" or "humanResponse")
    const pathParts = pathStr.split('.');
    let value: any = refResult;
    for (const part of pathParts) {
      if (value === null || value === undefined) break;
      value = value[part];
    }

    if (value !== undefined) {
      // fieldName may be a dotted path (e.g. "variables.id") -> set nested.
      setDeep(resolved, fieldName, value);
    } else {
      console.warn(`[plan-executor] inputMapping: path "${pathStr}" resolved to undefined for step "${refStepId}"`);
    }
  }

  return resolveBuiltinTokens(resolved);
}

// ── Step dispatch ──
// An action step runs a piece action via test-step. A trigger step runs a piece trigger
// via the test-trigger endpoint:
//  - TEST_FUNCTION (polling): one self-contained trigger_test step.
//  - SIMULATION (webhook): a trigger_arm step arms a persistent listener, generator
//    action steps cause the event, and a trigger_test step captures it. The armed
//    listener (TriggerSimContext) lives in `simRef` across those steps and is cancelled
//    in executePlan's finally.

/** Mutable holder for the in-flight SIMULATION listener (one trigger under test per plan). */
type TriggerSimRef = { current: TriggerSimContext | null };

async function executeStepOnAP(
  pieceMeta: PieceMetadataFull,
  step: TestPlanStep,
  resolvedInput: Record<string, unknown>,
  simRef: TriggerSimRef,
  onLog?: (msg: string) => void,
): Promise<unknown> {
  if (step.kind === 'trigger') {
    const triggerName = step.triggerName || step.actionName;
    const strategy = step.triggerStrategy || 'TEST_FUNCTION';

    if (strategy === 'SIMULATION') {
      if (step.type === 'trigger_arm') {
        // Arm the listener and keep it alive for later generator + capture steps.
        if (simRef.current) {
          // Defensive: a prior armed listener wasn't cancelled -- do so before re-arming.
          await cancelTriggerSimulation(simRef.current).catch(() => {});
          simRef.current = null;
        }
        simRef.current = await armTriggerSimulation(pieceMeta, triggerName, resolvedInput, onLog);
        return { armed: true, triggerName };
      }
      // trigger_test (capture)
      if (!simRef.current) {
        throw new Error('SIMULATION trigger_test reached with no armed listener -- the plan is missing a trigger_arm step before the generator.');
      }
      const captured = await captureTriggerEvents(simRef.current, undefined, onLog);
      if (captured.sampleCount === 0) {
        throw new Error('No trigger event was captured within the timeout. The generator step may not have fired the trigger, or the webhook subscription did not deliver.');
      }
      return captured;
    }

    // TEST_FUNCTION (polling)
    return executeTriggerOnAP(pieceMeta, triggerName, resolvedInput, 'TEST_FUNCTION', onLog);
  }
  return executeActionOnAP(pieceMeta, step.actionName, resolvedInput);
}

// ── Main executor ──

export async function executePlan(
  planId: number,
  onProgress: (progress: PlanProgress) => void,
  triggerType: string = 'manual',
  signal?: AbortSignal,
  wave?: WaveInfo,
): Promise<TestPlanRunRow> {
  const plan = getTestPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const steps: TestPlanStep[] = JSON.parse(plan.steps);
  if (steps.length === 0) throw new Error('Plan has no steps');

  // Get piece metadata
  const client = createClient();
  const pieceMeta: PieceMetadataFull = await client.getPieceMetadata(plan.piece_name);

  // Create run (stamped with the schedule fire's wave, if any)
  const run = createPlanRun(planId, triggerType, wave);
  const runId = run.id;
  const emitter = getResumeEmitter(runId);

  // Pre-flight: if this piece's imported connection is deleted/errored upstream, do NOT run.
  // Record the run as `blocked` (it never executed a step) so the Health board reads it as an
  // environment problem, not a piece regression. A thrown listConnections() (network/creds)
  // does NOT block — the .catch lets the plan proceed and any real auth error classifies as today.
  const activeConn = getConnectionByPiece(plan.piece_name);
  const health = activeConn
    ? await checkImportedConnectionHealth(client, activeConn.connection_value).catch(() => null)
    : null;
  if (health && health.status !== 'live') {
    const blockedStep: StepResult = {
      stepId: 'connection', label: 'Connection check', status: 'skipped',
      output: null, error: health.detail, duration_ms: 0,
    };
    updatePlanRun(runId, {
      status: 'blocked',
      completed_at: new Date().toISOString(),
      step_results: JSON.stringify([blockedStep]),
    });
    onProgress({ type: 'plan_blocked', runId, message: health.detail, stepResults: [blockedStep] });
    cleanupEmitter(runId);
    return getPlanRun(runId)!;
  }

  const stepResults = new Map<string, StepResult>();
  const resultsArray: StepResult[] = [];

  // Holds the armed SIMULATION listener (webhook triggers) across arm -> generate -> capture.
  // Always cancelled in the finally below.
  const triggerSim: TriggerSimRef = { current: null };

  // Initialize all step results as pending
  for (const step of steps) {
    const sr: StepResult = {
      stepId: step.id,
      label: step.label,
      status: 'pending',
      output: null,
      error: null,
      duration_ms: 0,
    };
    stepResults.set(step.id, sr);
    resultsArray.push(sr);
  }

  function saveResults() {
    const arr = steps.map(s => stepResults.get(s.id)!);
    updatePlanRun(runId, { step_results: JSON.stringify(arr) });
  }

  // Step types that halt the plan when they fail (thrown OR assertion failure).
  // verify/cleanup/human_input failures do not halt.
  const STOP_ON_FAIL_TYPES = new Set(['setup', 'test', 'trigger_arm', 'trigger_test']);

  // Shared failure path: skip remaining non-cleanup steps, still run cleanup steps,
  // mark the run failed, and emit plan_failed. Used by both thrown errors and
  // assertion failures on a halting step.
  async function finishWithFailure(failedStep: TestPlanStep, failedSr: StepResult, startMs: number): Promise<TestPlanRunRow> {
    const currentIdx = steps.indexOf(failedStep);
    for (let i = currentIdx + 1; i < steps.length; i++) {
      const futureStep = steps[i];
      const futureSr = stepResults.get(futureStep.id)!;
      if (futureStep.type === 'cleanup') {
        futureSr.status = 'running';
        saveResults();
        try {
          const cleanupInput = resolveInputMapping(futureStep, stepResults);
          const cleanupOutput = await executeStepOnAP(pieceMeta, futureStep, cleanupInput, triggerSim);
          futureSr.status = 'completed';
          futureSr.output = cleanupOutput;
        } catch {
          futureSr.status = 'failed';
          futureSr.error = 'Cleanup failed';
        }
        futureSr.duration_ms = Date.now() - startMs;
        saveResults();
      } else {
        futureSr.status = 'skipped';
        saveResults();
      }
    }

    updatePlanRun(runId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      step_results: JSON.stringify(steps.map(s => stepResults.get(s.id)!)),
    });

    onProgress({
      type: 'plan_failed',
      runId,
      message: `Step "${failedStep.label}" failed: ${failedSr.error}`,
      stepResults: steps.map(s => stepResults.get(s.id)!),
    });

    cleanupEmitter(runId);
    return getPlanRun(runId)!;
  }

  try {
    for (const step of steps) {
      // Check for abort before each step
      if (signal?.aborted) {
        // Mark this step and all remaining as skipped
        for (const s of steps) {
          const r = stepResults.get(s.id)!;
          if (r.status === 'pending' || r.status === 'waiting') {
            r.status = 'skipped';
            r.error = 'Aborted by user';
          }
        }
        saveResults();
        updatePlanRun(runId, {
          status: 'cancelled',
          completed_at: new Date().toISOString(),
          step_results: JSON.stringify(steps.map(s => stepResults.get(s.id)!)),
        });
        onProgress({
          type: 'plan_failed',
          runId,
          message: 'Plan execution aborted by user.',
          stepResults: steps.map(s => stepResults.get(s.id)!),
        });
        cleanupEmitter(runId);
        return getPlanRun(runId)!;
      }

      const sr = stepResults.get(step.id)!;

      // Update current step
      updatePlanRun(runId, { current_step_id: step.id });

      // ── Human input step ──
      if (step.type === 'human_input') {
        // Check for saved response (from previous runs) -- skip pause if available
        if (step.savedHumanResponse) {
          sr.status = 'completed';
          sr.humanResponse = step.savedHumanResponse;
          sr.output = { humanResponse: step.savedHumanResponse };
          saveResults();

          onProgress({
            type: 'step_complete',
            runId,
            stepId: step.id,
            stepResult: sr,
            message: `Using saved response: ${step.savedHumanResponse}`,
            stepResults: steps.map(s => stepResults.get(s.id)!),
          });
          continue;
        }

        sr.status = 'waiting';
        saveResults();

        updatePlanRun(runId, {
          status: 'paused_for_human',
          paused_prompt: step.humanPrompt || step.label,
        });

        onProgress({
          type: 'paused_for_human',
          runId,
          stepId: step.id,
          pausedPrompt: step.humanPrompt || step.label,
          stepResults: steps.map(s => stepResults.get(s.id)!),
        });

        // Wait for resume signal
        const response = await waitForResume(emitter, step.id);

        sr.status = 'completed';
        sr.humanResponse = response.humanResponse;
        sr.output = { humanResponse: response.humanResponse };
        saveResults();

        onProgress({
          type: 'step_complete',
          runId,
          stepId: step.id,
          stepResult: sr,
          stepResults: steps.map(s => stepResults.get(s.id)!),
        });
        continue;
      }

      // ── Approval pause ──
      // Scheduled and auto-test runs bypass approval automatically — no one is watching.
      const isUnattended = triggerType === 'scheduled' || triggerType === 'auto_test';
      if (step.requiresApproval && !isUnattended) {
        sr.status = 'waiting';
        saveResults();

        updatePlanRun(runId, {
          status: 'paused_for_approval',
          paused_prompt: `Confirm: ${step.label}`,
        });

        onProgress({
          type: 'paused_for_approval',
          runId,
          stepId: step.id,
          pausedPrompt: `This step requires your approval: ${step.label}\n${step.description}`,
          stepResults: steps.map(s => stepResults.get(s.id)!),
        });

        const response = await waitForResume(emitter, step.id);

        if (!response.approved) {
          sr.status = 'skipped';
          sr.error = 'User declined';
          saveResults();
          onProgress({
            type: 'step_failed',
            runId,
            stepId: step.id,
            stepResult: sr,
            stepResults: steps.map(s => stepResults.get(s.id)!),
          });
          continue;
        }

        // Reset run status to running
        updatePlanRun(runId, { status: 'running', paused_prompt: null });
      }

      // ── Execute action step ──
      sr.status = 'running';
      saveResults();

      onProgress({
        type: 'step_start',
        runId,
        stepId: step.id,
        message: step.label,
        stepResults: steps.map(s => stepResults.get(s.id)!),
      });

      const startMs = Date.now();

      try {
        // Resolve inputMapping
        const resolvedInput = resolveInputMapping(step, stepResults);

        // Live per-step logging (e.g. webhook subscribe/receive) -- append to the step
        // result and push an update so the UI sees it in real time.
        const stepLog = (msg: string) => {
          const ts = new Date().toISOString().slice(11, 19);
          sr.logs = [...(sr.logs ?? []), `[${ts}] ${msg}`];
          saveResults();
          onProgress({
            type: 'step_start',
            runId,
            stepId: step.id,
            message: msg,
            stepResults: steps.map(s => stepResults.get(s.id)!),
          });
        };

        // Execute the step (action via test-step, or trigger via test-trigger)
        const output = await executeStepOnAP(pieceMeta, step, resolvedInput, triggerSim, stepLog);

        sr.output = output;
        sr.duration_ms = Date.now() - startMs;

        // Evaluate output assertions (the oracle). A step only TRULY passes if it ran
        // AND its assertions hold. No assertions = legacy "didn't throw" behavior.
        const assertionResults = (step.assertions && step.assertions.length > 0)
          ? step.assertions.map(a => evaluateAssertion(output, a))
          : undefined;
        if (assertionResults) sr.assertions = assertionResults;

        if (assertionResults && assertionResults.some(r => !r.passed)) {
          // Ran without error, but the output is wrong: distinct from a thrown failure.
          sr.status = 'assert_failed';
          sr.error = summarizeFailedAssertions(assertionResults);
          saveResults();

          onProgress({
            type: 'step_failed',
            runId,
            stepId: step.id,
            stepResult: sr,
            stepResults: steps.map(s => stepResults.get(s.id)!),
          });

          if (STOP_ON_FAIL_TYPES.has(step.type)) {
            return await finishWithFailure(step, sr, startMs);
          }
        } else {
          sr.status = 'completed';
          saveResults();

          onProgress({
            type: 'step_complete',
            runId,
            stepId: step.id,
            stepResult: sr,
            stepResults: steps.map(s => stepResults.get(s.id)!),
          });
        }

      } catch (err: any) {
        const message = err.message || 'Unknown error';
        sr.status = 'failed';
        sr.error = message;
        sr.errorCategory = classifyError(message);
        sr.duration_ms = Date.now() - startMs;
        saveResults();

        onProgress({
          type: 'step_failed',
          runId,
          stepId: step.id,
          stepResult: sr,
          stepResults: steps.map(s => stepResults.get(s.id)!),
        });

        // If a halting step fails, stop the plan (but still run cleanup steps).
        if (STOP_ON_FAIL_TYPES.has(step.type)) {
          return await finishWithFailure(step, sr, startMs);
        }
      }
    }

    // All steps processed. The run is failed if any step failed or asserted-failed —
    // including a non-halting verify/cleanup step that didn't stop the plan.
    const anyFailed = steps.some(s => {
      const r = stepResults.get(s.id)!;
      return r.status === 'failed' || r.status === 'assert_failed';
    });
    updatePlanRun(runId, {
      status: anyFailed ? 'failed' : 'completed',
      completed_at: new Date().toISOString(),
      current_step_id: null,
      step_results: JSON.stringify(steps.map(s => stepResults.get(s.id)!)),
    });

    onProgress({
      type: anyFailed ? 'plan_failed' : 'plan_complete',
      runId,
      stepResults: steps.map(s => stepResults.get(s.id)!),
    });

  } catch (err: any) {
    updatePlanRun(runId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      step_results: JSON.stringify(steps.map(s => stepResults.get(s.id)!)),
    });

    onProgress({
      type: 'error',
      runId,
      message: err.message || 'Unknown error',
      stepResults: steps.map(s => stepResults.get(s.id)!),
    });
  } finally {
    // Always disarm any SIMULATION listener and delete its flow, even on failure/abort.
    if (triggerSim.current) {
      await cancelTriggerSimulation(triggerSim.current).catch(() => {});
      triggerSim.current = null;
    }
  }

  cleanupEmitter(runId);
  return getPlanRun(runId)!;
}

// ── Resume a paused run ──

export function resumePlanRun(
  runId: number,
  data: { stepId: string; approved?: boolean; humanResponse?: string },
) {
  const emitter = resumeEmitters.get(runId);
  if (!emitter) throw new Error(`No active run ${runId} waiting for input`);
  emitter.emit('resume', data);
}

// ── Wait for resume helper ──

function waitForResume(
  emitter: EventEmitter,
  stepId: string,
): Promise<{ approved?: boolean; humanResponse?: string }> {
  return new Promise((resolve) => {
    const handler = (data: { stepId: string; approved?: boolean; humanResponse?: string }) => {
      if (data.stepId === stepId) {
        emitter.removeListener('resume', handler);
        resolve(data);
      }
    };
    emitter.on('resume', handler);
  });
}

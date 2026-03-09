/**
 * Plan Executor -- runs multi-step test plans sequentially,
 * resolving inputMapping between steps, and pausing for human-in-the-loop.
 */

import { EventEmitter } from 'events';
import {
  createPlanRun, getPlanRun, updatePlanRun,
  getTestPlan, type TestPlanRunRow,
} from '../db/queries.js';
import { executeActionOnAP, type TestPlanStep } from './ai-config-generator.js';
import { createClient } from './test-engine.js';
import type { PieceMetadataFull } from './ap-client.js';

// ── Types ──

export interface StepResult {
  stepId: string;
  label?: string;   // human-readable step label (e.g. "Create test ticket")
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
  output: unknown;
  error: string | null;
  duration_ms: number;
  humanResponse?: string;
}

export interface PlanProgress {
  type: 'step_start' | 'step_complete' | 'step_failed' | 'paused_for_human' | 'paused_for_approval' | 'plan_complete' | 'plan_failed' | 'error';
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
      resolved[fieldName] = expression;
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
      resolved[fieldName] = value;
    } else {
      console.warn(`[plan-executor] inputMapping: path "${pathStr}" resolved to undefined for step "${refStepId}"`);
    }
  }

  return resolveBuiltinTokens(resolved);
}

// ── Main executor ──

export async function executePlan(
  planId: number,
  onProgress: (progress: PlanProgress) => void,
  triggerType: string = 'manual',
  signal?: AbortSignal,
): Promise<TestPlanRunRow> {
  const plan = getTestPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const steps: TestPlanStep[] = JSON.parse(plan.steps);
  if (steps.length === 0) throw new Error('Plan has no steps');

  // Get piece metadata
  const client = createClient();
  const pieceMeta: PieceMetadataFull = await client.getPieceMetadata(plan.piece_name);

  // Create run
  const run = createPlanRun(planId, triggerType);
  const runId = run.id;
  const emitter = getResumeEmitter(runId);

  const stepResults = new Map<string, StepResult>();
  const resultsArray: StepResult[] = [];

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

        // Execute the action
        const output = await executeActionOnAP(pieceMeta, step.actionName, resolvedInput);

        sr.status = 'completed';
        sr.output = output;
        sr.duration_ms = Date.now() - startMs;
        saveResults();

        onProgress({
          type: 'step_complete',
          runId,
          stepId: step.id,
          stepResult: sr,
          stepResults: steps.map(s => stepResults.get(s.id)!),
        });

      } catch (err: any) {
        sr.status = 'failed';
        sr.error = err.message || 'Unknown error';
        sr.duration_ms = Date.now() - startMs;
        saveResults();

        onProgress({
          type: 'step_failed',
          runId,
          stepId: step.id,
          stepResult: sr,
          stepResults: steps.map(s => stepResults.get(s.id)!),
        });

        // If a setup or test step fails, stop the plan (but still run cleanup steps)
        if (step.type === 'setup' || step.type === 'test') {
          // Skip remaining non-cleanup steps, run cleanup steps
          const currentIdx = steps.indexOf(step);
          for (let i = currentIdx + 1; i < steps.length; i++) {
            const futureStep = steps[i];
            const futureSr = stepResults.get(futureStep.id)!;
            if (futureStep.type === 'cleanup') {
              // Run cleanup step
              futureSr.status = 'running';
              saveResults();
              try {
                const cleanupInput = resolveInputMapping(futureStep, stepResults);
                const cleanupOutput = await executeActionOnAP(pieceMeta, futureStep.actionName, cleanupInput);
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

          // Plan failed
          updatePlanRun(runId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
            step_results: JSON.stringify(steps.map(s => stepResults.get(s.id)!)),
          });

          onProgress({
            type: 'plan_failed',
            runId,
            message: `Step "${step.label}" failed: ${sr.error}`,
            stepResults: steps.map(s => stepResults.get(s.id)!),
          });

          cleanupEmitter(runId);
          return getPlanRun(runId)!;
        }
      }
    }

    // All steps completed
    updatePlanRun(runId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      current_step_id: null,
      step_results: JSON.stringify(steps.map(s => stepResults.get(s.id)!)),
    });

    onProgress({
      type: 'plan_complete',
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

import type { TestPlanStep } from './types.js';

/** Step types that do not execute a piece action (so they carry no runnable actionName). */
const NON_ACTION_STEP_TYPES = new Set(['human_input', 'trigger_arm', 'trigger_test']);

/**
 * Catch plans that reference actions the executor can't run — the audience:'ai'
 * actions a worker sees via MCP research or the piece source but that aren't in
 * the REST metadata (`piece.actions`). Such a step throws "Action not found" at
 * execution, so failing it here at the free deterministic gate — with a precise
 * message — spares the expensive LLM verifier→fixer loop from flailing on it.
 *
 * Returns one issue string per offending step (empty array = clean).
 */
export function findNonExecutableActionSteps(
  steps: TestPlanStep[],
  executableActionNames: string[],
): string[] {
  const runnable = new Set(executableActionNames);
  const issues: string[] = [];
  for (const step of steps) {
    if (NON_ACTION_STEP_TYPES.has(step.type)) continue;
    if (step.kind === 'trigger') continue;
    if (!step.actionName) continue;
    if (!runnable.has(step.actionName)) {
      issues.push(
        `Step "${step.id}" (${step.type}) uses action "${step.actionName}", which is not a runnable action of this piece and will fail at execution. Use only the runnable actions listed for this piece.`,
      );
    }
  }
  return issues;
}

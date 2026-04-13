import type { PieceMetadataFull } from '../../../services/ap-client.js';
import type { OnLogCallback, TestPlanStep, TestPlanResult, VerificationResult, ToolContext } from '../types.js';
import type { BrokenMapping } from '../tools/inspect-output.js';
import { runAgentLoop } from '../agent-runner.js';
import { createToolRegistry, FIXER_TOOLS } from '../tools/index.js';
import { FIXER_SYSTEM_PROMPT, buildFixerUserPrompt } from '../prompts/fixer.js';
import { parsePlanFromToolInput } from '../tools/set-plan.js';
import type { CostTracker } from '../cost-tracker.js';

/**
 * Run the fixer worker to repair a failed test plan.
 * Can be triggered by either verification failure or execution failure.
 */
export async function runFixerWorker(params: {
  pieceMeta: PieceMetadataFull;
  actionName: string;
  previousSteps: TestPlanStep[];
  verificationResult?: VerificationResult;
  stepResults?: { stepId: string; status: string; output: unknown; error: string | null; duration_ms: number }[];
  brokenMappings?: BrokenMapping[];
  agentMemory?: string;
  onLog: OnLogCallback;
  abortSignal?: AbortSignal;
  costTracker?: CostTracker;
}): Promise<TestPlanResult> {
  const { pieceMeta, actionName, onLog, abortSignal, costTracker } = params;
  const registry = createToolRegistry();

  const toolCtx: ToolContext = { pieceMeta, actionName, abortSignal };

  const result = await runAgentLoop(registry, {
    role: 'fixer',
    model: '',
    systemPrompt: FIXER_SYSTEM_PROMPT,
    initialMessages: [
      { role: 'user', content: buildFixerUserPrompt(params) },
    ],
    maxIterations: 12,
    toolNames: [...FIXER_TOOLS],
    abortSignal,
    onLog,
  }, toolCtx, costTracker);

  if (result.terminatedByTool && result.output) {
    return parsePlanFromToolInput(result.output as Record<string, any>);
  }

  onLog({ timestamp: Date.now(), type: 'error', role: 'fixer', message: 'Fixer did not call set_test_plan. Returning original plan.' });
  return {
    steps: params.previousSteps,
    note: 'Fixer agent could not produce a fixed plan.',
    agentMemory: params.agentMemory,
  };
}

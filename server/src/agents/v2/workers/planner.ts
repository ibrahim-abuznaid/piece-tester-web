import type { PieceMetadataFull } from '../../../services/ap-client.js';
import type { OnLogCallback, TestPlanResult, ToolContext } from '../types.js';
import { runAgentLoop } from '../agent-runner.js';
import { createToolRegistry, PLANNER_TOOLS, PLANNER_TOOLS_MCP } from '../tools/index.js';
import { PLANNER_SYSTEM_PROMPT, PLANNER_SYSTEM_PROMPT_MCP, buildPlannerUserPrompt } from '../prompts/planner.js';
import { parsePlanFromToolInput } from '../tools/set-plan.js';
import type { CostTracker } from '../cost-tracker.js';
import { getSettings } from '../../../db/queries.js';

/**
 * Run the planner worker with a synthesized spec from the coordinator.
 * Returns a TestPlanResult.
 */
export async function runPlannerWorker(params: {
  pieceMeta: PieceMetadataFull;
  actionName: string;
  synthesizedSpec: string;
  onLog: OnLogCallback;
  abortSignal?: AbortSignal;
  costTracker?: CostTracker;
}): Promise<TestPlanResult> {
  const { pieceMeta, actionName, synthesizedSpec, onLog, abortSignal, costTracker } = params;
  const registry = createToolRegistry();
  const s = getSettings();
  const mcpEnabled = !!s.mcp_access_token || !!s.mcp_token;

  const toolCtx: ToolContext = { pieceMeta, actionName, abortSignal };

  const result = await runAgentLoop(registry, {
    role: 'planner',
    model: '',
    systemPrompt: mcpEnabled ? PLANNER_SYSTEM_PROMPT_MCP : PLANNER_SYSTEM_PROMPT,
    initialMessages: [
      { role: 'user', content: buildPlannerUserPrompt(synthesizedSpec) },
    ],
    maxIterations: 10,
    toolNames: mcpEnabled ? [...PLANNER_TOOLS_MCP] : [...PLANNER_TOOLS],
    abortSignal,
    onLog,
  }, toolCtx, costTracker);

  if (result.terminatedByTool && result.output) {
    return parsePlanFromToolInput(result.output as Record<string, any>);
  }

  // Fallback: agent didn't call set_test_plan
  onLog({ timestamp: Date.now(), type: 'error', role: 'planner', message: 'Planner did not call set_test_plan. Returning empty plan.' });
  return { steps: [], note: 'Planner agent failed to produce a plan. Try again.', agentMemory: undefined };
}

import type Anthropic from '@anthropic-ai/sdk';
import type { PieceMetadataFull } from '../../../services/ap-client.js';
import type { MessagesClient } from '../../../services/anthropic-client.js';
import { runAgentLoop } from '../agent-runner.js';
import { createToolRegistry, WATCH_PLANNER_TOOLS } from '../tools/index.js';
import { WATCH_PLANNER_SYSTEM_PROMPT, buildWatchPlannerUserPrompt } from '../prompts/watch-planner.js';
import { parseWatchPlanInput, validateWatchPlan, type WatchPlanValidation } from '../tools/set-watch-plan.js';
import type { CostTracker } from '../cost-tracker.js';
import type { OnLogCallback, ToolContext } from '../types.js';

export const WEB_SEARCH_TOOL: Anthropic.WebSearchTool20250305 = { type: 'web_search_20250305', name: 'web_search', max_uses: 10 };

/** Run the watch planner. Returns the validated plan, or null when the agent never saved one. */
export async function runWatchPlannerWorker(params: {
  pieceMeta: PieceMetadataFull;
  onLog: OnLogCallback;
  abortSignal?: AbortSignal;
  costTracker?: CostTracker;
  client?: MessagesClient;
}): Promise<WatchPlanValidation | null> {
  const toolCtx: ToolContext = { pieceMeta: params.pieceMeta, actionName: '', abortSignal: params.abortSignal, probedSources: new Map() };
  const result = await runAgentLoop(createToolRegistry(), {
    role: 'watch_planner',
    model: '',
    systemPrompt: WATCH_PLANNER_SYSTEM_PROMPT,
    initialMessages: [{ role: 'user', content: buildWatchPlannerUserPrompt(params.pieceMeta) }],
    maxIterations: 30,
    toolNames: [...WATCH_PLANNER_TOOLS],
    serverTools: [WEB_SEARCH_TOOL],
    disableMcp: true,
    abortSignal: params.abortSignal,
    onLog: params.onLog,
    client: params.client,
  }, toolCtx, params.costTracker);
  if (!result.terminatedByTool || !result.output) return null;
  return validateWatchPlan(parseWatchPlanInput(result.output as Record<string, any>), toolCtx);
}

import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '../../db/queries.js';
import { ToolRegistry } from './tool-registry.js';
import { TERMINAL_TOOLS } from './tools/index.js';
import type { AgentRunnerConfig, AgentRunnerResult, OnLogCallback, AgentRole, ToolContext } from './types.js';
import { CostTracker } from './cost-tracker.js';

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Agent aborted: client disconnected');
}

/**
 * Generic agent loop used by all v2 workers.
 *
 * Runs the Claude Messages API in a tool-use loop until:
 * - A terminal tool is called (e.g. set_test_plan)
 * - The model stops using tools (end_turn)
 * - Max iterations reached
 * - Abort signal fires
 *
 * Returns the terminal tool's raw input (for the caller to parse),
 * plus the full conversation for coordinator inspection.
 */
export async function runAgentLoop(
  registry: ToolRegistry,
  config: AgentRunnerConfig,
  toolCtx: ToolContext,
  costTracker?: CostTracker,
): Promise<AgentRunnerResult> {
  const settings = getSettings();
  if (!settings.anthropic_api_key) {
    throw new Error('Anthropic API key not configured. Go to Settings to add it.');
  }

  const model = settings.ai_model || 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey: settings.anthropic_api_key });
  const { role, systemPrompt, maxIterations, toolNames, abortSignal, onLog } = config;

  const tools = registry.getTools(toolNames);
  const messages: Anthropic.Messages.MessageParam[] = [...config.initialMessages];

  function log(type: Parameters<OnLogCallback>[0]['type'], message: string, detail?: string) {
    onLog({ timestamp: Date.now(), type, role, message, detail });
  }

  let iterations = 0;
  let terminalOutput: unknown = null;
  let terminatedByTool = false;

  while (iterations < maxIterations) {
    checkAborted(abortSignal);
    iterations++;
    log('thinking', `[${role}] Iteration ${iterations}/${maxIterations}...`);

    const requestOptions = abortSignal ? { signal: abortSignal } : undefined;
    const response = await client.messages.create(
      { model, max_tokens: 4096, system: systemPrompt, tools, messages },
      requestOptions,
    );

    // Track cost
    if (costTracker) {
      costTracker.trackResponse(model, response, role);
      const totals = costTracker.getTotals();
      log('thinking', `[${role}] Tokens: ${response.usage?.input_tokens || 0}→in ${response.usage?.output_tokens || 0}→out | Session: $${totals.cost_usd.toFixed(4)}`);
    }

    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    for (const block of assistantContent) {
      if (block.type === 'text' && block.text.trim()) {
        log('thinking', block.text.trim());
      }
    }

    const toolUseBlocks = assistantContent.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) {
      log('done', `[${role}] Finished (no more tool calls).`);
      break;
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      checkAborted(abortSignal);
      const input = toolUse.input as Record<string, any>;

      if (TERMINAL_TOOLS.has(toolUse.name as any)) {
        log('decision', `[${role}] Terminal tool: ${toolUse.name}`, JSON.stringify(input).slice(0, 500));
        terminalOutput = input;
        terminatedByTool = true;
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Accepted.' });
        break;
      }

      log('tool_call', `[${role}] ${toolUse.name}`, JSON.stringify(input).slice(0, 300));

      try {
        const result = await registry.execute(toolUse.name, input, toolCtx);
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
        log('tool_result', `[${role}] ${toolUse.name} OK`, result.slice(0, 200));
      } catch (err: any) {
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${err.message}`, is_error: true });
        log('error', `[${role}] ${toolUse.name} failed: ${err.message}`);
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }

    if (terminatedByTool) break;
    if (response.stop_reason === 'end_turn') break;
  }

  if (!terminatedByTool && iterations >= maxIterations) {
    log('error', `[${role}] Reached max iterations (${maxIterations}) without terminal tool call.`);
  }

  return {
    output: terminalOutput,
    messages,
    iterations,
    terminatedByTool,
  };
}

import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '../../db/queries.js';
import { refreshMcpTokenIfNeeded } from '../../routes/settings.js';
import { McpProxyClient, mcpToolToAnthropic } from './mcp-proxy-client.js';
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
 * MCP integration: when an OAuth token (or legacy Bearer token) is configured,
 * we connect directly to the Activepieces MCP server using a local proxy client
 * (fetch-based JSON-RPC). MCP tools are injected as regular Anthropic tools —
 * no Anthropic beta mcp_servers feature needed, avoiding OAuth discovery issues.
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

  function log(type: Parameters<OnLogCallback>[0]['type'], message: string, detail?: string) {
    onLog({ timestamp: Date.now(), type, role, message, detail });
  }

  // ── MCP setup ──────────────────────────────────────────────────────────────
  const hasMcpOAuth = !!settings.mcp_access_token;
  const hasMcpLegacy = !!settings.mcp_token && !!settings.project_id;
  const mcpEnabled = hasMcpOAuth || hasMcpLegacy;

  const mcpUrl = hasMcpOAuth
    ? 'https://mcp.activepieces.com/mcp'
    : `${settings.base_url}/v1/projects/${settings.project_id}/mcp-server/http`;

  toolCtx.mcpEnabled = mcpEnabled;

  // MCP tool names discovered at runtime (so we know which tool_use calls to proxy)
  let mcpToolNames = new Set<string>();
  let mcpProxy: McpProxyClient | null = null;

  // Local tools from registry + MCP tools combined
  const localTools = registry.getTools(toolNames);
  let allTools: any[] = [...localTools];

  if (mcpEnabled) {
    try {
      const authToken = hasMcpOAuth ? await refreshMcpTokenIfNeeded() : settings.mcp_token;
      mcpProxy = new McpProxyClient(mcpUrl, authToken);
      await mcpProxy.initialize();

      const mcpTools = await mcpProxy.listTools();
      mcpToolNames = new Set(mcpTools.map(t => t.name));

      // Inject MCP tools as regular Anthropic tools
      const mcpAnthropicTools = mcpTools.map(mcpToolToAnthropic);
      allTools = [...localTools, ...mcpAnthropicTools];

      log('thinking', `[${role}] MCP mode active — ${hasMcpOAuth ? 'OAuth cloud MCP' : 'legacy project MCP'}. ${mcpTools.length} MCP tools loaded.`);
    } catch (err: any) {
      log('error', `[${role}] MCP init failed: ${err.message}. Continuing without MCP.`);
      mcpProxy = null;
      mcpToolNames = new Set();
      toolCtx.mcpEnabled = false;
    }
  }

  // ── Agent loop ──────────────────────────────────────────────────────────────
  const messages: Anthropic.Messages.MessageParam[] = [...config.initialMessages];

  let iterations = 0;
  let terminalOutput: unknown = null;
  let terminatedByTool = false;

  while (iterations < maxIterations) {
    checkAborted(abortSignal);
    iterations++;
    log('thinking', `[${role}] Iteration ${iterations}/${maxIterations}...`);

    const requestOptions = abortSignal ? { signal: abortSignal } : undefined;

    const response = await client.messages.create(
      { model, max_tokens: 8096, system: systemPrompt, tools: allTools as any, messages },
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
      if (block.type === 'text' && block.text?.trim()) {
        log('thinking', block.text.trim());
      }
    }

    const toolUseBlocks = assistantContent.filter(
      (b: any): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) {
      log('done', `[${role}] Finished (no more tool calls).`);
      break;
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      checkAborted(abortSignal);
      const input = toolUse.input as Record<string, any>;

      // Terminal tool — capture output and stop loop
      if (TERMINAL_TOOLS.has(toolUse.name as any)) {
        log('decision', `[${role}] Terminal tool: ${toolUse.name}`, JSON.stringify(input).slice(0, 500));
        terminalOutput = input;
        terminatedByTool = true;
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Accepted.' });
        break;
      }

      log('tool_call', `[${role}] ${toolUse.name}`, JSON.stringify(input).slice(0, 300));

      try {
        let result: string;

        if (mcpProxy && mcpToolNames.has(toolUse.name)) {
          // ── MCP tool: proxy through our local client ──
          result = await mcpProxy.callTool(toolUse.name, input);
          log('tool_result', `[${role}] MCP← ${toolUse.name}`, result.slice(0, 200));
        } else {
          // ── Local tool from registry ──
          result = await registry.execute(toolUse.name, input, toolCtx);
          log('tool_result', `[${role}] ${toolUse.name} OK`, result.slice(0, 200));
        }

        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
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

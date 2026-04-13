import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { getSettings, getConnectionByPiece } from '../db/queries.js';
import type { PieceMetadataFull, PieceActionMeta } from './ap-client.js';
import { createClient } from './test-engine.js';
import { buildConnectionValue, makeExternalId } from './connection-builder.js';
import { formatLessonsForPrompt } from './lesson-extractor.js';
import { CostTracker } from '../agents/v2/cost-tracker.js';

// ── Types ──

export interface AgentLogEntry {
  timestamp: number;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'decision' | 'error' | 'done';
  message: string;
  detail?: string;
}

export interface AiFieldConfig {
  propName: string;
  displayName: string;
  type: string;
  confidence: 'auto' | 'review' | 'required';
  explanation: string;
  value: unknown;
}

export interface AiActionResult {
  actionName: string;
  displayName: string;
  description: string;
  input: Record<string, unknown>;
  fields: AiFieldConfig[];
  readyToTest: boolean;
  note: string;
  /** Compact memory of what the agent did, for future fix/re-run sessions */
  agentMemory?: string;
  /** Error diagnosis when fixing a failed test */
  errorDiagnosis?: {
    type: 'config_issue' | 'piece_bug' | 'transient' | 'unknown';
    explanation: string;
  };
}

// ── Test Plan types (shared with plan-executor) ──

export interface TestPlanStep {
  id: string;
  type: 'setup' | 'test' | 'verify' | 'cleanup' | 'human_input';
  label: string;
  description: string;
  actionName: string;
  input: Record<string, unknown>;
  inputMapping: Record<string, string>;
  requiresApproval: boolean;
  humanPrompt?: string;
  /** Saved human response for automatic reuse in future/scheduled runs */
  savedHumanResponse?: string;
}

export interface TestPlanResult {
  steps: TestPlanStep[];
  note: string;
  agentMemory?: string;
}

// ── Auth prop types that the agent should skip ──
const AUTH_PROP_TYPES = ['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH'];
const SKIP_PROP_TYPES = ['MARKDOWN'];

// ══════════════════════════════════════════════════════════════
// GitHub source fetcher
// ══════════════════════════════════════════════════════════════

async function fetchPieceSourceFromGitHub(pieceName: string): Promise<string | null> {
  const shortName = pieceName.replace('@activepieces/piece-', '');
  const baseUrl = `https://raw.githubusercontent.com/activepieces/activepieces/main/packages/pieces/community/${shortName}`;
  const files: { path: string; content: string }[] = [];

  for (const indexPath of ['src/index.ts', 'src/index.js']) {
    try {
      const resp = await axios.get(`${baseUrl}/${indexPath}`, { timeout: 8000 });
      if (resp.status === 200) { files.push({ path: indexPath, content: resp.data }); break; }
    } catch { /* not found */ }
  }

  try {
    const apiResp = await axios.get(
      `https://api.github.com/repos/activepieces/activepieces/contents/packages/pieces/community/${shortName}/src/lib/actions`,
      { timeout: 10000, headers: { Accept: 'application/vnd.github.v3+json' } },
    );
    if (Array.isArray(apiResp.data)) {
      const actionFiles = apiResp.data.filter((f: any) => f.name.endsWith('.ts') || f.name.endsWith('.js')).slice(0, 15);
      for (const file of actionFiles) {
        try {
          const fileResp = await axios.get(file.download_url, { timeout: 10000 });
          if (fileResp.status === 200) files.push({ path: `src/lib/actions/${file.name}`, content: fileResp.data });
        } catch { /* skip */ }
      }
    }
  } catch { /* no action files directory */ }

  for (const helperPath of ['src/lib/common/props.ts', 'src/lib/common/index.ts', 'src/lib/common.ts', 'src/lib/common/common.ts']) {
    try {
      const resp = await axios.get(`${baseUrl}/${helperPath}`, { timeout: 5000 });
      if (resp.status === 200) files.push({ path: helperPath, content: resp.data });
    } catch { /* not found */ }
  }

  if (files.length === 0) return null;
  return files.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');
}

async function fetchActionSourceFromGitHub(pieceName: string, actionName: string): Promise<string | null> {
  const shortName = pieceName.replace('@activepieces/piece-', '');
  const baseUrl = `https://raw.githubusercontent.com/activepieces/activepieces/main/packages/pieces/community/${shortName}`;
  const dashName = actionName.replace(/_/g, '-');
  const underName = actionName.replace(/-/g, '_');
  const patterns = [
    `src/lib/actions/${dashName}.ts`, `src/lib/actions/${underName}.ts`,
    `src/lib/actions/${dashName}.action.ts`, `src/lib/actions/${underName}.action.ts`,
    `src/lib/actions/${dashName}/index.ts`, `src/lib/actions/${underName}/index.ts`,
  ];
  for (const pattern of patterns) {
    try {
      const resp = await axios.get(`${baseUrl}/${pattern}`, { timeout: 8000 });
      if (resp.status === 200) return resp.data;
    } catch { /* try next */ }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// Tool definitions for Claude
// ══════════════════════════════════════════════════════════════

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'fetch_piece_source',
    description: 'Fetch all source code files of this piece from the Activepieces GitHub repo.',
    input_schema: {
      type: 'object' as const,
      properties: { reason: { type: 'string', description: 'Why you need the source code' } },
      required: ['reason'],
    },
  },
  {
    name: 'fetch_action_source',
    description: 'Fetch the source code for a specific action file from GitHub.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action_name: { type: 'string', description: 'The action name key' },
        reason: { type: 'string', description: 'Why you need this action source' },
      },
      required: ['action_name', 'reason'],
    },
  },
  {
    name: 'execute_action',
    description: `Execute ANY action from this piece using the user's real connection. Use to list, create, read, or modify resources needed for testing. Auth is added automatically.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'What you are doing and why' },
        action_name: { type: 'string', description: 'The action name to execute' },
        input: { type: 'object' as const, description: 'Input parameters (no auth needed)', additionalProperties: true },
      },
      required: ['description', 'action_name', 'input'],
    },
  },
  {
    name: 'set_action_config',
    description: 'Set the final test configuration. Include an error_diagnosis field when fixing a failed test.',
    input_schema: {
      type: 'object' as const,
      properties: {
        input: { type: 'object' as const, description: 'Complete input map', additionalProperties: true },
        fields: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              propName: { type: 'string' }, displayName: { type: 'string' }, type: { type: 'string' },
              confidence: { type: 'string', enum: ['auto', 'review', 'required'] },
              explanation: { type: 'string' }, value: {},
            },
            required: ['propName', 'confidence', 'explanation', 'value'],
          },
        },
        readyToTest: { type: 'boolean' },
        note: { type: 'string', description: 'Important note for the user' },
        agent_memory: { type: 'string', description: 'Compact summary of what you did (resources created, IDs, decisions). This is saved for future fix sessions.' },
        error_diagnosis: {
          type: 'object' as const,
          description: 'Only when fixing a failed test: your diagnosis of the error',
          properties: {
            type: { type: 'string', enum: ['config_issue', 'piece_bug', 'transient', 'unknown'], description: 'config_issue = your config was wrong, piece_bug = the piece itself has a bug, transient = temporary API error, unknown = unclear' },
            explanation: { type: 'string', description: 'Human-readable explanation of what went wrong and what you did to fix it' },
          },
          required: ['type', 'explanation'],
        },
      },
      required: ['input', 'fields', 'readyToTest', 'note'],
    },
  },
];

// ── Plan-specific tools (replaces set_action_config with set_test_plan) ──

const PLAN_TOOLS: Anthropic.Messages.Tool[] = [
  TOOLS[0], // fetch_piece_source
  TOOLS[1], // fetch_action_source
  TOOLS[2], // execute_action (for research only)
  {
    name: 'set_test_plan',
    description: 'Create the multi-step test plan. Each step will be executed sequentially at test time. Use inputMapping to pipe outputs from earlier steps.',
    input_schema: {
      type: 'object' as const,
      properties: {
        steps: {
          type: 'array' as const,
          description: 'Ordered list of test steps',
          items: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Unique step ID, e.g. "step_1"' },
              type: { type: 'string', enum: ['setup', 'test', 'verify', 'cleanup', 'human_input'], description: 'setup=create resources, test=the actual action being tested, verify=check result, cleanup=tear down, human_input=ask user for a value' },
              label: { type: 'string', description: 'Short human-readable label, e.g. "Send test message"' },
              description: { type: 'string', description: 'Longer explanation of what this step does and why' },
              actionName: { type: 'string', description: 'The Activepieces action name to execute (empty for human_input steps)' },
              input: { type: 'object' as const, description: 'Static input values for this step. Auth is added automatically.', additionalProperties: true },
              inputMapping: {
                type: 'object' as const,
                description: 'Dynamic input references. Maps field names to "${steps.<stepId>.output.<path>}" expressions. These are resolved at runtime using previous step outputs. Example: { "message_ts": "${steps.step_1.output.ts}" }',
                additionalProperties: { type: 'string' },
              },
              requiresApproval: { type: 'boolean', description: 'AVOID using this. Plans run unattended on schedules. Set true ONLY for actions that could permanently destroy production data outside this test — almost never needed since cleanup steps delete resources you just created in setup.' },
              humanPrompt: { type: 'string', description: 'Only for human_input type: the question/instruction to show the user' },
            },
            required: ['id', 'type', 'label', 'description', 'actionName', 'input'],
          },
        },
        note: { type: 'string', description: 'Summary note for the user about this test plan' },
        agent_memory: { type: 'string', description: 'Compact summary of what you discovered and decided. Saved for future sessions.' },
      },
      required: ['steps', 'note'],
    },
  },
];

// ══════════════════════════════════════════════════════════════
// Shared agentic loop
// ══════════════════════════════════════════════════════════════

export type OnLogCallback = (log: AgentLogEntry) => void;

async function runAgentLoop(
  pieceMeta: PieceMetadataFull,
  actionName: string,
  systemPrompt: string,
  initialMessages: Anthropic.Messages.MessageParam[],
  onLog: OnLogCallback,
  toolSet?: Anthropic.Messages.Tool[],
  abortSignal?: AbortSignal,
  costTracker?: CostTracker,
): Promise<AiActionResult | TestPlanResult> {
  const settings = getSettings();
  if (!settings.anthropic_api_key) throw new Error('Anthropic API key not configured. Go to Settings to add it.');

  const action = pieceMeta.actions[actionName];
  if (!action) throw new Error(`Action "${actionName}" not found in piece ${pieceMeta.name}`);

  const model = settings.ai_model || 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey: settings.anthropic_api_key });

  function log(type: AgentLogEntry['type'], message: string, detail?: string) {
    onLog({ timestamp: Date.now(), type, message, detail });
    console.log(`[ai-agent] [${type}] ${message}${detail ? ` | ${detail.slice(0, 200)}` : ''}`);
  }

  function checkAborted() {
    if (abortSignal?.aborted) {
      log('error', 'Agent aborted (client disconnected).');
      throw new Error('Agent aborted: client disconnected');
    }
  }

  const messages = [...initialMessages];
  let result: AiActionResult | TestPlanResult | null = null;
  let iterations = 0;
  const MAX_ITERATIONS = 15;

  while (!result && iterations < MAX_ITERATIONS) {
    checkAborted();
    iterations++;
    log('thinking', `Agent iteration ${iterations}/${MAX_ITERATIONS}...`);

    const activeTools = toolSet || TOOLS;
    const requestOptions = abortSignal ? { signal: abortSignal } : undefined;
    const response = await client.messages.create({ model, max_tokens: 4096, system: systemPrompt, tools: activeTools, messages }, requestOptions);

    if (costTracker) {
      const isPlanMode = toolSet?.some(t => t.name === 'set_test_plan');
      costTracker.trackResponse(model, response, isPlanMode ? 'planner' : 'configurator');
    }

    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    for (const block of assistantContent) {
      if (block.type === 'text' && block.text.trim()) log('thinking', block.text.trim());
    }

    const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use') as Anthropic.Messages.ToolUseBlock[];
    if (toolUseBlocks.length === 0) { log('done', 'Agent finished.'); break; }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const input = toolUse.input as Record<string, any>;

      if (toolUse.name === 'set_action_config') {
        log('decision', `Setting final configuration for "${action.displayName}"`, JSON.stringify(input.input).slice(0, 500));
        const fields: AiFieldConfig[] = (input.fields || []).map((f: any) => ({
          propName: f.propName || '', displayName: f.displayName || f.propName || '',
          type: f.type || 'UNKNOWN',
          confidence: (['auto', 'review', 'required'].includes(f.confidence)) ? f.confidence : 'review',
          explanation: f.explanation || '', value: f.value ?? '',
        }));
        result = {
          actionName, displayName: action.displayName, description: action.description,
          input: input.input || {}, fields, readyToTest: input.readyToTest ?? false, note: input.note || '',
          agentMemory: input.agent_memory || undefined,
          errorDiagnosis: input.error_diagnosis || undefined,
        };
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Configuration saved.' });

      } else if (toolUse.name === 'set_test_plan') {
        log('decision', `Creating test plan with ${(input.steps || []).length} steps`, input.note);
        const steps: TestPlanStep[] = (input.steps || []).map((s: any) => ({
          id: s.id || `step_${Math.random().toString(36).slice(2, 6)}`,
          type: s.type || 'test',
          label: s.label || '',
          description: s.description || '',
          actionName: s.actionName || '',
          input: s.input || {},
          inputMapping: s.inputMapping || {},
          requiresApproval: s.requiresApproval || false,
          humanPrompt: s.humanPrompt || undefined,
        }));
        result = {
          steps,
          note: input.note || '',
          agentMemory: input.agent_memory || undefined,
        };
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Test plan created.' });

      } else if (toolUse.name === 'fetch_piece_source') {
        log('tool_call', `Fetching piece source from GitHub...`, input.reason);
        try {
          const source = await fetchPieceSourceFromGitHub(pieceMeta.name);
          const text = source ? `Source code (${source.length} chars):\n\n${source.slice(0, 50000)}` : 'Not found on GitHub.';
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: text });
          log('tool_result', source ? `Got ${source.length} chars` : 'Not found');
        } catch (err: any) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${err.message}` });
          log('error', `Fetch failed: ${err.message}`);
        }

      } else if (toolUse.name === 'fetch_action_source') {
        log('tool_call', `Fetching source for "${input.action_name}"...`, input.reason);
        try {
          const source = await fetchActionSourceFromGitHub(pieceMeta.name, input.action_name);
          const text = source ? `Action source:\n\n${source.slice(0, 15000)}` : `Not found for "${input.action_name}". Use fetch_piece_source for all files.`;
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: text });
          log('tool_result', source ? `Got ${source.length} chars` : 'Not found');
        } catch (err: any) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${err.message}` });
          log('error', `Fetch failed: ${err.message}`);
        }

      } else if (toolUse.name === 'execute_action') {
        log('tool_call', `Executing: ${input.description}`, `Action: ${input.action_name}`);
        try {
          const actionResult = await executeActionOnAP(pieceMeta, input.action_name, input.input || {});
          const text = typeof actionResult === 'string' ? actionResult : JSON.stringify(actionResult, null, 2);
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Success:\n\n${text.slice(0, 10000)}` });
          log('tool_result', `Succeeded - ${text.length} chars`);
        } catch (err: any) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Failed: ${err.message}` });
          log('error', `Failed: ${err.message}`);
        }
      } else {
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Unknown tool`, is_error: true });
      }
    }

    if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults });
    if (result) break;
    if (response.stop_reason === 'end_turn') break;
  }

  if (!result) {
    log('error', 'Agent did not produce a result.');
    // Return a fallback based on whether we're in plan mode
    const isPlanMode = toolSet?.some(t => t.name === 'set_test_plan');
    if (isPlanMode) {
      result = { steps: [], note: 'Agent could not create a plan. Try again.', agentMemory: undefined };
    } else {
      result = {
        actionName, displayName: action.displayName, description: action.description,
        input: {}, fields: [], readyToTest: false,
        note: 'Agent could not complete. Try again or configure manually.',
      };
    }
  }

  const readyMsg = 'steps' in result
    ? `Plan created with ${result.steps.length} steps.`
    : (result as AiActionResult).readyToTest ? 'Ready to test!' : 'Some fields need input.';
  log('done', `Done. ${readyMsg}`);
  return result;
}

// ══════════════════════════════════════════════════════════════
// Public API: Configure action (initial setup)
// ══════════════════════════════════════════════════════════════

export async function configureActionWithAi(
  pieceMeta: PieceMetadataFull,
  actionName: string,
  onLog: OnLogCallback,
  previousMemory?: string,
  abortSignal?: AbortSignal,
): Promise<AiActionResult> {
  const connRow = getConnectionByPiece(pieceMeta.name);
  const connectionInfo = connRow ? { hasConnection: true, connectionType: connRow.connection_type } : { hasConnection: false };

  const costTracker = new CostTracker({
    pieceName: pieceMeta.name, actionName, operation: 'configure', version: 'v1',
  });

  onLog({ timestamp: Date.now(), type: 'thinking', message: `Starting AI agent for "${pieceMeta.actions[actionName]?.displayName}" (${actionName})` });

  const prompt = buildActionPrompt(pieceMeta, actionName, pieceMeta.actions[actionName], connectionInfo, previousMemory);
  return runAgentLoop(pieceMeta, actionName, CONFIGURE_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], onLog, undefined, abortSignal, costTracker) as Promise<AiActionResult>;
}

// ══════════════════════════════════════════════════════════════
// Public API: Fix action after test failure
// ══════════════════════════════════════════════════════════════

export async function fixActionWithAi(
  pieceMeta: PieceMetadataFull,
  actionName: string,
  previousConfig: Record<string, unknown>,
  testError: string,
  agentMemory: string | undefined,
  onLog: OnLogCallback,
  abortSignal?: AbortSignal,
): Promise<AiActionResult> {
  const connRow = getConnectionByPiece(pieceMeta.name);
  const connectionInfo = connRow ? { hasConnection: true, connectionType: connRow.connection_type } : { hasConnection: false };

  const costTracker = new CostTracker({
    pieceName: pieceMeta.name, actionName, operation: 'fix_action', version: 'v1',
  });

  onLog({ timestamp: Date.now(), type: 'thinking', message: `Analyzing failure for "${pieceMeta.actions[actionName]?.displayName}" and attempting fix...` });

  const prompt = buildFixPrompt(pieceMeta, actionName, pieceMeta.actions[actionName], connectionInfo, previousConfig, testError, agentMemory);
  return runAgentLoop(pieceMeta, actionName, FIX_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], onLog, undefined, abortSignal, costTracker) as Promise<AiActionResult>;
}

// ══════════════════════════════════════════════════════════════
// Action executor
// ══════════════════════════════════════════════════════════════

export async function executeActionOnAP(pieceMeta: PieceMetadataFull, actionName: string, input: Record<string, unknown>): Promise<unknown> {
  if (!pieceMeta.actions[actionName]) {
    throw new Error(`Action "${actionName}" not found. Available: ${Object.keys(pieceMeta.actions).join(', ')}`);
  }

  const apClient = createClient();
  const connRow = getConnectionByPiece(pieceMeta.name);
  const authInput: Record<string, unknown> = {};

  if (connRow) {
    const connValue = JSON.parse(connRow.connection_value);
    if (connValue._imported) {
      const remoteConns = await apClient.listConnections();
      const remote = remoteConns.find(rc => rc.id === connValue.remote_id || rc.externalId === connValue.remote_id);
      if (remote) authInput['auth'] = `{{connections.${remote.externalId}}}`;
      else throw new Error('Imported connection not found in AP. Re-import it.');
    } else if (connRow.connection_type !== 'NO_AUTH') {
      const extId = makeExternalId(pieceMeta.name);
      await apClient.upsertConnection({
        externalId: extId, displayName: `AI Agent - ${pieceMeta.displayName}`,
        pieceName: pieceMeta.name, type: connRow.connection_type,
        value: buildConnectionValue(connRow.connection_type as any, connValue),
      });
      authInput['auth'] = `{{connections.${extId}}}`;
    }
  }

  const flow = await apClient.createFlow(`[AI Agent] ${pieceMeta.displayName} - ${actionName}`);
  try {
    const updatedFlow = await apClient.applyFlowOperation(flow.id, {
      type: 'ADD_ACTION',
      request: {
        parentStep: 'trigger', stepLocationRelativeToParent: 'AFTER',
        action: {
          type: 'PIECE', name: 'step_1', displayName: `Agent: ${actionName}`, valid: true, skip: false,
          settings: {
            pieceName: pieceMeta.name, pieceVersion: `~${pieceMeta.version}`, actionName,
            input: { ...authInput, ...input }, propertySettings: {},
            errorHandlingOptions: { continueOnFailure: { value: true }, retryOnFailure: { value: false } },
          },
        },
      },
    });

    if (!apClient.hasJwtToken()) throw new Error('JWT token required. Sign in via Settings first.');

    const flowRun = await apClient.testStep(updatedFlow.version.id, 'step_1');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const run = await apClient.getFlowRun(flowRun.id);
      if (['SUCCEEDED', 'FAILED', 'INTERNAL_ERROR', 'TIMEOUT'].includes(run.status)) {
        const stepResult = run.steps?.['step_1'] as any;
        if (run.status === 'SUCCEEDED') return stepResult?.output ?? { status: 'success' };
        throw new Error(JSON.stringify({ status: run.status, errorMessage: stepResult?.errorMessage || 'Unknown error', output: stepResult?.output }));
      }
      await new Promise(r => setTimeout(r, 2500));
    }
    throw new Error('Timed out after 90s');
  } finally {
    await apClient.deleteFlowSafely(flow.id, 5, `ai-agent:${actionName}`);
  }
}

// ══════════════════════════════════════════════════════════════
// System prompts
// ══════════════════════════════════════════════════════════════

const CONFIGURE_SYSTEM_PROMPT = `You are a fully autonomous Activepieces test configuration agent. Your goal is to configure ONE specific action so it is 100% READY TO TEST with ALL fields filled using REAL data.

## Your Tools
1. **fetch_piece_source** / **fetch_action_source** -- Read source code from GitHub
2. **execute_action** -- Execute ANY action from this piece (list, create, read, modify, custom API calls)
3. **set_action_config** -- Save the final config with per-field confidence + agent_memory

## CRITICAL: IDEMPOTENT CONFIGURATIONS

Your config MUST be re-runnable. The user will run the test MULTIPLE times with the same config. Design for this:

### Idempotency strategies:
- **Reactions/likes/votes**: These fail on duplicate. Instead of "add reaction", prefer "remove then add", or use a unique timestamp-based message each time. If an action is inherently non-idempotent (e.g., "add reaction to message"), create a FRESH target resource each time (e.g., send a new message first, then react to THAT message).
- **Create actions**: Use unique names with timestamps, e.g., "[AI Test] 2024-01-15T10:30:00" or check if it already exists first
- **Update/set actions**: These are naturally idempotent (setting the same value twice is fine) -- prefer these
- **Send/post actions**: Create dedicated test channels/threads to avoid spamming real ones
- **Delete actions**: Check if the resource exists first, create a fresh one to delete

### Self-setup pattern:
For actions that need prerequisite data, USE execute_action to set up that data as part of the config:
- "Add reaction to message" → first send a test message, use THAT message's ID/timestamp
- "Delete spreadsheet" → first create a test spreadsheet, use that ID
- "Update row" → first create a test row, use that row number

## Fill EVERY field
- DO NOT leave empty fields. CREATE resources if needed.
- DO NOT mark as "required" unless truly impossible to resolve.
- ALWAYS include agent_memory in set_action_config -- summarize what resources you created, their IDs, and your decisions. This is saved so future fix sessions remember context.

## General rules:
- Fetch source code first for DROPDOWN/DYNAMIC properties
- For created test resources, include details in the note
- Keep explanations concise -- 1-2 sentences per step
- ALWAYS call set_action_config at the end with readyToTest: true`;

const FIX_SYSTEM_PROMPT = `You are an Activepieces test configuration agent analyzing a FAILED test and fixing the configuration.

## Your job:
1. **Diagnose** the error -- is it a config issue, a piece bug, or a transient error?
2. **Fix** the config if possible
3. **Report** your diagnosis via error_diagnosis in set_action_config

## Error types:
- **config_issue**: The config you generated caused the failure (wrong ID, duplicate reaction, missing field, wrong format). FIX IT.
- **piece_bug**: The piece itself has a bug (null pointer, unhandled edge case, API contract violation). The config is fine. Report it.
- **transient**: Temporary issue (rate limit, network timeout, API outage). The config is fine -- just note it.
- **unknown**: Can't determine the cause.

## Fixing strategy:
- You have the previous config, the error message, and your agent_memory from the setup session
- Use execute_action to investigate (check if resources still exist, try variations)
- For idempotency issues (like "already_reacted"), create FRESH resources and update the config
- For missing resources, recreate them
- ALWAYS include agent_memory summarizing what you found and did
- ALWAYS call set_action_config with the fixed config AND error_diagnosis

## Your Tools
Same as before: fetch_piece_source, fetch_action_source, execute_action, set_action_config`;

const PLAN_SYSTEM_PROMPT = `You are a fully autonomous Activepieces test planning agent. Your goal is to create a MULTI-STEP TEST PLAN for one specific action.

Unlike a simple config, your plan includes SETUP steps that run BEFORE the actual test, making each run fully self-contained and re-runnable.

## Your Tools
1. **fetch_piece_source** / **fetch_action_source** -- Read source code from GitHub to understand action inputs, outputs, and dropdown values
2. **execute_action** -- Execute actions for RESEARCH ONLY during planning (e.g. list channels, check what exists). DO NOT use this to pre-create resources; that should be a plan step.
3. **set_test_plan** -- Create the final multi-step plan

## Step Types
- **setup**: Create prerequisite resources (e.g. send a message, create a spreadsheet). Runs EVERY time the plan executes, ensuring fresh resources.
- **test**: The actual action being tested. There should be exactly ONE test step.
- **verify**: Optional check that the test succeeded (e.g. search for created resource).
- **cleanup**: Optional teardown (e.g. delete test resources). Run even if test fails.
- **human_input**: Ask the user for a value you cannot determine automatically. Use sparingly.

## Runtime Tokens -- Unique Values Per Run
The executor replaces these tokens inside ANY string value in step inputs at execution time:
- \`{{$uuid}}\` → a fresh UUID v4 each run (e.g. "550e8400-e29b-41d4-a716-446655440000")
- \`{{$timestamp}}\` → current Unix timestamp in milliseconds (e.g. "1739800000000")
- \`{{$isodate}}\` → current ISO date-time (e.g. "2024-01-15T10-30-00")

**Use these for any field that must be unique per run** (names, subjects, titles, keys):
\`\`\`json
{ "name": "[AI Test] {{$uuid}}", "subject": "Test email {{$timestamp}}" }
\`\`\`

⚠ **NEVER use JavaScript expressions** like \`\${new Date().getTime()}\` in base input -- they are stored as literal strings and NEVER evaluated. Use \`{{$timestamp}}\` instead.

## inputMapping -- Piping Outputs Between Steps
Use \${steps.<stepId>.output.<path>} in inputMapping to reference previous step outputs at runtime.

Example for "Add reaction to message":
- Step 1 (setup): send_message_to_a_channel with input: { "channel": "C12345", "text": "[AI Test] {{$uuid}}" }
- Step 2 (test): add_reaction_to_message with:
  - input: { "reaction": "thumbsup" }
  - inputMapping: { "messageTimestamp": "\${steps.step_1.output.ts}", "channel": "\${steps.step_1.output.channel}" }

The executor resolves inputMapping at runtime, so step 2 always gets the FRESH message timestamp from step 1.

## Rules
- Fetch source code FIRST to understand action properties, especially DROPDOWN/DYNAMIC fields
- The setup steps CREATE fresh resources each run -- this solves idempotency automatically
- Use \`{{$uuid}}\` or \`{{$timestamp}}\` tokens in resource names to ensure uniqueness across runs
- Use execute_action for RESEARCH only (e.g. listing channels to pick one, checking available emojis)
- For static values you discover during research (like a channel ID), put them directly in step input
- For dynamic values from previous steps, use inputMapping
- AVOID requiresApproval: true — test plans run on scheduled/unattended automation; cleanup steps that delete TEST resources you just created do NOT need approval
- Use human_input steps when you genuinely cannot determine a value (rare -- most things can be discovered or created)
- ALWAYS include agent_memory summarizing your research findings and decisions
- The test step MUST have ALL required fields filled
- Keep plans concise: typically 2-4 steps (setup + test, maybe verify)
- ALWAYS call set_test_plan at the end

## CRITICAL: Never Use Custom HTTP/API Calls in Plans
**ABSOLUTELY NEVER create steps that use any of these actions:** custom_api_call, http_request, send_http_request, custom_action, api_call, raw_http, generic_api, webhook, http_post, http_get, make_request, or ANY action that sends a raw/custom HTTP request.
These ALWAYS fail because:
- Authentication tokens are managed internally by each piece -- you CANNOT replicate them in custom HTTP steps
- Custom API call actions completely bypass the piece's connection handling and auth headers
- The piece runtime does not inject credentials into custom HTTP actions
- **Instead, ONLY use the piece's own named/typed actions** (e.g. use \`send_message\`, \`create_record\`, \`get_user\` -- never a raw POST/GET to the API)
- If the piece does not have a built-in action for what you need, design the plan around what IS available -- do NOT work around it with custom HTTP calls`;

const FIX_PLAN_SYSTEM_PROMPT = `You are an Activepieces test plan repair agent. A multi-step test plan FAILED during execution. Your job is to analyze the step results, diagnose why it failed, and produce a FIXED plan.

## What you receive
- The original plan steps and their execution results (outputs, errors, durations)
- The agent memory from when the plan was created
- The piece metadata and available actions
- A "BROKEN inputMapping paths" section (if any) showing which paths resolved to undefined

## Your job
1. **Analyze** each step result -- which step failed and why?
2. **Diagnose** the root cause:
   - Wrong input values (wrong field names, wrong IDs)
   - Wrong inputMapping (referencing a field that doesn't exist in the output)
   - Missing required fields
   - Action not available or wrong action name
   - API/permission error
3. **Fix** the plan by modifying the steps, inputs, or inputMapping
4. **Learn** -- update agent_memory with what went wrong and how you fixed it

## Runtime Tokens (CRITICAL -- use these to fix uniqueness/duplicate errors)
The executor replaces these tokens in ANY string input value at execution time:
- \`{{$uuid}}\` → fresh UUID v4 each run
- \`{{$timestamp}}\` → current Unix ms timestamp
- \`{{$isodate}}\` → current ISO date-time string

**Use these whenever a field must be unique per run** (names, titles, subjects, keys):
\`{ "name": "[AI Test] {{$uuid}}" }\`

NEVER use JavaScript expressions like \`\${new Date().getTime()}\` -- they are stored as literal strings and never evaluated. If you see them in the existing plan, REPLACE them with \`{{$timestamp}}\` or \`{{$uuid}}\`.

## Fixing strategies
- If a step fails with "already exists" / "duplicate" / "name taken" errors → the resource name is not unique per run. Add \`{{$uuid}}\` or \`{{$timestamp}}\` to the name field in the input.
- If the plan uses JavaScript template expressions like \`\${new Date().getTime()}\` in base input → replace them with \`{{$timestamp}}\` -- JS expressions are never evaluated in JSON inputs.
- If inputMapping references a field that doesn't exist in the output, use execute_action to run the action and inspect the ACTUAL output structure, then fix the mapping
- If an action failed due to missing resources, add a setup step or fix existing setup steps
- If a field value is wrong, fetch source code to understand the correct format
- If the action name is wrong, check available actions
- If a cleanup step fails because the action itself is broken (TypeError in piece source, not a config issue), remove the cleanup step and note the piece bug in agent_memory — do not keep retrying a broken action

## Your Tools
1. **fetch_piece_source** / **fetch_action_source** -- Read source code from GitHub
2. **execute_action** -- Execute actions to investigate (check outputs, test inputs)
3. **set_test_plan** -- Output the FIXED plan

## CRITICAL RULES -- READ CAREFULLY
- **NEVER add placeholder values (empty strings, null, 0) to the base input as a workaround for broken inputMapping.** This does NOT fix the problem -- if the mapping path is wrong, the placeholder just stays and causes the API to fail.
- **When an inputMapping path resolves to undefined, the ONLY correct fix is to find the RIGHT path.** Look at the actual step output in the "Execution Results" section and navigate the JSON to find where the value really is. If the output is unclear, use execute_action to run the step again and inspect the result.
- **Do NOT trust agent_memory if it contradicts the actual step outputs.** If memory says something but the output shows differently, trust the output.
- **The base input and inputMapping have separate roles:** base input = static values known at plan-creation time; inputMapping = dynamic values resolved from previous step outputs AT RUNTIME. inputMapping OVERRIDES base input. There is NO requirement to pre-populate inputMapping fields in base input.
- Your fixed plan must address the SPECIFIC error that occurred
- Include DETAILED agent_memory explaining: what failed, why, and exactly what you changed
- The agent_memory is persisted and shown to your future self -- make it useful
- ALWAYS call set_test_plan at the end with the corrected steps
- **Do NOT use requiresApproval: true on cleanup/delete steps.** Plans run unattended on schedules — no one is there to click Approve. Cleanup steps delete test resources YOU just created, so no human gate is needed. Set requiresApproval: false on all steps unless absolutely unavoidable.

## CRITICAL: Never Use Custom HTTP Calls in Plans
**ABSOLUTELY NEVER use custom_api_call, http_request, send_http_request, custom_action, api_call, raw_http, generic_api, webhook, or ANY raw/custom HTTP action.** These ALWAYS fail because auth tokens are managed internally by each piece and cannot be replicated in custom HTTP steps. ONLY use the piece's own named/typed actions. If the piece lacks a specific action, redesign the plan around available actions -- do NOT work around it with HTTP calls.`;

// ══════════════════════════════════════════════════════════════
// Public API: Create test plan
// ══════════════════════════════════════════════════════════════

export async function createTestPlanWithAi(
  pieceMeta: PieceMetadataFull,
  actionName: string,
  onLog: OnLogCallback,
  previousMemory?: string,
  abortSignal?: AbortSignal,
): Promise<TestPlanResult> {
  const connRow = getConnectionByPiece(pieceMeta.name);
  const connectionInfo = connRow ? { hasConnection: true, connectionType: connRow.connection_type } : { hasConnection: false };

  const costTracker = new CostTracker({
    pieceName: pieceMeta.name, actionName, operation: 'create', version: 'v1',
  });

  onLog({ timestamp: Date.now(), type: 'thinking', message: `Creating test plan for "${pieceMeta.actions[actionName]?.displayName}" (${actionName})` });

  const prompt = buildPlanPrompt(pieceMeta, actionName, pieceMeta.actions[actionName], connectionInfo, previousMemory);
  const result = await runAgentLoop(pieceMeta, actionName, PLAN_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], onLog, PLAN_TOOLS, abortSignal, costTracker);

  // Ensure we got a plan result
  if ('steps' in result) return result as TestPlanResult;

  // Fallback: convert single-action result to a 1-step plan
  const singleResult = result as AiActionResult;
  return {
    steps: [{
      id: 'step_1',
      type: 'test',
      label: singleResult.displayName || actionName,
      description: singleResult.description || '',
      actionName,
      input: singleResult.input || {},
      inputMapping: {},
      requiresApproval: false,
    }],
    note: singleResult.note || '',
    agentMemory: singleResult.agentMemory,
  };
}

// ══════════════════════════════════════════════════════════════
// Public API: Fix a failed test plan
// ══════════════════════════════════════════════════════════════

export async function fixTestPlanWithAi(
  pieceMeta: PieceMetadataFull,
  actionName: string,
  previousSteps: TestPlanStep[],
  stepResults: { stepId: string; status: string; output: unknown; error: string | null; duration_ms: number }[],
  agentMemory: string | undefined,
  onLog: OnLogCallback,
  abortSignal?: AbortSignal,
): Promise<TestPlanResult> {
  const connRow = getConnectionByPiece(pieceMeta.name);
  const connectionInfo = connRow ? { hasConnection: true, connectionType: connRow.connection_type } : { hasConnection: false };

  const costTracker = new CostTracker({
    pieceName: pieceMeta.name, actionName, operation: 'fix', version: 'v1',
  });

  onLog({ timestamp: Date.now(), type: 'thinking', message: `Analyzing failed plan for "${pieceMeta.actions[actionName]?.displayName}" and fixing...` });

  const prompt = buildFixPlanPrompt(pieceMeta, actionName, pieceMeta.actions[actionName], connectionInfo, previousSteps, stepResults, agentMemory);
  const result = await runAgentLoop(pieceMeta, actionName, FIX_PLAN_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], onLog, PLAN_TOOLS, abortSignal, costTracker);

  if ('steps' in result) return result as TestPlanResult;

  // Fallback
  return { steps: previousSteps, note: 'Agent could not fix the plan.', agentMemory };
}

// ══════════════════════════════════════════════════════════════
// Prompt builders
// ══════════════════════════════════════════════════════════════

function buildActionPrompt(
  piece: PieceMetadataFull, actionName: string, action: PieceActionMeta,
  connectionInfo?: { connectionType?: string; hasConnection: boolean },
  previousMemory?: string,
): string {
  const lines: string[] = [];

  lines.push(`# Configure action for testing`);
  lines.push(`**Piece:** ${piece.displayName} (${piece.name}) v${piece.version}`);
  lines.push(`**Action:** ${action.displayName} (${actionName})`);
  lines.push(`**Description:** ${action.description || 'No description'}`);
  lines.push(`**Auth:** ${piece.auth?.type || 'None'}`);
  lines.push(`**Connection:** ${connectionInfo?.hasConnection ? 'Connected' : 'Not connected'} (${connectionInfo?.connectionType || 'unknown'})`);

  if (previousMemory) {
    lines.push('');
    lines.push(`## Previous Agent Memory (from last session):`);
    lines.push(previousMemory);
    lines.push('');
    lines.push('Use this memory to skip redundant steps -- resources may already exist.');
  }

  lines.push('');
  lines.push(`## All actions in this piece (you can execute ANY):`);
  for (const [n, act] of Object.entries(piece.actions)) {
    lines.push(`  - ${n}: "${act.displayName}"`);
  }

  lines.push('');
  lines.push(`## Properties for "${action.displayName}":`);
  const props = action.props || {};
  for (const [propName, propDef] of Object.entries(props)) {
    const prop = propDef as any;
    const propType = prop.type ?? 'UNKNOWN';
    if (AUTH_PROP_TYPES.includes(propType) || SKIP_PROP_TYPES.includes(propType)) continue;
    const req = prop.required ? ' [REQUIRED]' : ' [optional]';
    const def = prop.defaultValue !== undefined ? ` (default: ${JSON.stringify(prop.defaultValue)})` : '';
    lines.push(`\n### ${propName} (${prop.displayName || propName})`);
    lines.push(`  Type: ${propType}${req}${def}`);
    if (prop.description) lines.push(`  Description: ${prop.description}`);
    if (propType === 'STATIC_DROPDOWN' && prop.options?.options) {
      lines.push(`  Options: ${prop.options.options.slice(0, 15).map((o: any) => `"${o.label}"=${JSON.stringify(o.value)}`).join(', ')}`);
    }
    if (propType === 'DROPDOWN' || propType === 'MULTI_SELECT_DROPDOWN') {
      lines.push(`  ⚠ DYNAMIC DROPDOWN`);
      if (prop.refreshers) lines.push(`  Depends on: ${JSON.stringify(prop.refreshers)}`);
    }
    if (propType === 'DYNAMIC') {
      lines.push(`  ⚠ DYNAMIC PROPERTIES -- fetch source to understand`);
      if (prop.refreshers) lines.push(`  Depends on: ${JSON.stringify(prop.refreshers)}`);
    }
  }

  lines.push('\n\nFill EVERY field. Create resources if needed. Remember: the config must be re-runnable multiple times.');
  return lines.join('\n');
}

function buildFixPrompt(
  piece: PieceMetadataFull, actionName: string, action: PieceActionMeta,
  connectionInfo: { connectionType?: string; hasConnection: boolean },
  previousConfig: Record<string, unknown>, testError: string, agentMemory?: string,
): string {
  const lines: string[] = [];

  lines.push(`# Fix failed test for action "${action.displayName}" (${actionName})`);
  lines.push(`**Piece:** ${piece.displayName} (${piece.name}) v${piece.version}`);
  lines.push(`**Connection:** ${connectionInfo.hasConnection ? 'Connected' : 'Not connected'}`);
  lines.push('');

  lines.push(`## Test Error:`);
  lines.push('```');
  lines.push(testError);
  lines.push('```');
  lines.push('');

  lines.push(`## Previous Config (that failed):`);
  lines.push('```json');
  lines.push(JSON.stringify(previousConfig, null, 2));
  lines.push('```');

  if (agentMemory) {
    lines.push('');
    lines.push(`## Agent Memory (from setup session):`);
    lines.push(agentMemory);
  }

  lines.push('');
  lines.push(`## All actions in this piece:`);
  for (const [n, act] of Object.entries(piece.actions)) {
    lines.push(`  - ${n}: "${act.displayName}"`);
  }

  lines.push('');
  lines.push(`## Properties for "${action.displayName}":`);
  const props = action.props || {};
  for (const [propName, propDef] of Object.entries(props)) {
    const prop = propDef as any;
    const propType = prop.type ?? 'UNKNOWN';
    if (AUTH_PROP_TYPES.includes(propType) || SKIP_PROP_TYPES.includes(propType)) continue;
    lines.push(`  - ${propName}: type=${propType}${prop.required ? ' [REQUIRED]' : ''}`);
  }

  lines.push('\n\n1. Diagnose: Is this a config_issue, piece_bug, transient error, or unknown?');
  lines.push('2. If config_issue: fix the config (create fresh resources if needed for idempotency)');
  lines.push('3. Call set_action_config with the fixed config AND error_diagnosis');

  return lines.join('\n');
}

function buildPlanPrompt(
  piece: PieceMetadataFull, actionName: string, action: PieceActionMeta,
  connectionInfo?: { connectionType?: string; hasConnection: boolean },
  previousMemory?: string,
): string {
  const lines: string[] = [];

  lines.push(`# Create a test plan for action "${action.displayName}" (${actionName})`);
  lines.push(`**Piece:** ${piece.displayName} (${piece.name}) v${piece.version}`);
  lines.push(`**Description:** ${action.description || 'No description'}`);
  lines.push(`**Auth:** ${piece.auth?.type || 'None'}`);
  lines.push(`**Connection:** ${connectionInfo?.hasConnection ? 'Connected' : 'Not connected'} (${connectionInfo?.connectionType || 'unknown'})`);

  // Inject learned lessons for this piece
  const lessonsBlock = formatLessonsForPrompt(piece.name);
  if (lessonsBlock) lines.push(lessonsBlock);

  if (previousMemory) {
    lines.push('');
    lines.push(`## Previous Agent Memory:`);
    lines.push(previousMemory);
    lines.push('');
    lines.push('Use this to skip redundant research.');
  }

  lines.push('');
  lines.push(`## All actions in this piece (available for setup/verify/cleanup steps):`);
  for (const [n, act] of Object.entries(piece.actions)) {
    lines.push(`  - ${n}: "${act.displayName}"`);
  }

  lines.push('');
  lines.push(`## Properties for the TARGET action "${action.displayName}" (this is the "test" step):`);
  const props = action.props || {};
  for (const [propName, propDef] of Object.entries(props)) {
    const prop = propDef as any;
    const propType = prop.type ?? 'UNKNOWN';
    if (AUTH_PROP_TYPES.includes(propType) || SKIP_PROP_TYPES.includes(propType)) continue;
    const req = prop.required ? ' [REQUIRED]' : ' [optional]';
    const def = prop.defaultValue !== undefined ? ` (default: ${JSON.stringify(prop.defaultValue)})` : '';
    lines.push(`\n### ${propName} (${prop.displayName || propName})`);
    lines.push(`  Type: ${propType}${req}${def}`);
    if (prop.description) lines.push(`  Description: ${prop.description}`);
    if (propType === 'STATIC_DROPDOWN' && prop.options?.options) {
      lines.push(`  Options: ${prop.options.options.slice(0, 15).map((o: any) => `"${o.label}"=${JSON.stringify(o.value)}`).join(', ')}`);
    }
    if (propType === 'DROPDOWN' || propType === 'MULTI_SELECT_DROPDOWN') {
      lines.push(`  ⚠ DYNAMIC DROPDOWN -- fetch source code to understand valid values`);
      if (prop.refreshers) lines.push(`  Depends on: ${JSON.stringify(prop.refreshers)}`);
    }
    if (propType === 'DYNAMIC') {
      lines.push(`  ⚠ DYNAMIC PROPERTIES -- fetch source to understand`);
      if (prop.refreshers) lines.push(`  Depends on: ${JSON.stringify(prop.refreshers)}`);
    }
  }

  lines.push('\n\nDesign a multi-step plan. Setup steps create fresh resources each run (idempotent). The test step uses inputMapping to reference setup outputs.');
  lines.push('Use {{$uuid}} or {{$timestamp}} in resource names/titles to ensure uniqueness on every run. NEVER use JavaScript template expressions like ${new Date().getTime()} -- they are not evaluated.');
  return lines.join('\n');
}

// ── Detect broken inputMapping paths by cross-referencing step outputs ──

function detectBrokenInputMappings(
  steps: TestPlanStep[],
  stepResults: { stepId: string; status: string; output: unknown; error: string | null; duration_ms: number }[],
): { stepId: string; field: string; expression: string; refStepId: string; path: string; availablePaths: string[] }[] {
  const resultMap = new Map(stepResults.map(sr => [sr.stepId, sr]));
  const broken: { stepId: string; field: string; expression: string; refStepId: string; path: string; availablePaths: string[] }[] = [];

  for (const step of steps) {
    if (!step.inputMapping) continue;
    for (const [field, expression] of Object.entries(step.inputMapping)) {
      const match = expression.match(/^\$\{steps\.([^.]+)\.(.+)\}$/);
      if (!match) continue;
      const [, refStepId, pathStr] = match;
      const refResult = resultMap.get(refStepId);
      if (!refResult || refResult.output === null || refResult.output === undefined) continue;

      // Try to resolve the path starting from the StepResult object
      // (same logic as plan-executor: pathParts navigate from refResult, e.g. "output.ticket.id")
      const pathParts = pathStr.split('.');
      let value: any = refResult;
      for (const part of pathParts) {
        if (value === null || value === undefined) break;
        value = value[part];
      }

      if (value === undefined) {
        const availablePaths = collectLeafPaths(refResult, '', 3);
        broken.push({ stepId: step.id, field, expression, refStepId, path: pathStr, availablePaths });
      }
    }
  }

  return broken;
}

/** Recursively collect dotted paths up to maxDepth levels deep */
function collectLeafPaths(obj: any, prefix: string, maxDepth: number): string[] {
  if (maxDepth === 0 || obj === null || obj === undefined || typeof obj !== 'object') {
    return prefix ? [prefix] : [];
  }
  const paths: string[] = [];
  for (const key of Object.keys(obj).slice(0, 20)) {
    const full = prefix ? `${prefix}.${key}` : key;
    const child = obj[key];
    if (child !== null && typeof child === 'object' && !Array.isArray(child) && maxDepth > 1) {
      paths.push(...collectLeafPaths(child, full, maxDepth - 1));
    } else {
      paths.push(full);
    }
  }
  return paths;
}

function buildFixPlanPrompt(
  piece: PieceMetadataFull, actionName: string, action: PieceActionMeta,
  connectionInfo: { connectionType?: string; hasConnection: boolean },
  previousSteps: TestPlanStep[],
  stepResults: { stepId: string; status: string; output: unknown; error: string | null; duration_ms: number }[],
  agentMemory?: string,
): string {
  const lines: string[] = [];

  lines.push(`# Fix failed test plan for "${action.displayName}" (${actionName})`);
  lines.push(`**Piece:** ${piece.displayName} (${piece.name}) v${piece.version}`);
  lines.push(`**Connection:** ${connectionInfo.hasConnection ? 'Connected' : 'Not connected'}`);
  lines.push('');

  // Inject learned lessons for this piece
  const lessonsBlock = formatLessonsForPrompt(piece.name);
  if (lessonsBlock) lines.push(lessonsBlock);

  // Show the original plan
  lines.push(`## Original Plan (${previousSteps.length} steps):`);
  for (const step of previousSteps) {
    lines.push(`\n### ${step.id} [${step.type}] "${step.label}"`);
    lines.push(`  Action: ${step.actionName}`);
    if (Object.keys(step.input).length > 0) lines.push(`  Input: ${JSON.stringify(step.input)}`);
    if (step.inputMapping && Object.keys(step.inputMapping).length > 0) lines.push(`  InputMapping: ${JSON.stringify(step.inputMapping)}`);
  }

  // Show execution results
  lines.push('\n## Execution Results:');
  for (const sr of stepResults) {
    const step = previousSteps.find(s => s.id === sr.stepId);
    const statusIcon = sr.status === 'completed' ? '✅' : sr.status === 'failed' ? '❌' : sr.status === 'skipped' ? '⏭' : '⏳';
    lines.push(`\n### ${sr.stepId} ${statusIcon} ${sr.status} (${sr.duration_ms}ms)`);
    if (step) lines.push(`  Step: "${step.label}" (${step.actionName})`);
    if (sr.output) {
      const outputStr = typeof sr.output === 'string' ? sr.output : JSON.stringify(sr.output, null, 2);
      lines.push(`  Output:\n\`\`\`json\n${outputStr.slice(0, 5000)}\n\`\`\``);
    }
    if (sr.error) {
      lines.push(`  Error:\n\`\`\`\n${sr.error}\n\`\`\``);
    }
  }

  // ── Highlight broken inputMapping paths ──
  const broken = detectBrokenInputMappings(previousSteps, stepResults);
  if (broken.length > 0) {
    lines.push('\n## ⚠ BROKEN inputMapping paths (resolved to undefined at runtime):');
    lines.push('The executor tried to navigate these paths but found nothing. The path is WRONG -- fix it. Do NOT add placeholder values to base input.\n');
    for (const b of broken) {
      lines.push(`- **${b.stepId}.${b.field}**: expression \`${b.expression}\``);
      lines.push(`  Path tried: \`${b.path}\` (starting from the StepResult object)`);
      if (b.availablePaths.length > 0) {
        lines.push(`  Actual paths available in ${b.refStepId}: \`${b.availablePaths.join('`, `')}\``);
        lines.push(`  → Pick the correct path from the list above and update the inputMapping expression.`);
      }
    }
  }

  if (agentMemory) {
    lines.push('');
    lines.push(`## Agent Memory (from plan creation):`);
    lines.push(agentMemory);
  }

  lines.push('');
  lines.push(`## All actions in this piece:`);
  for (const [n, act] of Object.entries(piece.actions)) {
    lines.push(`  - ${n}: "${act.displayName}"`);
  }

  lines.push('');
  lines.push(`## Properties for "${action.displayName}":`);
  const props = action.props || {};
  for (const [propName, propDef] of Object.entries(props)) {
    const prop = propDef as any;
    const propType = prop.type ?? 'UNKNOWN';
    if (AUTH_PROP_TYPES.includes(propType) || SKIP_PROP_TYPES.includes(propType)) continue;
    lines.push(`  - ${propName}: type=${propType}${prop.required ? ' [REQUIRED]' : ''}`);
  }

  lines.push('\n\n1. Analyze the step results -- which step failed and WHY?');
  lines.push('2. If there are BROKEN inputMapping paths listed above, fix the path to match the actual output. Do NOT add placeholder values to base input -- that does not fix wrong paths.');
  lines.push('3. If the correct path is still unclear, use execute_action to run the setup step and inspect its output directly');
  lines.push('4. Fix the plan steps accordingly');
  lines.push('5. Update agent_memory with what you learned (correct paths, root cause, what you changed)');
  lines.push('6. Call set_test_plan with the corrected steps');

  return lines.join('\n');
}

import type { PieceMetadataFull } from '../../../services/ap-client.js';
import type { OnLogCallback, ResearchFindings, ToolContext } from '../types.js';
import { runAgentLoop } from '../agent-runner.js';
import { createToolRegistry, RESEARCH_TOOLS } from '../tools/index.js';
import { RESEARCH_SYSTEM_PROMPT, buildResearchUserPrompt } from '../prompts/research.js';
import { parseResearchFindings } from '../prompts/coordinator.js';

/**
 * Run the research worker.
 * Returns structured findings parsed from the agent's free-text output.
 */
export async function runResearchWorker(params: {
  pieceMeta: PieceMetadataFull;
  actionName: string;
  previousMemory?: string;
  onLog: OnLogCallback;
  abortSignal?: AbortSignal;
}): Promise<ResearchFindings> {
  const { pieceMeta, actionName, previousMemory, onLog, abortSignal } = params;
  const registry = createToolRegistry();

  const toolCtx: ToolContext = { pieceMeta, actionName, abortSignal };

  const result = await runAgentLoop(registry, {
    role: 'research',
    model: '',
    systemPrompt: RESEARCH_SYSTEM_PROMPT,
    initialMessages: [
      { role: 'user', content: buildResearchUserPrompt(pieceMeta, actionName, previousMemory) },
    ],
    maxIterations: 12,
    toolNames: [...RESEARCH_TOOLS],
    abortSignal,
    onLog,
  }, toolCtx);

  // The research worker doesn't use a terminal tool -- it just writes its
  // findings as text in its last assistant message. Extract that text.
  const lastAssistantMsg = [...result.messages].reverse().find(m => m.role === 'assistant');
  let rawText = '';

  if (lastAssistantMsg && Array.isArray(lastAssistantMsg.content)) {
    for (const block of lastAssistantMsg.content) {
      if (typeof block === 'object' && 'type' in block && block.type === 'text') {
        rawText += block.text + '\n';
      }
    }
  } else if (lastAssistantMsg && typeof lastAssistantMsg.content === 'string') {
    rawText = lastAssistantMsg.content;
  }

  return parseResearchFindings(rawText);
}

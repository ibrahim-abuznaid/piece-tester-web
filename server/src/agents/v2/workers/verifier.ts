import type { PieceMetadataFull } from '../../../services/ap-client.js';
import type { OnLogCallback, TestPlanStep, VerificationResult, VerificationIssue, Verdict, ToolContext } from '../types.js';
import { runAgentLoop } from '../agent-runner.js';
import { createToolRegistry, VERIFIER_TOOLS } from '../tools/index.js';
import { VERIFIER_SYSTEM_PROMPT, buildVerifierUserPrompt } from '../prompts/verifier.js';
import type { CostTracker } from '../cost-tracker.js';

/**
 * Parse the verifier's free-text output into a structured result.
 */
function parseVerifierOutput(rawText: string): VerificationResult {
  let verdict: Verdict = 'PARTIAL';
  const issues: VerificationIssue[] = [];
  let summary = '';

  const verdictMatch = rawText.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i);
  if (verdictMatch) {
    verdict = verdictMatch[1].toUpperCase() as Verdict;
  }

  // Parse issues
  const issueRegex = /^-\s*\[?(error|warning)\]?\s*(?:\[?(?:Step\s*)?(\w+)\]?)?\s*(?:\[?field\s*"?(\w+)"?\]?)?\s*:?\s*(.+)/gim;
  let match: RegExpExecArray | null;
  while ((match = issueRegex.exec(rawText)) !== null) {
    issues.push({
      severity: match[1].toLowerCase() as 'error' | 'warning',
      stepId: match[2] || undefined,
      field: match[3] || undefined,
      message: match[4].trim(),
    });
  }

  const summaryMatch = rawText.match(/### Summary\n([\s\S]*?)(?=\n###|$)/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  } else {
    // Use the last paragraph as summary
    const paragraphs = rawText.split('\n\n').filter(p => p.trim());
    summary = paragraphs[paragraphs.length - 1]?.trim() || '';
  }

  return { verdict, issues, summary };
}

/**
 * Run the verifier worker to adversarially validate a test plan.
 */
export async function runVerifierWorker(params: {
  pieceMeta: PieceMetadataFull;
  actionName: string;
  steps: TestPlanStep[];
  planNote: string;
  onLog: OnLogCallback;
  abortSignal?: AbortSignal;
  costTracker?: CostTracker;
}): Promise<VerificationResult> {
  const { pieceMeta, actionName, steps, planNote, onLog, abortSignal, costTracker } = params;
  const registry = createToolRegistry();

  const toolCtx: ToolContext = { pieceMeta, actionName, abortSignal };

  const result = await runAgentLoop(registry, {
    role: 'verifier',
    model: '',
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    initialMessages: [
      { role: 'user', content: buildVerifierUserPrompt(pieceMeta, actionName, steps, planNote) },
    ],
    maxIterations: 8,
    toolNames: [...VERIFIER_TOOLS],
    abortSignal,
    onLog,
  }, toolCtx, costTracker);

  // Extract the verifier's text output
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

  if (!rawText.trim()) {
    onLog({ timestamp: Date.now(), type: 'error', role: 'verifier', message: 'Verifier produced no output.' });
    return { verdict: 'PARTIAL', issues: [], summary: 'Verifier produced no output.' };
  }

  return parseVerifierOutput(rawText);
}

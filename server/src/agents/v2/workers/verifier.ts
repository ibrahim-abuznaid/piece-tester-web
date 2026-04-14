import type Anthropic from '@anthropic-ai/sdk';
import type { PieceMetadataFull } from '../../../services/ap-client.js';
import type {
  OnLogCallback, TestPlanStep, VerificationResult, VerificationIssue, Verdict, ToolContext,
} from '../types.js';
import { runAgentLoop } from '../agent-runner.js';
import { createToolRegistry, VERIFIER_TOOLS } from '../tools/index.js';
import { VERIFIER_SYSTEM_PROMPT, VERIFIER_SYSTEM_PROMPT_MCP, buildVerifierUserPrompt } from '../prompts/verifier.js';
import type { CostTracker } from '../cost-tracker.js';
import { getSettings } from '../../../db/queries.js';

/** Text after `]**` (markdown bold close after bracket tags). */
function extractIssueMessage(line: string): string {
  const pos = line.lastIndexOf(']**');
  if (pos !== -1) return line.slice(pos + 3).trim();
  return line.replace(/^-\s*/, '').replace(/^\*\*/, '').trim();
}

/**
 * Parse the verifier's free-text output into a structured result.
 * Handles multiple model formats, including:
 * - `- [severity: error] [step_1] [field] message`
 * - `- **[severity: error] [global] [custom_api_call]** message`
 */
function parseVerifierOutput(rawText: string): VerificationResult {
  let verdict: Verdict = 'PARTIAL';
  const issues: VerificationIssue[] = [];
  let summary = '';

  const verdictMatch = rawText.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i);
  if (verdictMatch) {
    verdict = verdictMatch[1].toUpperCase() as Verdict;
  }

  const issuesSectionMatch = rawText.match(
    /###\s*Issues\s+Found\s*\n([\s\S]*?)(?=\n###\s*Summary|\n##\s*Summary|$)/i,
  );
  const issuesBlock = issuesSectionMatch ? issuesSectionMatch[1] : rawText;

  for (const line of issuesBlock.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('-')) continue;

    const sevMatch = t.match(/\[severity:\s*(error|warning)\]/i);
    if (sevMatch) {
      const severity = sevMatch[1].toLowerCase() as 'error' | 'warning';
      const message = extractIssueMessage(t);

      let stepId: string | undefined;
      const stepM = t.match(/\[(step_\d+)\]/i);
      if (stepM) stepId = stepM[1];
      else if (/\[global\]/i.test(t)) stepId = 'global';

      let field: string | undefined;
      const triple = t.match(
        /\[severity:\s*(?:error|warning)\]\s*\[[^\]]+\]\s*\[([^\]]+)\]/i,
      );
      if (triple) field = triple[1];

      issues.push({
        severity,
        stepId,
        field,
        message: message || t.replace(/^-\s*/, '').trim(),
      });
      continue;
    }

    // Legacy: `- error step_1 ...` or `- [error] ...`
    const legacy = t.match(
      /^-\s*\[?(error|warning)\]?\s*(?:\[?(?:Step\s*)?(\w+)\]?)?\s*(?:\[?field\s*"?(\w+)"?\]?)?\s*:?\s*(.+)/i,
    );
    if (legacy?.[4]?.trim()) {
      issues.push({
        severity: legacy[1].toLowerCase() as 'error' | 'warning',
        stepId: legacy[2] || undefined,
        field: legacy[3] || undefined,
        message: legacy[4].trim(),
      });
    }
  }

  // If verdict is FAIL but nothing parsed, surface summary as a synthetic issue so the fixer gets context
  if (verdict === 'FAIL' && issues.length === 0) {
    const sumMatch = rawText.match(/###\s*Summary\s*\n([\s\S]*?)(?=\n###|$)/i);
    issues.push({
      severity: 'error',
      message:
        sumMatch?.[1]?.trim().slice(0, 4000)
        ?? 'Verifier reported FAIL but issue bullets could not be parsed; review verifier text manually.',
    });
  }

  const summaryMatch = rawText.match(/###\s*Summary\s*\n([\s\S]*?)(?=\n###|$)/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  } else {
    const paragraphs = rawText.split('\n\n').filter(p => p.trim());
    summary = paragraphs[paragraphs.length - 1]?.trim() || '';
  }

  return { verdict, issues, summary };
}

/** Concatenate all assistant text blocks (verdict may span turns; last message may be tool-only). */
function extractAllAssistantText(messages: Anthropic.Messages.MessageParam[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const c = m.content;
    if (typeof c === 'string') {
      parts.push(c);
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      if (typeof block === 'object' && block && 'type' in block && (block as { type: string }).type === 'text' && 'text' in block) {
        parts.push((block as { text: string }).text);
      }
    }
  }
  return parts.join('\n\n');
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
  const mcpEnabled = !!getSettings().mcp_token;

  const toolCtx: ToolContext = { pieceMeta, actionName, abortSignal };

  const result = await runAgentLoop(registry, {
    role: 'verifier',
    model: '',
    systemPrompt: mcpEnabled ? VERIFIER_SYSTEM_PROMPT_MCP : VERIFIER_SYSTEM_PROMPT,
    initialMessages: [
      { role: 'user', content: buildVerifierUserPrompt(pieceMeta, actionName, steps, planNote) },
    ],
    maxIterations: 8,
    toolNames: [...VERIFIER_TOOLS],
    abortSignal,
    onLog,
  }, toolCtx, costTracker);

  const rawText = extractAllAssistantText(result.messages);

  if (!rawText.trim()) {
    onLog({ timestamp: Date.now(), type: 'error', role: 'verifier', message: 'Verifier produced no output.' });
    return { verdict: 'PARTIAL', issues: [], summary: 'Verifier produced no output.' };
  }

  return parseVerifierOutput(rawText);
}

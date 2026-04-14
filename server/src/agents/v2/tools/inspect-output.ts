import type { ToolDefinition, TestPlanStep } from '../types.js';

/** Recursively collect dotted paths up to maxDepth levels deep. */
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

export interface BrokenMapping {
  stepId: string;
  field: string;
  expression: string;
  refStepId: string;
  path: string;
  availablePaths: string[];
}

/**
 * Cross-reference inputMapping expressions against actual step outputs
 * to find broken paths. Used by the verifier and fixer workers.
 */
export function detectBrokenInputMappings(
  steps: TestPlanStep[],
  stepResults: { stepId: string; status: string; output: unknown; error: string | null; duration_ms: number }[],
): BrokenMapping[] {
  const resultMap = new Map(stepResults.map(sr => [sr.stepId, sr]));
  const broken: BrokenMapping[] = [];

  for (const step of steps) {
    if (!step.inputMapping) continue;
    for (const [field, expression] of Object.entries(step.inputMapping)) {
      const match = expression.match(/^\$\{steps\.([^.]+)\.(.+)\}$/);
      if (!match) continue;
      const [, refStepId, pathStr] = match;
      const refResult = resultMap.get(refStepId);
      if (!refResult || refResult.output === null || refResult.output === undefined) continue;

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

/**
 * Tool that lets the verifier agent statically analyze a plan's inputMapping
 * against the known output structure of an action (by executing it in dry-run).
 */
export const inspectOutputTool: ToolDefinition = {
  name: 'inspect_output',
  description: 'Execute an action and inspect its output structure to validate that inputMapping paths are correct. Returns the output JSON with available dot-paths. IMPORTANT: if the action requires auth, include "auth" in the input object set to the connection externalId you found via ap_list_connections (e.g. {"auth": "tx1a86yrIY2fsCxxX8r35", ...other fields...}). Without auth, authenticated actions will return a 403 error.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action_name: { type: 'string', description: 'The action to execute and inspect' },
      input: { type: 'object' as const, description: 'Input parameters for the action. Include "auth": "<externalId>" if the action requires authentication.', additionalProperties: true },
      reason: { type: 'string', description: 'Why you need to inspect this output' },
    },
    required: ['action_name', 'input', 'reason'],
  },
  async handler(input, ctx) {
    const { executeActionOnAP } = await import('../../../services/ai-config-generator.js');
    try {
      const result = await executeActionOnAP(ctx.pieceMeta, input.action_name, input.input || {});
      const paths = collectLeafPaths(result, '', 4);
      const json = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return `Output (${json.length} chars):\n${json.slice(0, 5000)}\n\nAvailable paths:\n${paths.join('\n')}`;
    } catch (err: any) {
      return `Failed to execute: ${err.message}`;
    }
  },
};

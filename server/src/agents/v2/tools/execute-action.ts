import type { ToolDefinition } from '../types.js';
import { executeActionOnAP } from '../../../services/ai-config-generator.js';

export const executeActionTool: ToolDefinition = {
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
  async handler(input, ctx) {
    try {
      const result = await executeActionOnAP(ctx.pieceMeta, input.action_name, input.input || {});
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return `Success:\n\n${text.slice(0, 10000)}`;
    } catch (err: any) {
      return `Failed: ${err.message}`;
    }
  },
};

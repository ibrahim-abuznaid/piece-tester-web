import type { ToolDefinition } from '../types.js';
import { getSettings } from '../../../db/queries.js';
import { ActivepiecesClient } from '../../../services/ap-client.js';

/**
 * Deletes a temporary test flow created by the agent via MCP (ap_create_flow).
 *
 * When MCP mode is active, agents create flows directly via ap_create_flow.
 * Since ap_delete_flow is not exposed in the MCP server, this local tool
 * handles cleanup via the REST API so agents can tidy up after testing.
 *
 * Only registered when mcpEnabled is true in the tool context.
 */
export const cleanupFlowTool: ToolDefinition = {
  name: 'cleanup_flow',
  description: 'Delete a temporary test flow you created via ap_create_flow. Call this after you have finished testing to keep the project tidy. Provide the flow ID returned by ap_create_flow.',
  input_schema: {
    type: 'object' as const,
    properties: {
      flow_id: { type: 'string', description: 'The ID of the flow to delete' },
      reason: { type: 'string', description: 'Brief note on why this flow is being deleted' },
    },
    required: ['flow_id'],
  },
  async handler(input, _ctx) {
    const { flow_id, reason } = input as { flow_id: string; reason?: string };
    const s = getSettings();
    const client = new ActivepiecesClient(s.base_url, s.api_key, s.project_id, s.jwt_token);
    try {
      await client.deleteFlowSafely(flow_id, 3, reason || 'agent cleanup');
      return `Flow ${flow_id} deleted successfully.`;
    } catch (err: any) {
      return `Warning: Could not delete flow ${flow_id}: ${err.message}. You may need to delete it manually.`;
    }
  },
};

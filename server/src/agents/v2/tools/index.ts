import { ToolRegistry } from '../tool-registry.js';
import { fetchPieceSourceTool, fetchActionSourceTool } from './fetch-source.js';
import { executeActionTool } from './execute-action.js';
import { setPlanTool } from './set-plan.js';
import { listActionsTool } from './list-actions.js';
import { inspectOutputTool } from './inspect-output.js';

/** Tool name constants for easy reference. */
export const TOOL_NAMES = {
  FETCH_PIECE_SOURCE: 'fetch_piece_source',
  FETCH_ACTION_SOURCE: 'fetch_action_source',
  EXECUTE_ACTION: 'execute_action',
  SET_TEST_PLAN: 'set_test_plan',
  LIST_ACTIONS: 'list_actions',
  INSPECT_OUTPUT: 'inspect_output',
} as const;

/** Read-only tools safe for research workers. */
export const RESEARCH_TOOLS = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.EXECUTE_ACTION,
  TOOL_NAMES.LIST_ACTIONS,
] as const;

/** All tools available to the planner worker. */
export const PLANNER_TOOLS = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.EXECUTE_ACTION,
  TOOL_NAMES.LIST_ACTIONS,
  TOOL_NAMES.SET_TEST_PLAN,
] as const;

/** Tools for verification (read-only + inspect). */
export const VERIFIER_TOOLS = [
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.INSPECT_OUTPUT,
  TOOL_NAMES.LIST_ACTIONS,
] as const;

/** Full tool set for the fixer. */
export const FIXER_TOOLS = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.EXECUTE_ACTION,
  TOOL_NAMES.LIST_ACTIONS,
  TOOL_NAMES.INSPECT_OUTPUT,
  TOOL_NAMES.SET_TEST_PLAN,
] as const;

/** Terminal tools that stop the agent loop when called. */
export const TERMINAL_TOOLS = new Set([TOOL_NAMES.SET_TEST_PLAN]);

/** Create a fully populated tool registry with all built-in tools. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fetchPieceSourceTool);
  registry.register(fetchActionSourceTool);
  registry.register(executeActionTool);
  registry.register(setPlanTool);
  registry.register(listActionsTool);
  registry.register(inspectOutputTool);
  return registry;
}

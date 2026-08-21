import { ToolRegistry } from '../tool-registry.js';
import { fetchPieceSourceTool, fetchActionSourceTool } from './fetch-source.js';
import { fetchTriggerSourceTool } from './fetch-trigger-source.js';
import { executeActionTool } from './execute-action.js';
import { testTriggerTool } from './test-trigger.js';
import { testTriggerSimulationTool } from './test-trigger-simulation.js';
import { setPlanTool } from './set-plan.js';
import { listActionsTool } from './list-actions.js';
import { listTriggersTool } from './list-triggers.js';
import { inspectOutputTool } from './inspect-output.js';
import { cleanupFlowTool } from './cleanup-flow.js';

/** Tool name constants for easy reference. */
export const TOOL_NAMES = {
  FETCH_PIECE_SOURCE: 'fetch_piece_source',
  FETCH_ACTION_SOURCE: 'fetch_action_source',
  FETCH_TRIGGER_SOURCE: 'fetch_trigger_source',
  EXECUTE_ACTION: 'execute_action',
  TEST_TRIGGER: 'test_trigger',
  TEST_TRIGGER_SIMULATION: 'test_trigger_simulation',
  SET_TEST_PLAN: 'set_test_plan',
  LIST_ACTIONS: 'list_actions',
  LIST_TRIGGERS: 'list_triggers',
  INSPECT_OUTPUT: 'inspect_output',
  CLEANUP_FLOW: 'cleanup_flow',
} as const;

/** Read-only tools safe for research workers. */
export const RESEARCH_TOOLS = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.EXECUTE_ACTION,
  TOOL_NAMES.LIST_ACTIONS,
] as const;

/**
 * Research tools when MCP mode is active.
 * execute_action is replaced by native MCP tools; cleanup_flow handles REST-only deletion.
 */
export const RESEARCH_TOOLS_MCP = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.LIST_ACTIONS,
  TOOL_NAMES.CLEANUP_FLOW,
] as const;

/** All tools available to the planner worker. */
export const PLANNER_TOOLS = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.EXECUTE_ACTION,
  TOOL_NAMES.LIST_ACTIONS,
  TOOL_NAMES.SET_TEST_PLAN,
] as const;

/** Planner tools when MCP mode is active. */
export const PLANNER_TOOLS_MCP = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.LIST_ACTIONS,
  TOOL_NAMES.SET_TEST_PLAN,
] as const;

/**
 * Tools for the trigger planner worker (Phase A: polling triggers).
 * A single agent researches inline (source + live test) and emits the plan.
 * Uses local tools regardless of MCP mode for simplicity.
 */
export const TRIGGER_PLANNER_TOOLS = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_TRIGGER_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.LIST_TRIGGERS,
  TOOL_NAMES.LIST_ACTIONS,
  TOOL_NAMES.EXECUTE_ACTION,
  TOOL_NAMES.TEST_TRIGGER,
  TOOL_NAMES.TEST_TRIGGER_SIMULATION,
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

/**
 * Tools for the trigger fixer (Phase B).
 * Mirrors FIXER_TOOLS plus the trigger-specific research/test tools.
 * Uses local tools regardless of MCP mode, matching the trigger planner.
 */
export const TRIGGER_FIXER_TOOLS = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_TRIGGER_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.LIST_TRIGGERS,
  TOOL_NAMES.LIST_ACTIONS,
  TOOL_NAMES.EXECUTE_ACTION,
  TOOL_NAMES.TEST_TRIGGER,
  TOOL_NAMES.TEST_TRIGGER_SIMULATION,
  TOOL_NAMES.INSPECT_OUTPUT,
  TOOL_NAMES.SET_TEST_PLAN,
] as const;

/** Fixer tools when MCP mode is active. */
export const FIXER_TOOLS_MCP = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.LIST_ACTIONS,
  TOOL_NAMES.INSPECT_OUTPUT,
  TOOL_NAMES.SET_TEST_PLAN,
  TOOL_NAMES.CLEANUP_FLOW,
] as const;

/** Terminal tools that stop the agent loop when called. */
export const TERMINAL_TOOLS = new Set([TOOL_NAMES.SET_TEST_PLAN]);

/** Create a fully populated tool registry with all built-in tools. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fetchPieceSourceTool);
  registry.register(fetchActionSourceTool);
  registry.register(fetchTriggerSourceTool);
  registry.register(executeActionTool);
  registry.register(testTriggerTool);
  registry.register(testTriggerSimulationTool);
  registry.register(setPlanTool);
  registry.register(listActionsTool);
  registry.register(listTriggersTool);
  registry.register(inspectOutputTool);
  registry.register(cleanupFlowTool);
  return registry;
}

import type { PieceMetadataFull } from '../../../services/ap-client.js';
import type { TestPlanStep, VerificationResult } from '../types.js';
import {
  buildPieceContext, buildActionsList, buildActionProperties,
  buildTriggerContext, buildTriggerProperties, buildTriggersList,
  RUNTIME_TOKENS_DOC, INPUT_MAPPING_DOC, NO_CUSTOM_HTTP_RULE,
} from './shared.js';
import { formatLessonsForPrompt } from '../../../services/lesson-extractor.js';
import type { BrokenMapping } from '../tools/inspect-output.js';

function buildUserInstructionBlock(userInstruction?: string): string[] {
  const text = userInstruction?.trim();
  if (!text) return [];
  return [
    '',
    '## User instructions (prioritize these over your own guesses):',
    text,
  ];
}

export const FIXER_SYSTEM_PROMPT = `You are a FIXER agent for an Activepieces test planning system. A test plan either failed verification or failed during execution. Your job is to diagnose the problem and produce a FIXED plan.

## Your Tools
1. **fetch_piece_source** / **fetch_action_source** -- Read source code from GitHub
2. **execute_action** -- Execute actions to investigate (check outputs, test inputs)
3. **list_actions** -- Check available actions and their properties
4. **inspect_output** -- Execute an action and inspect its output to find correct paths
5. **set_test_plan** -- Output the FIXED plan

## Fixing Strategies
- Wrong inputMapping path → Use inspect_output to find the correct path in the actual output
- Missing required fields → Fetch source to understand what's needed
- "Already exists" errors → Add {{$uuid}} or {{$timestamp}} to make names unique
- Wrong action name → Check list_actions for the correct name
- Piece bug (TypeError in source) → Remove the problematic step and note it in agent_memory

${RUNTIME_TOKENS_DOC}

${INPUT_MAPPING_DOC}

## Rules
- NEVER add placeholder values to base input as a workaround for broken inputMapping
- When an inputMapping path resolves to undefined, the ONLY correct fix is finding the RIGHT path
- Do NOT trust agent_memory if it contradicts actual step outputs
- Include DETAILED agent_memory explaining what failed, why, and what you changed
- ALWAYS call set_test_plan with the corrected steps
- Do NOT use requiresApproval: true on cleanup steps

${NO_CUSTOM_HTTP_RULE}`;

/**
 * MCP-augmented fixer prompt.
 * Adds ap_validate_step_config for post-fix validation before submission.
 */
export const FIXER_SYSTEM_PROMPT_MCP = `You are a FIXER agent for an Activepieces test planning system. A test plan either failed verification or failed during execution. Your job is to diagnose the problem and produce a FIXED plan.

## Your Tools
1. **fetch_piece_source** / **fetch_action_source** -- Read source code from GitHub
2. **list_actions** -- Check available actions and their properties
3. **inspect_output** -- Execute an action and inspect its output to find correct paths
4. **set_test_plan** -- Output the FIXED plan

## Your MCP Tools (Activepieces native)
- **ap_get_piece_props**: Check exact field names, types, and dropdown options when fixing config errors.
- **ap_validate_step_config**: **REQUIRED** — after making any fix, call this to confirm the fix is structurally valid. Do NOT call set_test_plan until ALL modified steps pass ap_validate_step_config.
- **ap_create_flow** + **ap_add_step** + **ap_update_step** + **ap_test_step** + **ap_get_run**: Use to test your fix before committing it. Always give the flow a display name starting with \`[AI Agent]\` so it can be swept if cleanup is missed.
- **cleanup_flow**: Delete any test flows you created.

## Fix & Validate Workflow
For each change you make:
1. Make the fix
2. Call ap_validate_step_config for the modified step
3. If validation fails, iterate on the fix
4. Only call set_test_plan after all modified steps pass validation

## Fixing Strategies
- Wrong inputMapping path → Use inspect_output to find the correct path in the actual output
- Missing required fields → Use ap_get_piece_props to understand what's needed
- "Already exists" errors → Add {{$uuid}} or {{$timestamp}} to make names unique
- Wrong action name → Check list_actions for the correct name
- Piece bug (TypeError in source) → Remove the problematic step and note it in agent_memory

${RUNTIME_TOKENS_DOC}

${INPUT_MAPPING_DOC}

## Auth in Plan Steps
For authenticated actions, ensure every step that requires auth has "auth": "<externalId>" in its input (bare externalId, not {{connections.xxx}}). Use ap_list_connections to find the correct externalId if it is missing.
For inspect_output: also pass "auth": "<externalId>" in the input object, otherwise you will get 403 errors.

## Rules
- NEVER add placeholder values to base input as a workaround for broken inputMapping
- When an inputMapping path resolves to undefined, the ONLY correct fix is finding the RIGHT path
- Do NOT trust agent_memory if it contradicts actual step outputs
- Include DETAILED agent_memory explaining what failed, why, and what you changed
- ALWAYS validate modified steps with ap_validate_step_config before calling set_test_plan
- ALWAYS call set_test_plan with the corrected steps
- Do NOT use requiresApproval: true on cleanup steps

${NO_CUSTOM_HTTP_RULE}`;

export function buildFixerUserPrompt(params: {
  pieceMeta: PieceMetadataFull;
  actionName: string;
  previousSteps: TestPlanStep[];
  verificationResult?: VerificationResult;
  stepResults?: { stepId: string; status: string; output: unknown; error: string | null; duration_ms: number }[];
  brokenMappings?: BrokenMapping[];
  agentMemory?: string;
  userInstruction?: string;
}): string {
  const { pieceMeta, actionName, previousSteps, verificationResult, stepResults, brokenMappings, agentMemory, userInstruction } = params;
  const piece = pieceMeta;
  const action = piece.actions[actionName];
  const lines: string[] = [];

  lines.push(`# Fix test plan for "${action?.displayName}" (${actionName})`);
  lines.push('');
  lines.push(buildPieceContext(piece, actionName));
  lines.push('');

  const lessonsBlock = formatLessonsForPrompt(piece.name);
  if (lessonsBlock) lines.push(lessonsBlock);

  // Show verification issues if this is a pre-execution fix
  if (verificationResult) {
    lines.push('');
    lines.push(`## Verification Result: ${verificationResult.verdict}`);
    lines.push(verificationResult.summary);
    if (verificationResult.issues.length > 0) {
      lines.push('\n### Issues:');
      for (const issue of verificationResult.issues) {
        lines.push(`- [${issue.severity}] ${issue.stepId ? `Step ${issue.stepId}` : ''} ${issue.field ? `field "${issue.field}"` : ''}: ${issue.message}`);
      }
    }
  }

  // Show original plan
  lines.push('');
  lines.push(`## Original Plan (${previousSteps.length} steps):`);
  for (const step of previousSteps) {
    lines.push(`\n### ${step.id} [${step.type}] "${step.label}"`);
    lines.push(`  Action: ${step.actionName}`);
    if (Object.keys(step.input).length > 0) lines.push(`  Input: ${JSON.stringify(step.input)}`);
    if (step.inputMapping && Object.keys(step.inputMapping).length > 0) {
      lines.push(`  InputMapping: ${JSON.stringify(step.inputMapping)}`);
    }
  }

  // Show execution results if this is a post-execution fix
  if (stepResults && stepResults.length > 0) {
    lines.push('\n## Execution Results:');
    for (const sr of stepResults) {
      const step = previousSteps.find(s => s.id === sr.stepId);
      const icon = sr.status === 'completed' ? '✅' : sr.status === 'failed' ? '❌' : '⏭';
      lines.push(`\n### ${sr.stepId} ${icon} ${sr.status} (${sr.duration_ms}ms)`);
      if (step) lines.push(`  Step: "${step.label}" (${step.actionName})`);
      if (sr.output) {
        const outputStr = typeof sr.output === 'string' ? sr.output : JSON.stringify(sr.output, null, 2);
        lines.push(`  Output:\n\`\`\`json\n${outputStr.slice(0, 5000)}\n\`\`\``);
      }
      if (sr.error) lines.push(`  Error:\n\`\`\`\n${sr.error}\n\`\`\``);
    }
  }

  // Show broken mappings
  if (brokenMappings && brokenMappings.length > 0) {
    lines.push('\n## ⚠ BROKEN inputMapping paths:');
    for (const b of brokenMappings) {
      lines.push(`- **${b.stepId}.${b.field}**: expression \`${b.expression}\``);
      lines.push(`  Path tried: \`${b.path}\``);
      if (b.availablePaths.length > 0) {
        lines.push(`  Available paths: \`${b.availablePaths.join('`, `')}\``);
      }
    }
  }

  if (agentMemory) {
    lines.push('');
    lines.push('## Agent Memory (from creation):');
    lines.push(agentMemory);
  }

  lines.push('');
  lines.push(buildActionsList(piece));
  lines.push('');
  if (action) lines.push(buildActionProperties(action, actionName));

  lines.push(...buildUserInstructionBlock(userInstruction));

  lines.push('\n\nFix the plan based on the issues above. Call set_test_plan with the corrected steps.');

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════
// Trigger fixer (Phase B) — mirrors the action fixer for trigger plans.
// ══════════════════════════════════════════════════════════════

export const TRIGGER_FIXER_SYSTEM_PROMPT = `You are a FIXER agent for an Activepieces TRIGGER test planning system. A trigger test plan failed during execution (it threw, captured nothing, or an output assertion did not hold). Diagnose the problem and produce a FIXED plan.

## Two trigger plan shapes (keep the shape; fix within it)

### POLLING triggers -> TEST_FUNCTION
- (optional) setup step(s) that create data ONLY if the live test returns zero samples.
- EXACTLY ONE trigger_test step: kind="trigger", triggerName=<trigger>, triggerStrategy="TEST_FUNCTION", actionName="".

### WEBHOOK / APP_WEBHOOK triggers -> SIMULATION (ORDER MATTERS)
1. trigger_arm step (kind="trigger", triggerStrategy="SIMULATION", actionName="") — MUST come first.
2. one or more generator action steps (type="setup") that cause the event.
3. trigger_test step (kind="trigger", triggerStrategy="SIMULATION", actionName="") — MUST come last (captures + asserts).

## Your Tools
1. **fetch_piece_source** / **fetch_trigger_source** / **fetch_action_source** — read source to learn the strategy, props, emitted payload, and which action fires the trigger.
2. **list_triggers** / **list_actions** — list available triggers/actions with property details.
3. **execute_action** — run an action (e.g. create generator data, or read/verify).
4. **test_trigger** — run a POLLING trigger live (TEST_FUNCTION) and see its sample data.
5. **test_trigger_simulation** — validate a WEBHOOK/APP_WEBHOOK trigger end-to-end (arm -> generator -> capture).
6. **inspect_output** — inspect a step's output to find correct assertion/mapping paths.
7. **set_test_plan** — output the FIXED plan (you MUST call this).

## Fixing Strategies (triggers)
- Zero samples captured (POLLING) → add/repair a setup step that first creates the data the trigger watches for; confirm with test_trigger.
- Zero events captured (SIMULATION) → the generator action did not fire the trigger. Pick a different generator action (check list_actions / source) and confirm with test_trigger_simulation.
- Failing output assertion → the path is wrong for the strategy. POLLING (TEST_FUNCTION) paths resolve against the ARRAY of samples: use "0.<field>" for the first sample and "" with not_empty to require at least one item. SIMULATION paths resolve against the SINGLE captured event: use bare field paths ("id", "email"). Never prefix with "samples." and never assert on "sampleCount".
- Wrong generator inputMapping path → use inspect_output to find the correct path in the actual output.
- "Already exists" errors in a generator → add {{$uuid}} or {{$timestamp}} for uniqueness.
- Wrong trigger strategy in the step → match the trigger's real strategy (stated in the spec below).
- Piece bug (TypeError in trigger source) → note it clearly in agent_memory.

${RUNTIME_TOKENS_DOC}

${INPUT_MAPPING_DOC}

## Rules
- Keep the correct plan shape for the trigger's strategy (POLLING vs SIMULATION).
- NEVER add placeholder values to base input as a workaround for a broken inputMapping — find the RIGHT path.
- Do NOT trust agent_memory if it contradicts actual step outputs.
- ALWAYS keep 1-4 output \`assertions\` on the trigger_test step proving a real event/sample arrived with the expected shape.
- AVOID requiresApproval: true — plans run unattended on schedules.
- Include DETAILED agent_memory explaining what failed, why, and what you changed.
- ALWAYS call set_test_plan with the corrected steps.

${NO_CUSTOM_HTTP_RULE}`;

export function buildTriggerFixerUserPrompt(params: {
  pieceMeta: PieceMetadataFull;
  triggerName: string;
  previousSteps: TestPlanStep[];
  stepResults?: { stepId: string; status: string; output: unknown; error: string | null; duration_ms: number }[];
  brokenMappings?: BrokenMapping[];
  agentMemory?: string;
  userInstruction?: string;
}): string {
  const { pieceMeta, triggerName, previousSteps, stepResults, brokenMappings, agentMemory, userInstruction } = params;
  const piece = pieceMeta;
  const trigger = piece.triggers[triggerName];
  const strategy = trigger?.type || 'UNKNOWN';
  const lines: string[] = [];

  lines.push(`# Fix test plan for the trigger "${trigger?.displayName || triggerName}" (${triggerName})`);
  lines.push('');
  lines.push(buildTriggerContext(piece, triggerName));
  lines.push('');
  lines.push(`**Trigger strategy:** ${strategy} → use the ${strategy === 'POLLING' ? 'TEST_FUNCTION' : 'SIMULATION'} plan shape.`);

  const lessonsBlock = formatLessonsForPrompt(piece.name);
  if (lessonsBlock) { lines.push(''); lines.push(lessonsBlock); }

  // Original plan
  lines.push('');
  lines.push(`## Original Plan (${previousSteps.length} steps):`);
  for (const step of previousSteps) {
    lines.push(`\n### ${step.id} [${step.type}] "${step.label}"`);
    if (step.kind === 'trigger') {
      lines.push(`  Trigger: ${step.triggerName || step.actionName} (${step.triggerStrategy || strategy})`);
    } else if (step.actionName) {
      lines.push(`  Action: ${step.actionName}`);
    }
    if (Object.keys(step.input).length > 0) lines.push(`  Input: ${JSON.stringify(step.input)}`);
    if (step.inputMapping && Object.keys(step.inputMapping).length > 0) {
      lines.push(`  InputMapping: ${JSON.stringify(step.inputMapping)}`);
    }
    if (step.assertions && step.assertions.length > 0) {
      lines.push(`  Assertions: ${JSON.stringify(step.assertions)}`);
    }
  }

  // Execution results
  if (stepResults && stepResults.length > 0) {
    lines.push('\n## Execution Results:');
    for (const sr of stepResults) {
      const step = previousSteps.find(s => s.id === sr.stepId);
      const icon = sr.status === 'completed' ? '✅' : sr.status === 'failed' ? '❌' : sr.status === 'assert_failed' ? '⚠️' : '⏭';
      lines.push(`\n### ${sr.stepId} ${icon} ${sr.status} (${sr.duration_ms}ms)`);
      if (step) lines.push(`  Step: "${step.label}" [${step.type}]`);
      if (sr.output) {
        const outputStr = typeof sr.output === 'string' ? sr.output : JSON.stringify(sr.output, null, 2);
        lines.push(`  Output:\n\`\`\`json\n${outputStr.slice(0, 5000)}\n\`\`\``);
      }
      if (sr.error) lines.push(`  Error:\n\`\`\`\n${sr.error}\n\`\`\``);
    }
  }

  // Broken mappings (generator steps)
  if (brokenMappings && brokenMappings.length > 0) {
    lines.push('\n## ⚠ BROKEN inputMapping paths:');
    for (const b of brokenMappings) {
      lines.push(`- **${b.stepId}.${b.field}**: expression \`${b.expression}\``);
      lines.push(`  Path tried: \`${b.path}\``);
      if (b.availablePaths.length > 0) {
        lines.push(`  Available paths: \`${b.availablePaths.join('`, `')}\``);
      }
    }
  }

  if (agentMemory) {
    lines.push('');
    lines.push('## Agent Memory (from creation):');
    lines.push(agentMemory);
  }

  lines.push('');
  if (trigger) lines.push(buildTriggerProperties(trigger, triggerName));
  lines.push('');
  lines.push(buildTriggersList(piece));
  lines.push('');
  lines.push(buildActionsList(piece));

  lines.push(...buildUserInstructionBlock(userInstruction));

  lines.push('\n\nFix the trigger plan based on the results above. Keep the correct plan shape and assertions. Call set_test_plan with the corrected steps.');

  return lines.join('\n');
}

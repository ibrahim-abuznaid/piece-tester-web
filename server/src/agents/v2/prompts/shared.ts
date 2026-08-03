import type { PieceMetadataFull, PieceActionMeta, PieceTriggerMeta } from '../../../services/ap-client.js';
import { formatLessonsForPrompt } from '../../../services/lesson-extractor.js';
import { getConnectionByPiece } from '../../../db/queries.js';

const AUTH_PROP_TYPES = ['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH'];
const SKIP_PROP_TYPES = ['MARKDOWN'];

/** Build a context block describing the piece and its connection status. */
export function buildPieceContext(piece: PieceMetadataFull, actionName: string): string {
  const action = piece.actions[actionName];
  const connRow = getConnectionByPiece(piece.name);
  const connected = connRow ? 'Connected' : 'Not connected';
  const connType = connRow?.connection_type || 'unknown';

  const lines = [
    `**Piece:** ${piece.displayName} (${piece.name}) v${piece.version}`,
    `**Action:** ${action?.displayName || actionName} (${actionName})`,
    `**Description:** ${action?.description || 'No description'}`,
    `**Auth:** ${piece.auth?.type || 'None'}`,
    `**Connection:** ${connected} (${connType})`,
  ];

  return lines.join('\n');
}

/** Build a detailed property listing for one action. */
export function buildActionProperties(action: PieceActionMeta, actionName: string): string {
  const lines: string[] = [];
  lines.push(`## Properties for "${action.displayName}" (${actionName}):`);

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

  return lines.join('\n');
}

/** Build a compact action listing (name + display name). */
export function buildActionsList(piece: PieceMetadataFull): string {
  const lines = ['## All actions in this piece:'];
  for (const [n, act] of Object.entries(piece.actions)) {
    lines.push(`  - ${n}: "${act.displayName}"`);
  }
  return lines.join('\n');
}

/** Build a context block describing the piece and the trigger under test. */
export function buildTriggerContext(piece: PieceMetadataFull, triggerName: string): string {
  const trigger = piece.triggers[triggerName];
  const connRow = getConnectionByPiece(piece.name);
  const connected = connRow ? 'Connected' : 'Not connected';
  const connType = connRow?.connection_type || 'unknown';

  const lines = [
    `**Piece:** ${piece.displayName} (${piece.name}) v${piece.version}`,
    `**Trigger:** ${trigger?.displayName || triggerName} (${triggerName})`,
    `**Strategy:** ${trigger?.type || 'UNKNOWN'}`,
    `**Description:** ${trigger?.description || 'No description'}`,
    `**Auth:** ${piece.auth?.type || 'None'}`,
    `**Connection:** ${connected} (${connType})`,
  ];

  return lines.join('\n');
}

/** Build a detailed property listing for one trigger. */
export function buildTriggerProperties(trigger: PieceTriggerMeta, triggerName: string): string {
  const lines: string[] = [];
  lines.push(`## Properties for "${trigger.displayName}" (${triggerName}):`);

  const props = trigger.props || {};
  if (Object.keys(props).length === 0) {
    lines.push('  (no input properties)');
    return lines.join('\n');
  }

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
  }

  return lines.join('\n');
}

/** Build a compact trigger listing (name + display name + strategy). */
export function buildTriggersList(piece: PieceMetadataFull): string {
  const lines = ['## All triggers in this piece:'];
  const triggers = piece.triggers || {};
  if (Object.keys(triggers).length === 0) {
    lines.push('  (none)');
    return lines.join('\n');
  }
  for (const [n, trig] of Object.entries(triggers)) {
    lines.push(`  - ${n}: "${trig.displayName}" [${trig.type || 'UNKNOWN'}]`);
  }
  return lines.join('\n');
}

/** Inject learned lessons for a piece (if any). */
export function buildLessonsBlock(pieceName: string): string {
  return formatLessonsForPrompt(pieceName) || '';
}

/** Build the previous agent memory section (if any). */
export function buildMemoryBlock(previousMemory?: string): string {
  if (!previousMemory) return '';
  return [
    '',
    '## Previous Agent Memory:',
    previousMemory,
    '',
    'Use this to skip redundant research.',
  ].join('\n');
}

/** Shared documentation for runtime tokens. */
export const RUNTIME_TOKENS_DOC = `## Runtime Tokens -- Unique Values Per Run
The executor replaces these tokens inside ANY string value in step inputs at execution time:
- \`{{$uuid}}\` → a fresh UUID v4 each run
- \`{{$timestamp}}\` → current Unix timestamp in milliseconds
- \`{{$isodate}}\` → current ISO date-time

Use these for any field that must be unique per run (names, subjects, titles, keys):
\`{ "name": "[AI Test] {{$uuid}}", "subject": "Test email {{$timestamp}}" }\`

⚠ NEVER use JavaScript expressions like \`\${new Date().getTime()}\` -- they are stored as literal strings and NEVER evaluated.`;

/** Shared documentation for inputMapping. */
export const INPUT_MAPPING_DOC = `## inputMapping -- Piping Outputs Between Steps
Use \${steps.<stepId>.output.<path>} in inputMapping to reference previous step outputs at runtime.

CRITICAL -- THIS IS THE ONLY VALID SYNTAX: \${steps.<stepId>.output.<path>}
- Correct: \${steps.step_1.output.data.id}
- Correct: \${steps.step_1.output.ts}
- WRONG (Activepieces flow syntax, NOT used here): {{step_1.output.id}}
- WRONG (missing "steps." prefix): \${step_1.output.id}
- WRONG (JavaScript template literal, not evaluated): \`\${...}\`

NEVER flag \${steps.xxx} as "wrong syntax" -- it IS the correct format for this system's plan executor.

Example for "Add reaction to message":
- Step 1 (setup): send_message with input: { "channel": "C12345", "text": "[AI Test] {{$uuid}}" }
- Step 2 (test): add_reaction with:
  - input: { "reaction": "thumbsup" }
  - inputMapping: { "messageTimestamp": "\${steps.step_1.output.ts}", "channel": "\${steps.step_1.output.channel}" }

The executor resolves inputMapping at runtime, so step 2 always gets the FRESH value from step 1.

NESTED FIELDS — use a dotted key to target a field INSIDE an object value:
- To set { "variables": { "id": <ref> } }, map the key "variables.id", NOT "variables".
- Example (GraphQL): input { "query": "mutation($id: String!){ issueDelete(id:$id){ success } }", "variables": {} }
  inputMapping { "variables.id": "\${steps.step_1.output.issue.id}" }
- Mapping the whole object key (e.g. "variables") to a single scalar id is WRONG — it sets variables to a string and the inner field stays missing.`;

/** Rule against custom HTTP actions. */
export const NO_CUSTOM_HTTP_RULE = `## CRITICAL: Never Use Custom HTTP/API Calls in Plans
ABSOLUTELY NEVER create steps that use custom_api_call, http_request, send_http_request, custom_action, or ANY action that sends a raw/custom HTTP request.
These ALWAYS fail because auth tokens are managed internally by each piece.
ONLY use the piece's own named/typed actions.`;

/** Rule that the single test step must exercise the exact target action. */
export const TARGET_ACTION_RULE = `## CRITICAL: The test step MUST use the EXACT target action
The single \`test\` step MUST invoke the target action under test (the action named in the spec/context). NEVER substitute a different action — not a generic query/SOQL action (e.g. run_query), not a "search"/"advanced" variant, not custom_api_call — to make the test pass or to route around a bug in the target action.
- The entire purpose is to test THAT action. Testing a different one is a FALSE PASS that hides real bugs.
- If the target action is broken (throws, sends a malformed request, returns the wrong shape), the test SHOULD fail and surface the real error. A failing test on a genuinely broken action is a CORRECT and valuable outcome — do NOT engineer around it.
- Setup/verify/cleanup steps MAY use other actions; only the \`test\` step is pinned to the target action.

## Dynamic dropdowns are plain values — FILL them, don't avoid them
A DROPDOWN / MULTI_SELECT_DROPDOWN value at execution time is just a plain scalar: the underlying API id/name (e.g. object="Contact", field="Email"). The executor passes it straight through — you do NOT need the live dropdown UI to run the action. Fill dynamic dropdowns with a concrete valid value taken from the source code or ap_get_piece_props. For cascading dropdowns (a prop whose refreshers depend on another prop, e.g. field depends on object), choose the parent value first, then a valid child value for it. Never swap to a different action just because the target action has dynamic dropdowns.`;

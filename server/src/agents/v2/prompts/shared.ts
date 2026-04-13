import type { PieceMetadataFull, PieceActionMeta } from '../../../services/ap-client.js';
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

Example for "Add reaction to message":
- Step 1 (setup): send_message with input: { "channel": "C12345", "text": "[AI Test] {{$uuid}}" }
- Step 2 (test): add_reaction with:
  - input: { "reaction": "thumbsup" }
  - inputMapping: { "messageTimestamp": "\${steps.step_1.output.ts}", "channel": "\${steps.step_1.output.channel}" }

The executor resolves inputMapping at runtime, so step 2 always gets the FRESH value from step 1.`;

/** Rule against custom HTTP actions. */
export const NO_CUSTOM_HTTP_RULE = `## CRITICAL: Never Use Custom HTTP/API Calls in Plans
ABSOLUTELY NEVER create steps that use custom_api_call, http_request, send_http_request, custom_action, or ANY action that sends a raw/custom HTTP request.
These ALWAYS fail because auth tokens are managed internally by each piece.
ONLY use the piece's own named/typed actions.`;

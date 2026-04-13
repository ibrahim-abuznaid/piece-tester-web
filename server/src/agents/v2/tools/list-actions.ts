import type { ToolDefinition } from '../types.js';

const AUTH_PROP_TYPES = ['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH'];
const SKIP_PROP_TYPES = ['MARKDOWN'];

export const listActionsTool: ToolDefinition = {
  name: 'list_actions',
  description: 'List all available actions in the piece with their full property details. Useful for understanding what setup/verify/cleanup actions are available.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verbose: { type: 'boolean', description: 'If true, include full property details for each action. If false, just names and descriptions.' },
    },
    required: [],
  },
  async handler(input, ctx) {
    const lines: string[] = [];
    const verbose = input.verbose ?? false;

    for (const [name, action] of Object.entries(ctx.pieceMeta.actions)) {
      lines.push(`\n## ${name}: "${action.displayName}"`);
      if (action.description) lines.push(`  ${action.description}`);

      if (verbose && action.props) {
        for (const [propName, propDef] of Object.entries(action.props)) {
          const prop = propDef as any;
          const propType = prop.type ?? 'UNKNOWN';
          if (AUTH_PROP_TYPES.includes(propType) || SKIP_PROP_TYPES.includes(propType)) continue;
          const req = prop.required ? ' [REQUIRED]' : ' [optional]';
          const def = prop.defaultValue !== undefined ? ` (default: ${JSON.stringify(prop.defaultValue)})` : '';
          lines.push(`  - ${propName}: ${propType}${req}${def}`);
          if (prop.description) lines.push(`    ${prop.description}`);
          if (propType === 'STATIC_DROPDOWN' && prop.options?.options) {
            const opts = prop.options.options.slice(0, 10).map((o: any) => `"${o.label}"=${JSON.stringify(o.value)}`).join(', ');
            lines.push(`    Options: ${opts}`);
          }
          if (propType === 'DROPDOWN' || propType === 'MULTI_SELECT_DROPDOWN') {
            lines.push(`    ⚠ DYNAMIC DROPDOWN`);
          }
        }
      }
    }

    return lines.join('\n');
  },
};

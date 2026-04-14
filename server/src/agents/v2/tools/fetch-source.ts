import axios from 'axios';
import type { ToolDefinition, ToolContext } from '../types.js';

export async function fetchPieceSourceFromGitHub(pieceName: string): Promise<string | null> {
  const shortName = pieceName.replace('@activepieces/piece-', '');
  const baseUrl = `https://raw.githubusercontent.com/activepieces/activepieces/main/packages/pieces/community/${shortName}`;
  const files: { path: string; content: string }[] = [];

  for (const indexPath of ['src/index.ts', 'src/index.js']) {
    try {
      const resp = await axios.get(`${baseUrl}/${indexPath}`, { timeout: 8000 });
      if (resp.status === 200) { files.push({ path: indexPath, content: resp.data }); break; }
    } catch { /* not found */ }
  }

  try {
    const apiResp = await axios.get(
      `https://api.github.com/repos/activepieces/activepieces/contents/packages/pieces/community/${shortName}/src/lib/actions`,
      { timeout: 10000, headers: { Accept: 'application/vnd.github.v3+json' } },
    );
    if (Array.isArray(apiResp.data)) {
      const actionFiles = apiResp.data.filter((f: any) => f.name.endsWith('.ts') || f.name.endsWith('.js')).slice(0, 15);
      for (const file of actionFiles) {
        try {
          const fileResp = await axios.get(file.download_url, { timeout: 10000 });
          if (fileResp.status === 200) files.push({ path: `src/lib/actions/${file.name}`, content: fileResp.data });
        } catch { /* skip */ }
      }
    }
  } catch { /* no action files directory */ }

  for (const helperPath of ['src/lib/common/props.ts', 'src/lib/common/index.ts', 'src/lib/common.ts', 'src/lib/common/common.ts']) {
    try {
      const resp = await axios.get(`${baseUrl}/${helperPath}`, { timeout: 5000 });
      if (resp.status === 200) files.push({ path: helperPath, content: resp.data });
    } catch { /* not found */ }
  }

  if (files.length === 0) return null;
  return files.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');
}

export async function fetchActionSourceFromGitHub(pieceName: string, actionName: string): Promise<string | null> {
  const shortName = pieceName.replace('@activepieces/piece-', '');
  const baseUrl = `https://raw.githubusercontent.com/activepieces/activepieces/main/packages/pieces/community/${shortName}`;
  const dashName = actionName.replace(/_/g, '-');
  const underName = actionName.replace(/-/g, '_');
  const patterns = [
    `src/lib/actions/${dashName}.ts`, `src/lib/actions/${underName}.ts`,
    `src/lib/actions/${dashName}-action.ts`, `src/lib/actions/${underName}-action.ts`,
    `src/lib/actions/${dashName}.action.ts`, `src/lib/actions/${underName}.action.ts`,
    `src/lib/actions/${dashName}/index.ts`, `src/lib/actions/${underName}/index.ts`,
    `src/lib/actions/${dashName}-action/index.ts`, `src/lib/actions/${underName}_action/index.ts`,
  ];
  for (const pattern of patterns) {
    try {
      const resp = await axios.get(`${baseUrl}/${pattern}`, { timeout: 8000 });
      if (resp.status === 200) return resp.data;
    } catch { /* try next */ }
  }
  return null;
}

export const fetchPieceSourceTool: ToolDefinition = {
  name: 'fetch_piece_source',
  description: 'Fetch all source code files of this piece from the Activepieces GitHub repo.',
  input_schema: {
    type: 'object' as const,
    properties: { reason: { type: 'string', description: 'Why you need the source code' } },
    required: ['reason'],
  },
  async handler(input, ctx) {
    const source = await fetchPieceSourceFromGitHub(ctx.pieceMeta.name);
    if (!source) return 'Not found on GitHub.';
    return `Source code (${source.length} chars):\n\n${source.slice(0, 50000)}`;
  },
};

export const fetchActionSourceTool: ToolDefinition = {
  name: 'fetch_action_source',
  description: 'Fetch the source code for a specific action file from GitHub.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action_name: { type: 'string', description: 'The action name key' },
      reason: { type: 'string', description: 'Why you need this action source' },
    },
    required: ['action_name', 'reason'],
  },
  async handler(input, ctx) {
    const source = await fetchActionSourceFromGitHub(ctx.pieceMeta.name, input.action_name);
    if (!source) return `Not found for "${input.action_name}". Use fetch_piece_source for all files.`;
    return `Action source:\n\n${source.slice(0, 15000)}`;
  },
};

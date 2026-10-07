import type { ToolDefinition } from '../types.js';
import type { ProbeResult } from '../../../services/vendor-watch/types.js';
import { safeFetch, SafeFetchError, type SafeFetchOptions } from '../../../services/vendor-watch/safe-fetch.js';
import { htmlBlocks, parseFeed } from '../../../services/vendor-watch/normalize.js';
import { isOpenApiDoc, parseSpec } from '../../../services/vendor-watch/openapi.js';

/** Below this much text a page is a JavaScript shell or a stub, not a changelog. */
export const MIN_HTML_CHARS = 500;

export function detectKind(body: string, contentType: string): { kind: ProbeResult['detected_kind']; text: string } {
  const head = body.slice(0, 2000).toLowerCase();
  if (head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:rdf')) {
    try {
      const entries = parseFeed(body);
      if (entries.length > 0) return { kind: 'feed', text: entries.map(e => `${e.title} — ${e.text}`).join('\n') };
    } catch {
      /* not a feed after all */
    }
  }
  if (!head.trimStart().startsWith('<')) {
    try {
      const doc = parseSpec(body);
      if (isOpenApiDoc(doc)) return { kind: 'openapi', text: Object.keys(doc.paths).slice(0, 40).join('\n') };
    } catch {
      /* not a spec */
    }
  }
  if (contentType.toLowerCase().includes('html') || head.includes('<html') || head.includes('<!doctype html')) {
    const text = htmlBlocks(body).map(b => b.text).join('\n');
    if (text.length >= MIN_HTML_CHARS) return { kind: 'html', text };
  }
  return { kind: 'unreadable', text: '' };
}

/** Fetch a candidate source exactly as a watch run will, and say whether it is usable. Never throws. */
export async function probeSource(url: string, opts: SafeFetchOptions = {}): Promise<ProbeResult> {
  try {
    const r = await safeFetch(url, opts);
    const { kind, text } = detectKind(r.body, r.contentType);
    const problem = r.status >= 400
      ? `HTTP ${r.status}`
      : kind === 'unreadable' ? 'No feed, OpenAPI document or readable HTML text (JavaScript-only page?)' : '';
    return {
      url, ok: !problem, status: r.status, final_url: r.finalUrl, content_type: r.contentType,
      detected_kind: kind, text_chars: text.length, sample: text.slice(0, 1500), problem,
    };
  } catch (err) {
    return {
      url, ok: false, status: null, final_url: url, content_type: '', detected_kind: 'unreadable', text_chars: 0, sample: '',
      problem: err instanceof SafeFetchError ? `${err.code}: ${err.message}` : String((err as Error)?.message || err),
    };
  }
}

export const probeSourceTool: ToolDefinition = {
  name: 'probe_source',
  description: 'Fetch a candidate vendor source URL the way the watcher will, and report whether it is readable and what kind it is (feed, openapi, html, unreadable). Every source in set_watch_plan must be probed first and come back ok.',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL' },
      expected_kind: { type: 'string', enum: ['feed', 'openapi', 'html'], description: 'What you expect it to be' },
    },
    required: ['url'],
  },
  async handler(input, ctx) {
    const result = await probeSource(typeof input?.url === 'string' ? input.url.trim() : '');
    if (!ctx.probedSources) ctx.probedSources = new Map();
    ctx.probedSources.set(result.url, result);
    if (result.final_url !== result.url) ctx.probedSources.set(result.final_url, result);
    return JSON.stringify(result);
  },
};

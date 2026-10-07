import type { ToolContext, ToolDefinition } from '../types.js';
import type { EndpointRef } from '../../../services/vendor-watch/types.js';

export interface WatchPlanDraft {
  vendor_name: string;
  api_base_urls: string[];
  api_version: string;
  auth_type: string;
  endpoint_inventory: EndpointRef[];
  /** kind is checked by validateWatchPlan: feed | openapi | html. */
  sources: { kind: string; url: string; label: string }[];
  note: string;
  /** Shape problems parseWatchPlanInput found in the model's input. validateWatchPlan reports them as errors. */
  input_errors?: string[];
}

export interface WatchPlanValidation {
  errors: string[];
  warnings: string[];
  plan: WatchPlanDraft;
}

export const MAX_SOURCES = 8;
const SOURCE_KINDS = new Set(['feed', 'openapi', 'html']);

function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const kindOf = (v: unknown): string => (v == null ? 'nothing' : Array.isArray(v) ? 'array' : typeof v);
/** Strings and numbers as trimmed text; anything else is ''. Never calls a model-supplied toString. */
const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/** Read the model's set_watch_plan input. Never throws: wrong shapes land in input_errors and the entry is skipped. */
export function parseWatchPlanInput(input: Record<string, any>): WatchPlanDraft {
  const raw: Record<string, unknown> = isRecord(input) ? input : {};
  const input_errors: string[] = [];
  const list = (field: string): unknown[] => {
    const v = raw[field];
    if (Array.isArray(v)) return v;
    input_errors.push(`${field}: expected an array, got ${kindOf(v)}.`);
    return [];
  };
  const records = (field: string, shape: string, stringFields: string[]): Record<string, unknown>[] =>
    list(field).flatMap((e, i) => {
      if (!isRecord(e)) {
        input_errors.push(`${field}[${i}]: expected an object with ${shape}, got ${kindOf(e)}.`);
        return [];
      }
      const bad = stringFields.filter(f => typeof e[f] !== 'string');
      for (const f of bad) input_errors.push(`${field}[${i}]: ${f} must be a string, got ${kindOf(e[f])}.`);
      return bad.length ? [] : [e];
    });

  return {
    vendor_name: text(raw.vendor_name),
    api_base_urls: list('api_base_urls').flatMap((u, i) => {
      if (typeof u === 'string') return u.trim() ? [u.trim()] : [];
      input_errors.push(`api_base_urls[${i}]: expected a URL string, got ${kindOf(u)}.`);
      return [];
    }),
    api_version: text(raw.api_version),
    auth_type: text(raw.auth_type),
    endpoint_inventory: records('endpoint_inventory', 'target, target_kind, method and path', ['target', 'method']).map(e => ({
      target: text(e.target),
      target_kind: e.target_kind === 'trigger' ? 'trigger' as const : 'action' as const,
      method: text(e.method).toUpperCase(),
      path: text(e.path),
      ...(text(e.note) ? { note: text(e.note) } : {}),
    })),
    sources: records('sources', 'kind, url and label', ['kind', 'url'])
      .map(s => ({ kind: text(s.kind), url: text(s.url), label: text(s.label) })),
    note: text(raw.note),
    input_errors,
  };
}

/** The rules set_watch_plan enforces (spec §2). Unknown inventory targets are dropped with a warning, not an error. */
export function validateWatchPlan(draft: WatchPlanDraft, ctx: Pick<ToolContext, 'pieceMeta' | 'probedSources'>): WatchPlanValidation {
  const { input_errors = [], ...plan } = draft;
  const errors: string[] = [...input_errors];
  const warnings: string[] = [];
  if (plan.api_base_urls.length === 0) errors.push('api_base_urls: add at least one URL (the liveness check uses the first).');
  for (const u of plan.api_base_urls) if (!isHttpUrl(u)) errors.push(`api_base_urls: "${u}" is not an http(s) URL.`);
  if (plan.sources.length === 0) errors.push('sources: add at least one feed, openapi or html source.');
  if (plan.sources.length > MAX_SOURCES) errors.push(`sources: at most ${MAX_SOURCES}, got ${plan.sources.length}.`);
  const seen = new Set<string>();
  for (const s of plan.sources) {
    if (seen.has(s.url)) {
      errors.push(`sources: "${s.url}" is listed twice.`);
      continue;
    }
    seen.add(s.url);
    if (s.url === plan.api_base_urls[0]) {
      errors.push(`sources: "${s.url}" is the API base URL the liveness check already watches; pick a changelog, feed or spec URL.`);
      continue;
    }
    if (!SOURCE_KINDS.has(s.kind)) {
      errors.push(`sources: "${s.url}" has kind "${s.kind}"; use feed, openapi or html (liveness is added for you).`);
      continue;
    }
    const p = ctx.probedSources?.get(s.url);
    if (!p) errors.push(`sources: "${s.url}" was never probed. Call probe_source on it first.`);
    else if (!p.ok) errors.push(`sources: "${s.url}" is unreadable (${p.problem}). Drop it or find another URL.`);
    else if (p.detected_kind !== s.kind) errors.push(`sources: "${s.url}" probed as "${p.detected_kind}", not "${s.kind}".`);
  }
  const actions = new Set(Object.keys(ctx.pieceMeta.actions ?? {}));
  const triggers = new Set(Object.keys(ctx.pieceMeta.triggers ?? {}));
  const kept: EndpointRef[] = [];
  for (const e of plan.endpoint_inventory) {
    const known = e.target_kind === 'trigger' ? triggers.has(e.target) : actions.has(e.target);
    if (known) kept.push(e);
    else warnings.push(`endpoint_inventory: dropped "${e.target}" — not ${e.target_kind === 'trigger' ? 'a trigger' : 'an action'} of this piece.`);
  }
  return { errors, warnings, plan: { ...plan, endpoint_inventory: kept } };
}

export const setWatchPlanTool: ToolDefinition = {
  name: 'set_watch_plan',
  description: 'Save the watch plan. Call it once, at the end, after every source has been probed ok. If it is rejected, fix the listed problems and call it again.',
  input_schema: {
    type: 'object' as const,
    properties: {
      vendor_name: { type: 'string' },
      api_base_urls: { type: 'array', items: { type: 'string' }, description: 'API base URL(s) the piece calls, e.g. ["https://api.stripe.com/v1"]. The first is used for the liveness check.' },
      api_version: { type: 'string', description: 'API version the piece targets, e.g. "v3" or "2024-06-20". Empty if none.' },
      auth_type: { type: 'string', description: 'e.g. "OAuth2", "API key (header)", "Basic"' },
      endpoint_inventory: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Action or trigger name exactly as in the piece, e.g. "send_message"' },
            target_kind: { type: 'string', enum: ['action', 'trigger'] },
            method: { type: 'string', description: 'HTTP method, or "SDK" for vendor SDK calls' },
            path: { type: 'string', description: 'Path with {} for parameters, e.g. "/v1/customers/{}"; for SDK calls "sdk:<package>#<method>"' },
            note: { type: 'string' },
          },
          required: ['target', 'target_kind', 'method', 'path'],
        },
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['feed', 'openapi', 'html'] },
            url: { type: 'string' },
            label: { type: 'string', description: 'Short name, e.g. "Stripe API changelog (RSS)"' },
          },
          required: ['kind', 'url', 'label'],
        },
      },
      note: { type: 'string', description: 'One or two plain sentences for the team: what you found and what is missing.' },
    },
    required: ['vendor_name', 'api_base_urls', 'endpoint_inventory', 'sources', 'note'],
  },
  validateTerminal(input, ctx) {
    const v = validateWatchPlan(parseWatchPlanInput(input), ctx);
    return v.errors.length ? v.errors.join('\n') : null;
  },
  async handler() {
    return 'Watch plan saved.';
  },
};

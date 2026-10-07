import { parse as parseYaml } from 'yaml';
import { sha1, type Normalized } from './normalize.js';

export interface OpParam {
  name: string;
  in: string;
  required: boolean;
}

export interface OpInfo {
  deprecated: boolean;
  params: OpParam[];
}

/** Key: "METHOD /normalized/{}/path". */
export type OpMap = Record<string, OpInfo>;

export interface OpenApiDiff {
  removed: string[];
  newlyDeprecated: string[];
  newRequiredParams: { op: string; param: string }[];
  added: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;
type AnyObj = Record<string, any>;

export function parseSpec(body: string): unknown {
  const t = body.trim();
  return t.startsWith('{') ? JSON.parse(t) : parseYaml(t);
}

export function isOpenApiDoc(doc: unknown): doc is { paths: Record<string, unknown> } {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const d = doc as AnyObj;
  return ('openapi' in d || 'swagger' in d) && !!d.paths && typeof d.paths === 'object';
}

/** Drop host and query, turn every path parameter style ({x}, ${x}, :x) into {}, drop trailing slashes. */
export function normalizePath(path: string): string {
  let p = path.trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      p = decodeURI(new URL(p).pathname);
    } catch {
      /* keep the raw string */
    }
  }
  p = p.split('?')[0].replace(/\$\{[^}]*\}|\{[^}]*\}|(?<=\/):[A-Za-z_]\w*(?=\/|$)/g, '{}');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

export function opKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function resolveRef(doc: AnyObj, v: any): any {
  if (!v || typeof v !== 'object' || typeof v.$ref !== 'string' || !v.$ref.startsWith('#/')) return v;
  const target = v.$ref
    .slice(2)
    .split('/')
    .reduce((o: any, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  return target ?? v;
}

export function buildOpMap(doc: unknown): OpMap {
  const d = (doc ?? {}) as AnyObj;
  const out: OpMap = {};
  for (const [path, rawItem] of Object.entries<any>(d.paths ?? {})) {
    const item = resolveRef(d, rawItem) ?? {};
    const shared: any[] = Array.isArray(item.parameters) ? item.parameters : [];
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== 'object') continue;
      const params = new Map<string, OpParam>();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = resolveRef(d, raw);
        if (!p || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
        params.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: p.required === true || p.in === 'path' });
      }
      if (resolveRef(d, op.requestBody)?.required === true) params.set('body:', { name: '', in: 'body', required: true });
      out[opKey(m, path)] = {
        deprecated: op.deprecated === true,
        params: [...params.values()].sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`)),
      };
    }
  }
  return out;
}

export function normalizeOpenApi(ops: OpMap): Normalized {
  const sorted: OpMap = {};
  for (const k of Object.keys(ops).sort()) sorted[k] = ops[k];
  const content = JSON.stringify(sorted);
  return { hash: sha1(content), content };
}

export function parseOpMap(content: string): OpMap {
  try {
    const v = JSON.parse(content);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Path parameters are skipped for "new required": renaming {id} → {customer_id} is not breaking. */
export function diffOpenApi(prev: OpMap, next: OpMap): OpenApiDiff {
  const has = (m: OpMap, k: string) => Object.prototype.hasOwnProperty.call(m, k);
  const removed = Object.keys(prev).filter(k => !has(next, k)).sort();
  const added = Object.keys(next).filter(k => !has(prev, k)).sort();
  const newlyDeprecated = Object.keys(next).filter(k => has(prev, k) && next[k].deprecated && !prev[k].deprecated).sort();
  const newRequiredParams: { op: string; param: string }[] = [];
  for (const k of Object.keys(next).sort()) {
    if (!has(prev, k)) continue;
    const before = new Set(prev[k].params.filter(p => p.required).map(p => `${p.in}:${p.name}`));
    for (const p of next[k].params) {
      const key = `${p.in}:${p.name}`;
      if (p.required && p.in !== 'path' && !before.has(key)) newRequiredParams.push({ op: k, param: key });
    }
  }
  return { removed, newlyDeprecated, newRequiredParams, added };
}

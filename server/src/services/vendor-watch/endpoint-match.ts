import { normalizePath } from './openapi.js';
import type { EndpointRef } from './types.js';

/** Segment-wise suffix match, so an inventory path without the base path ('/orders') matches '/v1/orders'. */
export function pathsMatch(a: string, b: string): boolean {
  const sa = normalizePath(a).split('/').filter(Boolean);
  const sb = normalizePath(b).split('/').filter(Boolean);
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (short.length === 0 || short.every(s => s === '{}')) return false;
  const tail = long.slice(long.length - short.length);
  return short.every((s, i) => s === tail[i]);
}

/** Inventory targets that call the operation "METHOD /path". SDK entries never match. */
export function targetsUsingOp(inventory: EndpointRef[], op: string): string[] {
  const space = op.indexOf(' ');
  const method = op.slice(0, space);
  const path = op.slice(space + 1);
  return [...new Set(
    inventory.filter(e => e.method.toUpperCase() === method && pathsMatch(e.path, path)).map(e => e.target),
  )];
}

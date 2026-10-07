import { normalizePath, type OpMap } from './openapi.js';
import type { EndpointRef } from './types.js';

const segments = (path: string) => normalizePath(path).split('/').filter(Boolean);

function splitOp(op: string): [method: string, path: string] {
  const space = op.indexOf(' ');
  return [op.slice(0, space), op.slice(space + 1)];
}

/**
 * Segment-wise suffix match in either direction, so an inventory path without the base path ('/orders')
 * matches '/v1/orders'. A candidate test only: `resolveEntry` picks the op an entry actually calls.
 */
export function pathsMatch(a: string, b: string): boolean {
  const sa = segments(a);
  const sb = segments(b);
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (short.length === 0 || short.every(s => s === '{}')) return false;
  const tail = long.slice(long.length - short.length);
  return short.every((s, i) => s === tail[i]);
}

function closest(entry: EndpointRef, ops: OpMap): { keys: string[]; distance: number } {
  const method = entry.method.toUpperCase();
  const path = normalizePath(entry.path);
  const want = segments(path).length;
  const scored = Object.keys(ops).flatMap(k => {
    const [m, p] = splitOp(k);
    return m === method && pathsMatch(path, p) ? [{ k, d: Math.abs(segments(p).length - want) }] : [];
  });
  const distance = Math.min(...scored.map(s => s.d));
  return { keys: scored.filter(s => s.d === distance).map(s => s.k), distance };
}

/**
 * The op(s) in `ops` an inventory entry calls: among same-method ops whose path matches, the ones whose
 * segment count is closest to the entry's, all of them on a tie. A match with the same segment count is
 * the exact normalized path, so an exact match always wins outright. SDK entries never match.
 */
export function resolveEntry(entry: EndpointRef, ops: OpMap): string[] {
  return closest(entry, ops).keys;
}

/** Segment-count distance between an entry and the op(s) `resolveEntry` picks; Infinity when nothing matches. */
export function matchDistance(entry: EndpointRef, ops: OpMap): number {
  return closest(entry, ops).distance;
}

/** Inventory targets with an entry that resolves to `op` within `ops` (see `resolveEntry`). */
export function targetsUsingOp(inventory: EndpointRef[], op: string, ops: OpMap): string[] {
  const [method, path] = splitOp(op);
  return [...new Set(inventory
    .filter(e => e.method.toUpperCase() === method && pathsMatch(e.path, path) && resolveEntry(e, ops).includes(op))
    .map(e => e.target))];
}

import { ActivepiecesClient } from './ap-client.js';
import { createClient } from './test-engine.js';

const TEST_FLOW_PREFIXES = ['[Test]', '[AI Agent]', '[Diagnostic]'];
const DEFAULT_REAP_AGE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

function flowDisplayName(flow: Record<string, any>): string {
  return flow.version?.displayName ?? flow.displayName ?? '';
}

function flowCreatedMs(flow: Record<string, any>): number {
  const raw = flow.created ?? flow.createdAt ?? flow.version?.created;
  return raw ? Date.parse(raw) : NaN;
}

export async function reapOrphanedTestFlows(opts?: { ageMs?: number }): Promise<{ scanned: number; matched: number; deleted: number }> {
  const ageMs = opts?.ageMs ?? DEFAULT_REAP_AGE_MS;
  let client: ActivepiecesClient;
  try {
    client = createClient();
  } catch {
    return { scanned: 0, matched: 0, deleted: 0 };
  }

  const now = Date.now();
  let scanned = 0;
  let matched = 0;
  let deleted = 0;
  let skippedUnknownAge = 0;
  let cursor: string | undefined;

  do {
    let page;
    try {
      page = await client.listFlows(100, cursor);
    } catch (err) {
      console.error(`[flow-reaper] Failed to list flows: ${ActivepiecesClient.formatError(err)}`);
      break;
    }

    for (const flow of page.data as Record<string, any>[]) {
      scanned++;
      const name = flowDisplayName(flow);
      if (!TEST_FLOW_PREFIXES.some(p => name.startsWith(p))) continue;
      matched++;

      const createdMs = flowCreatedMs(flow);
      if (!Number.isFinite(createdMs)) {
        skippedUnknownAge++;
        continue;
      }
      if (now - createdMs < ageMs) continue;

      await client.deleteFlowSafely(flow.id, 3, `reaper:${name.slice(0, 40)}`);
      deleted++;
    }

    cursor = page.next ?? undefined;
  } while (cursor);

  if (deleted > 0 || skippedUnknownAge > 0) {
    console.log(`[flow-reaper] Swept ${scanned} flow(s): ${matched} test-flow(s), reaped ${deleted}${skippedUnknownAge ? `, skipped ${skippedUnknownAge} with unknown age` : ''}.`);
  }
  return { scanned, matched, deleted };
}

export function initFlowReaper(): NodeJS.Timeout {
  reapOrphanedTestFlows().catch(err => console.error(`[flow-reaper] startup sweep failed: ${err?.message ?? err}`));
  const timer = setInterval(() => {
    reapOrphanedTestFlows().catch(err => console.error(`[flow-reaper] periodic sweep failed: ${err?.message ?? err}`));
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

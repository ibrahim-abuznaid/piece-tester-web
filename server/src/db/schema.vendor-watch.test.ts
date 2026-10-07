import { describe, it, expect, vi } from 'vitest';
import { getDb } from './schema.js';
import type { DatabaseAdapter } from './adapter.js';

const VENDOR_WATCH_INDEXES: Record<string, [table: string, column: string]> = {
  idx_watch_sources_plan: ['watch_sources', 'plan_id'],
  idx_watch_runs_plan: ['watch_runs', 'plan_id'],
  idx_vendor_findings_plan: ['vendor_findings', 'plan_id'],
  idx_vendor_findings_status: ['vendor_findings', 'status'],
  idx_vendor_findings_signature: ['vendor_findings', 'signature'],
  idx_vendor_findings_source: ['vendor_findings', 'source_id'],
  idx_vendor_findings_run: ['vendor_findings', 'run_id'],
};

const schemaOf = (db: DatabaseAdapter) =>
  db.all<{ type: string; name: string; sql: string | null }>(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`);

describe('vendor watch indexes', () => {
  it('exist after init, each on its one column', () => {
    const db = getDb();
    for (const [name, [table, column]] of Object.entries(VENDOR_WATCH_INDEXES)) {
      const row = db.get<{ tbl_name: string }>(`SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?`, [name]);
      expect(row?.tbl_name, name).toBe(table);
      expect((db.pragma(`index_info(${name})`) as { name: string }[]).map(c => c.name), name).toEqual([column]);
    }
  });

  it('a second init on the same database changes nothing', async () => {
    const before = schemaOf(getDb());
    vi.resetModules();
    const again = (await import('./schema.js')).getDb();
    try {
      expect(schemaOf(again)).toEqual(before);
    } finally {
      again.close();
    }
  });
});

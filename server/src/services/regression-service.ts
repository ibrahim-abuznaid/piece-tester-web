import { getDb } from '../db/schema.js';
import { getReportOverviewStats } from '../db/queries.js';
import {
  classifyPiece,
  categorizeError,
  type Lane,
  type RunLite,
  type FailureCategory,
} from './regression-classifier.js';

// One row per piece for the analytics charts (piece health, most-failures,
// slowest, reliability). Kept lean — only what the charts consume.
export interface RegressionRow {
  piece_name: string;
  lane: Lane;
  failed: number;
  overallRate: number;
  p95Ms: number;
}

interface RunRow {
  piece_name: string;
  status: string;
  started_at: string;
  dur_ms: number | null;
  plan_updated_at: string | null;
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  return Math.round(sortedAsc[Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))]);
}

function firstFailedError(stepResultsJson: string): string | null {
  try {
    const steps = JSON.parse(stepResultsJson);
    if (Array.isArray(steps)) {
      const failed = steps.find((s: any) => s.status === 'failed' && s.error);
      if (failed) return String(failed.error);
      const anyErr = steps.find((s: any) => s.error);
      if (anyErr) return String(anyErr.error);
    }
  } catch {
    /* ignore malformed step_results */
  }
  return null;
}

const LANE_ORDER: Record<Lane, number> = {
  newly_broken: 0,
  degrading: 1,
  flaky: 2,
  recovered: 3,
  still_broken: 4,
  stable: 5,
  stale: 6,
};

export function getPieceRegressions(dateFrom?: string, dateTo?: string): RegressionRow[] {
  const db = getDb();
  const conds = ["r.trigger_type = 'scheduled'"];
  const params: unknown[] = [];
  if (dateFrom) { conds.push('r.started_at >= ?'); params.push(dateFrom); }
  if (dateTo) { conds.push('r.started_at <= ?'); params.push(dateTo); }
  const rows = db.all<RunRow>(`
    SELECT p.piece_name AS piece_name, r.status AS status, r.started_at AS started_at,
           CASE WHEN r.completed_at IS NOT NULL
             THEN (julianday(r.completed_at) - julianday(r.started_at)) * 86400000
             ELSE NULL END AS dur_ms,
           p.updated_at AS plan_updated_at
    FROM test_plan_runs r JOIN test_plans p ON r.plan_id = p.id
    WHERE ${conds.join(' AND ')}
    ORDER BY r.started_at ASC
  `, params);

  const now = new Date().toISOString();
  const byPiece = new Map<string, RunRow[]>();
  for (const row of rows) {
    const arr = byPiece.get(row.piece_name) ?? [];
    arr.push(row);
    byPiece.set(row.piece_name, arr);
  }

  const out: RegressionRow[] = [];
  for (const [piece, pieceRows] of byPiece) {
    const runs: RunLite[] = pieceRows.map(r => ({ status: r.status, started_at: r.started_at }));
    const planUpdatedAt = pieceRows.reduce<string | null>(
      (mx, r) => (r.plan_updated_at && (!mx || r.plan_updated_at > mx) ? r.plan_updated_at : mx),
      null,
    );
    const { lane } = classifyPiece(runs, { now, planUpdatedAt });

    const passed = pieceRows.filter(r => r.status === 'completed').length;
    const failed = pieceRows.filter(r => r.status === 'failed').length;
    // Reliability excludes blocked (skipped, not a failure).
    const overallRate = passed + failed > 0 ? Math.round((passed / (passed + failed)) * 100) : 0;
    // Durations come from SQLite julianday (handles both naive started_at and ISO-Z
    // completed_at); a JS Date diff would mis-parse them by the local TZ offset.
    const durs = pieceRows
      .filter(r => (r.status === 'completed' || r.status === 'failed') && r.dur_ms != null)
      .map(r => r.dur_ms as number)
      .filter(ms => ms >= 0)
      .sort((a, b) => a - b);

    out.push({ piece_name: piece, lane, failed, overallRate, p95Ms: percentile(durs, 95) });
  }

  out.sort((a, b) => LANE_ORDER[a.lane] - LANE_ORDER[b.lane] || a.overallRate - b.overallRate);
  return out;
}

// Failure breakdown for the "why tests fail" chart: bucket every scheduled failure
// by category (auth / timeout / no_trigger / …), most common first.
export function getFailureBreakdown(dateFrom?: string, dateTo?: string): { category: FailureCategory; count: number }[] {
  const db = getDb();
  const conds = ["r.trigger_type = 'scheduled'", "r.status = 'failed'"];
  const params: unknown[] = [];
  if (dateFrom) { conds.push('r.started_at >= ?'); params.push(dateFrom); }
  if (dateTo) { conds.push('r.started_at <= ?'); params.push(dateTo); }
  const rows = db.all<{ step_results: string }>(
    `SELECT r.step_results AS step_results FROM test_plan_runs r WHERE ${conds.join(' AND ')}`,
    params,
  );
  const counts = new Map<FailureCategory, number>();
  for (const r of rows) {
    const cat = categorizeError(firstFailedError(r.step_results) || 'Unknown error');
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

export interface PerformanceSummary {
  success_rate: number;
  prev_success_rate: number | null;
  delta_pts: number | null;
  blocked: number;
  tested_pieces: number;
  p50_ms: number;
  p95_ms: number;
  lane_counts: Record<Lane, number>;
}

export function getPerformanceSummary(dateFrom?: string, dateTo?: string): PerformanceSummary {
  const stats = getReportOverviewStats(dateFrom, dateTo);

  // Delta vs the previous equal-length period (only when a bounded range is given).
  let prevRate: number | null = null;
  if (dateFrom && dateTo) {
    const from = new Date(dateFrom).getTime();
    const to = new Date(dateTo).getTime();
    const span = to - from;
    const prev = getReportOverviewStats(new Date(from - span).toISOString(), new Date(from).toISOString());
    prevRate = prev.passed_plan_runs + prev.failed_plan_runs > 0 ? prev.success_rate : null;
  }
  const delta = prevRate === null ? null : stats.success_rate - prevRate;

  const regs = getPieceRegressions(dateFrom, dateTo);
  const laneCounts: Record<Lane, number> = {
    newly_broken: 0, degrading: 0, flaky: 0, recovered: 0, still_broken: 0, stable: 0, stale: 0,
  };
  for (const r of regs) laneCounts[r.lane]++;

  const db = getDb();
  const cond = ["trigger_type = 'scheduled'", 'completed_at IS NOT NULL', "status IN ('completed','failed')"];
  const params: unknown[] = [];
  if (dateFrom) { cond.push('started_at >= ?'); params.push(dateFrom); }
  if (dateTo) { cond.push('started_at <= ?'); params.push(dateTo); }
  const durs = db
    .all<{ ms: number }>(
      `SELECT (julianday(completed_at) - julianday(started_at)) * 86400000 AS ms
       FROM test_plan_runs WHERE ${cond.join(' AND ')} ORDER BY ms ASC`,
      params,
    )
    .map(d => d.ms)
    .filter(m => m != null && m >= 0);
  const pct = (arr: number[], p: number) =>
    arr.length ? Math.round(arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))]) : 0;

  return {
    success_rate: stats.success_rate,
    prev_success_rate: prevRate,
    delta_pts: delta,
    blocked: stats.blocked_plan_runs,
    tested_pieces: regs.length,
    p50_ms: pct(durs, 50),
    p95_ms: pct(durs, 95),
    lane_counts: laneCounts,
  };
}

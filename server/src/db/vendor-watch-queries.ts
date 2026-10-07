import { getDb } from './schema.js';
import type {
  EndpointRef, FindingDraft, FindingKind, FindingStatus, Importance, ImportanceFilter, PlanStatus, RunTrigger, Severity,
  SourceKind,
} from '../services/vendor-watch/types.js';

export interface WatchConfigRow {
  id: number;
  enabled: number;
  cron_expression: string;
  timezone: string;
  auto_file_enabled: number;
  linear_team_key: string;
  linear_label: string;
  classifier_model: string;
  dead_after_failures: number;
  importance_high_min: number;
  importance_medium_min: number;
  enterprise_pieces: string;   // JSON string[]
  updated_at: string;
}

export interface WatchPlanRow {
  id: number;
  piece_name: string;
  piece_version: string;
  piece_display_name: string;
  vendor_name: string;
  api_base_urls: string;       // JSON string[]
  api_version: string;
  auth_type: string;
  endpoint_inventory: string;  // JSON EndpointRef[]
  status: PlanStatus;
  generation_note: string;
  generation_cost_usd: number;
  generated_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

/** How much a piece matters: Cloud usage over all versions, or the Enterprise list. */
export interface ImportanceFields {
  importance: Importance | null;
  enterprise: number;
  usage_projects: number | null;
  usage_fetched_at: string | null;
}

export interface WatchPlanListRow extends WatchPlanRow, ImportanceFields {
  sources_total: number;
  sources_ok: number;
  sources_failing: number;
  open_findings: number;
}

export interface WatchSourceRow {
  id: number;
  plan_id: number;
  kind: SourceKind;
  url: string;
  label: string;
  enabled: number;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_changed_at: string | null;
  consecutive_failures: number;
  last_error: string;
}

export interface WatchSnapshotRow {
  source_id: number;
  content_hash: string;
  content: string;
  fetched_at: string;
}

export interface WatchRunRow {
  id: number;
  plan_id: number;
  trigger_type: RunTrigger;
  cycle_id: string | null;
  status: 'running' | 'completed' | 'failed';
  sources_checked: number;
  sources_changed: number;
  sources_failed: number;
  findings_created: number;
  cost_usd: number;
  error: string;
  started_at: string;
  finished_at: string | null;
}

export interface VendorFindingRow {
  id: number;
  plan_id: number;
  piece_name: string;
  source_id: number | null;
  run_id: number | null;
  kind: FindingKind;
  severity: Severity;
  affects_piece: number;
  affected_targets: string;    // JSON string[]
  effective_date: string | null;
  title: string;
  summary: string;
  suggested_action: string;
  evidence_url: string;
  evidence_excerpt: string;
  evidence_verified: number;
  is_baseline: number;
  signature: string;
  status: FindingStatus;
  filed_by: 'auto' | 'manual' | null;
  linear_issue_id: string | null;
  linear_identifier: string | null;
  linear_url: string | null;
  file_error: string;
  created_at: string;
  updated_at: string;
}

// ── Config ──

const CONFIG_FIELDS = [
  'enabled', 'cron_expression', 'timezone', 'auto_file_enabled',
  'linear_team_key', 'linear_label', 'classifier_model', 'dead_after_failures',
  'importance_high_min', 'importance_medium_min', 'enterprise_pieces',
] as const;

export type WatchConfigPatch = Partial<Pick<WatchConfigRow, (typeof CONFIG_FIELDS)[number]>>;

export function getWatchConfig(): WatchConfigRow {
  return getDb().get<WatchConfigRow>('SELECT * FROM vendor_watch_config WHERE id = 1')!;
}

export function updateWatchConfig(patch: WatchConfigPatch): WatchConfigRow {
  const keys = CONFIG_FIELDS.filter(k => patch[k] !== undefined);
  if (keys.length > 0) {
    getDb().run(
      `UPDATE vendor_watch_config SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`,
      keys.map(k => patch[k]),
    );
  }
  return getWatchConfig();
}

// ── Plans ──

export interface PlanResult {
  piece_version: string;
  piece_display_name: string;
  vendor_name: string;
  api_base_urls: string[];
  api_version: string;
  auth_type: string;
  endpoint_inventory: EndpointRef[];
  generation_note: string;
  generation_cost_usd: number;
}

export function getPlan(id: number): WatchPlanRow | undefined {
  return getDb().get<WatchPlanRow>('SELECT * FROM watch_plans WHERE id = ?', [id]);
}

export function getPlanByPiece(pieceName: string): WatchPlanRow | undefined {
  return getDb().get<WatchPlanRow>('SELECT * FROM watch_plans WHERE piece_name = ?', [pieceName]);
}

/**
 * An enabled source counts as failing when it has consecutive failures or a noted error (e.g. a liveness timeout),
 * and as ok when it has been checked with neither. Disabled and never-checked sources count as neither.
 */
export function listPlans(): WatchPlanListRow[] {
  const imp = importanceSelect('p.piece_name');
  return getDb().all<WatchPlanListRow>(`
    SELECT * FROM (SELECT p.*, ${imp.sql},
      (SELECT COUNT(*) FROM watch_sources s WHERE s.plan_id = p.id) AS sources_total,
      (SELECT COUNT(*) FROM watch_sources s
        WHERE s.plan_id = p.id AND s.enabled = 1 AND s.last_checked_at IS NOT NULL
          AND s.consecutive_failures = 0 AND s.last_error = '') AS sources_ok,
      (SELECT COUNT(*) FROM watch_sources s
        WHERE s.plan_id = p.id AND s.enabled = 1
          AND (s.consecutive_failures > 0 OR s.last_error != '')) AS sources_failing,
      (SELECT COUNT(*) FROM vendor_findings f WHERE f.plan_id = p.id AND f.status = 'new') AS open_findings
    FROM watch_plans p
    LEFT JOIN piece_usage u ON u.piece_name = p.piece_name)
    ORDER BY ${IMPORTANCE_RANK}, piece_name
  `, imp.params);
}

export function listRunnablePlans(): WatchPlanRow[] {
  return getDb().all<WatchPlanRow>(`SELECT * FROM watch_plans WHERE status IN ('active', 'stale') ORDER BY id`);
}

/** Create the plan row for a generation, or flip an existing plan to generating. Keeps the plan id. */
export function beginPlanGeneration(pieceName: string): WatchPlanRow {
  getDb().run(
    `INSERT INTO watch_plans (piece_name, status) VALUES (?, 'generating')
     ON CONFLICT(piece_name) DO UPDATE SET status = 'generating', generation_note = ''`,
    [pieceName],
  );
  return getPlanByPiece(pieceName)!;
}

export function completePlanGeneration(planId: number, r: PlanResult): WatchPlanRow {
  getDb().run(
    `UPDATE watch_plans SET piece_version = ?, piece_display_name = ?, vendor_name = ?, api_base_urls = ?,
       api_version = ?, auth_type = ?, endpoint_inventory = ?, generation_note = ?, generation_cost_usd = ?,
       status = 'active', generated_at = datetime('now')
     WHERE id = ?`,
    [
      r.piece_version, r.piece_display_name, r.vendor_name, JSON.stringify(r.api_base_urls), r.api_version,
      r.auth_type, JSON.stringify(r.endpoint_inventory), r.generation_note, r.generation_cost_usd, planId,
    ],
  );
  return getPlan(planId)!;
}

/** A first generation that fails → failed. A failed regeneration → stale, so the old plan keeps running. */
export function failPlanGeneration(planId: number, note: string, costUsd = 0): WatchPlanRow {
  getDb().run(
    `UPDATE watch_plans SET status = CASE WHEN generated_at IS NULL THEN 'failed' ELSE 'stale' END,
       generation_note = ?, generation_cost_usd = ?
     WHERE id = ?`,
    [note.slice(0, 2000), costUsd, planId],
  );
  return getPlan(planId)!;
}

export function setPlanStatus(planId: number, status: 'active' | 'paused'): WatchPlanRow | undefined {
  getDb().run('UPDATE watch_plans SET status = ? WHERE id = ?', [status, planId]);
  return getPlan(planId);
}

/** Mark active plans whose catalog version moved past the version their inventory was read from. */
export function markStalePlans(catalogVersions: Map<string, string>): number {
  let marked = 0;
  for (const p of getDb().all<WatchPlanRow>(`SELECT * FROM watch_plans WHERE status = 'active'`)) {
    const latest = catalogVersions.get(p.piece_name);
    if (latest && p.piece_version && latest !== p.piece_version) {
      getDb().run(`UPDATE watch_plans SET status = 'stale' WHERE id = ?`, [p.id]);
      marked++;
    }
  }
  return marked;
}

export function touchPlanRun(planId: number): void {
  getDb().run(`UPDATE watch_plans SET last_run_at = datetime('now') WHERE id = ?`, [planId]);
}

export function deletePlan(planId: number): boolean {
  return getDb().run('DELETE FROM watch_plans WHERE id = ?', [planId]).changes > 0;
}

// ── Sources ──

export interface SourceInput {
  kind: SourceKind;
  url: string;
  label: string;
}

export function listSources(planId: number): WatchSourceRow[] {
  return getDb().all<WatchSourceRow>('SELECT * FROM watch_sources WHERE plan_id = ? ORDER BY id', [planId]);
}

export function getSource(id: number): WatchSourceRow | undefined {
  return getDb().get<WatchSourceRow>('SELECT * FROM watch_sources WHERE id = ?', [id]);
}

/** Replace a plan's sources. A source whose kind and URL are unchanged keeps its row and snapshot. */
export function replaceSources(planId: number, sources: SourceInput[]): WatchSourceRow[] {
  const db = getDb();
  return db.transaction(() => {
    const wanted = new Map(sources.map(s => [`${s.kind} ${s.url}`, s]));
    for (const old of listSources(planId)) {
      if (!wanted.has(`${old.kind} ${old.url}`)) db.run('DELETE FROM watch_sources WHERE id = ?', [old.id]);
    }
    for (const s of wanted.values()) {
      db.run(
        `INSERT INTO watch_sources (plan_id, kind, url, label) VALUES (?, ?, ?, ?)
         ON CONFLICT(plan_id, url) DO UPDATE SET label = excluded.label`,
        [planId, s.kind, s.url, s.label],
      );
    }
    return listSources(planId);
  });
}

export function setSourceEnabled(id: number, enabled: boolean): WatchSourceRow | undefined {
  getDb().run('UPDATE watch_sources SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  return getSource(id);
}

export function recordSourceOk(id: number, changed: boolean): void {
  getDb().run(
    `UPDATE watch_sources SET consecutive_failures = 0, last_error = '', last_checked_at = datetime('now'),
       last_ok_at = datetime('now'), last_changed_at = CASE WHEN ? THEN datetime('now') ELSE last_changed_at END
     WHERE id = ?`,
    [changed ? 1 : 0, id],
  );
}

/** Record a failed check. `count = false` notes the error without adding to consecutive_failures. Returns the count. */
export function recordSourceFailure(id: number, error: string, count = true): number {
  getDb().run(
    `UPDATE watch_sources SET consecutive_failures = consecutive_failures + ?, last_error = ?,
       last_checked_at = datetime('now')
     WHERE id = ?`,
    [count ? 1 : 0, error.slice(0, 500), id],
  );
  return getSource(id)?.consecutive_failures ?? 0;
}

// ── Snapshots ──

export function getSnapshot(sourceId: number): WatchSnapshotRow | undefined {
  return getDb().get<WatchSnapshotRow>('SELECT * FROM watch_snapshots WHERE source_id = ?', [sourceId]);
}

export function saveSnapshot(sourceId: number, contentHash: string, content: string): void {
  getDb().run(
    `INSERT INTO watch_snapshots (source_id, content_hash, content, fetched_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(source_id) DO UPDATE SET content_hash = excluded.content_hash, content = excluded.content,
       fetched_at = excluded.fetched_at`,
    [sourceId, contentHash, content],
  );
}

// ── Runs ──

export interface RunCounts {
  sources_checked: number;
  sources_changed: number;
  sources_failed: number;
  findings_created: number;
  cost_usd: number;
}

export function createRun(planId: number, trigger: RunTrigger, cycleId: string | null = null): WatchRunRow {
  const res = getDb().run(
    'INSERT INTO watch_runs (plan_id, trigger_type, cycle_id) VALUES (?, ?, ?)',
    [planId, trigger, cycleId],
  );
  return getRun(res.lastId)!;
}

export function getRun(id: number): WatchRunRow | undefined {
  return getDb().get<WatchRunRow>('SELECT * FROM watch_runs WHERE id = ?', [id]);
}

export function finishRun(id: number, status: 'completed' | 'failed', counts: RunCounts, error = ''): WatchRunRow {
  getDb().run(
    `UPDATE watch_runs SET status = ?, sources_checked = ?, sources_changed = ?, sources_failed = ?,
       findings_created = ?, cost_usd = ?, error = ?, finished_at = datetime('now')
     WHERE id = ?`,
    [
      status, counts.sources_checked, counts.sources_changed, counts.sources_failed,
      counts.findings_created, counts.cost_usd, error.slice(0, 2000), id,
    ],
  );
  return getRun(id)!;
}

export function listRuns(planId: number, limit = 20): WatchRunRow[] {
  return getDb().all<WatchRunRow>('SELECT * FROM watch_runs WHERE plan_id = ? ORDER BY id DESC LIMIT ?', [planId, limit]);
}

// ── Findings ──

/**
 * Insert a finding unless its (piece, signature) already exists. Returns null when it was a duplicate.
 * Only the signature conflict is skipped: a draft missing a required field throws.
 */
export function insertFinding(p: {
  plan_id: number; piece_name: string; source_id: number | null; run_id: number | null; draft: FindingDraft;
}): VendorFindingRow | null {
  const d = p.draft;
  const res = getDb().run(
    `INSERT INTO vendor_findings (plan_id, piece_name, source_id, run_id, kind, severity, affects_piece,
       affected_targets, effective_date, title, summary, suggested_action, evidence_url, evidence_excerpt,
       evidence_verified, is_baseline, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(piece_name, signature) DO NOTHING`,
    [
      p.plan_id, p.piece_name, p.source_id, p.run_id, d.kind, d.severity, d.affected_targets.length > 0 ? 1 : 0,
      JSON.stringify(d.affected_targets), d.effective_date, d.title, d.summary, d.suggested_action, d.evidence_url,
      d.evidence_excerpt, d.evidence_verified ? 1 : 0, d.is_baseline ? 1 : 0, d.signature,
    ],
  );
  return res.changes > 0 ? getFinding(res.lastId)! : null;
}

export function getFinding(id: number): VendorFindingRow | undefined {
  return getDb().get<VendorFindingRow>('SELECT * FROM vendor_findings WHERE id = ?', [id]);
}

export type FindingListRow = VendorFindingRow & ImportanceFields;

export interface FindingFilter {
  status?: FindingStatus;
  piece?: string;
  /** Empty or missing = every tier. */
  importance?: ImportanceFilter[];
  /** `importance`: tier, then severity, then newest. Default: newest first. */
  sort?: 'importance' | 'newest';
}

/** Findings joined with their piece's importance. Filters run before the 500-row cap. */
export function listFindings(f: FindingFilter = {}): FindingListRow[] {
  const { sql, params } = findingsWithImportance(f);
  const tiers = f.importance ?? [];
  const anyOf: string[] = [];
  const named = tiers.filter((t): t is Importance => t !== 'unrated');
  if (named.length) { anyOf.push(`importance IN (${named.map(() => '?').join(', ')})`); params.push(...named); }
  if (tiers.includes('unrated')) anyOf.push('importance IS NULL');
  const order = f.sort === 'importance' ? `${IMPORTANCE_RANK}, ${SEVERITY_RANK}, id DESC` : 'id DESC';
  return getDb().all<FindingListRow>(
    `SELECT * FROM (${sql}) ${anyOf.length ? `WHERE (${anyOf.join(' OR ')})` : ''} ORDER BY ${order} LIMIT 500`,
    params,
  );
}

/** Per-tier totals for the status and piece, ignoring any importance filter (the inbox chips). */
export function countFindingsByImportance(f: Pick<FindingFilter, 'status' | 'piece'> = {}): Record<ImportanceFilter, number> {
  const { sql, params } = findingsWithImportance(f);
  const rows = getDb().all<{ tier: ImportanceFilter; n: number }>(
    `SELECT COALESCE(importance, 'unrated') AS tier, COUNT(*) AS n FROM (${sql}) GROUP BY tier`, params,
  );
  const counts: Record<ImportanceFilter, number> = { high: 0, medium: 0, low: 0, unrated: 0 };
  for (const r of rows) counts[r.tier] = r.n;
  return counts;
}

function findingsWithImportance(f: Pick<FindingFilter, 'status' | 'piece'>): { sql: string; params: unknown[] } {
  const imp = importanceSelect('f.piece_name');
  const where: string[] = [];
  const params: unknown[] = [...imp.params];
  if (f.status) { where.push('f.status = ?'); params.push(f.status); }
  if (f.piece) { where.push('f.piece_name = ?'); params.push(f.piece); }
  return {
    sql: `SELECT f.*, ${imp.sql} FROM vendor_findings f LEFT JOIN piece_usage u ON u.piece_name = f.piece_name
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  };
}

export function countOpenFindings(pieceName: string): number {
  return getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM vendor_findings WHERE piece_name = ? AND status = 'new'`, [pieceName],
  )!.n;
}

export function markFindingFiled(id: number, p: {
  filed_by: 'auto' | 'manual'; linear_issue_id: string; linear_identifier: string; linear_url: string;
}): VendorFindingRow {
  getDb().run(
    `UPDATE vendor_findings SET status = 'filed', filed_by = ?, linear_issue_id = ?, linear_identifier = ?,
       linear_url = ?, file_error = '', updated_at = datetime('now')
     WHERE id = ?`,
    [p.filed_by, p.linear_issue_id, p.linear_identifier, p.linear_url, id],
  );
  return getFinding(id)!;
}

export function setFindingFileError(id: number, message: string): void {
  getDb().run(
    `UPDATE vendor_findings SET file_error = ?, updated_at = datetime('now') WHERE id = ?`,
    [message.slice(0, 500), id],
  );
}

export function dismissFinding(id: number): VendorFindingRow | undefined {
  getDb().run(
    `UPDATE vendor_findings SET status = 'dismissed', updated_at = datetime('now') WHERE id = ? AND status = 'new'`,
    [id],
  );
  return getFinding(id);
}

export function parseTargets(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** `*` overlaps any non-empty list; an empty list overlaps nothing. */
export function targetsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.includes('*') || b.includes('*')) return true;
  return a.some(t => b.includes(t));
}

/** A filed finding from the last 60 days this one should be added to as a comment, instead of a new ticket. */
export function findMergeTarget(pieceName: string, kind: FindingKind, targets: string[], excludeId: number): VendorFindingRow | null {
  const rows = getDb().all<VendorFindingRow>(
    `SELECT * FROM vendor_findings
     WHERE piece_name = ? AND kind = ? AND status = 'filed' AND COALESCE(linear_issue_id, '') != ''
       AND id != ? AND created_at >= datetime('now', '-60 days')
     ORDER BY id DESC`,
    [pieceName, kind, excludeId],
  );
  return rows.find(r => targetsOverlap(parseTargets(r.affected_targets), targets)) ?? null;
}

// ── Boot ──

/** Close runs and generations a restart interrupted. A regeneration falls back to stale, a first one to failed. */
export function reconcileVendorWatch(): { runs: number; plans: number } {
  const runs = getDb().run(
    `UPDATE watch_runs SET status = 'failed', error = 'interrupted by restart', finished_at = datetime('now')
     WHERE status = 'running'`,
  ).changes;
  const plans = getDb().run(
    `UPDATE watch_plans SET status = CASE WHEN generated_at IS NULL THEN 'failed' ELSE 'stale' END,
       generation_note = 'interrupted by restart'
     WHERE status = 'generating'`,
  ).changes;
  return { runs, plans };
}

// ── Piece importance ──

/** Unrated sorts above Low: no usage data yet doesn't mean the piece is unimportant. */
const IMPORTANCE_RANK = `CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 3 ELSE 2 END`;
const SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

/**
 * The one place the importance rule lives: on the Enterprise list → high; no usage row → NULL (unrated);
 * then Cloud projects against the config thresholds. Needs `piece_usage` joined as `u`.
 */
function importanceSelect(nameColumn: string): { sql: string; params: unknown[] } {
  const c = getWatchConfig();
  const enterprise = JSON.stringify(enterpriseList(c.enterprise_pieces));
  return {
    sql: `CASE
        WHEN ${nameColumn} IN (SELECT value FROM json_each(?)) THEN 'high'
        WHEN u.projects IS NULL THEN NULL
        WHEN u.projects >= ? THEN 'high'
        WHEN u.projects >= ? THEN 'medium'
        ELSE 'low'
      END AS importance,
      (${nameColumn} IN (SELECT value FROM json_each(?))) AS enterprise,
      u.projects AS usage_projects,
      u.fetched_at AS usage_fetched_at`,
    params: [enterprise, c.importance_high_min, c.importance_medium_min, enterprise],
  };
}

/** The stored Enterprise list as names. A hand-edited, malformed value reads as empty rather than breaking queries. */
function enterpriseList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface PieceUsageInput {
  piece_name: string;
  projects: number;
  versions: number;
  versions_failed: number;
}

/** Store refreshed usage. A partial result (some versions failed) never replaces a complete row with a higher count. */
export function upsertPieceUsage(rows: PieceUsageInput[], fetchedAt?: string): void {
  const db = getDb();
  db.transaction(() => {
    for (const r of rows) {
      db.run(
        `INSERT INTO piece_usage (piece_name, projects, versions, versions_failed, fetched_at)
         VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))
         ON CONFLICT(piece_name) DO UPDATE SET projects = excluded.projects, versions = excluded.versions,
           versions_failed = excluded.versions_failed, fetched_at = excluded.fetched_at
         WHERE NOT (excluded.versions_failed > 0 AND piece_usage.versions_failed = 0
           AND piece_usage.projects > excluded.projects)`,
        [r.piece_name, r.projects, r.versions, r.versions_failed, fetchedAt ?? null],
      );
    }
  });
}

export type PieceImportanceRow = { piece_name: string } & ImportanceFields;

export function getPieceImportance(pieceName: string): ImportanceFields {
  const imp = importanceSelect('n.piece_name');
  return getDb().get<ImportanceFields>(
    `SELECT ${imp.sql} FROM (SELECT ? AS piece_name) n LEFT JOIN piece_usage u ON u.piece_name = n.piece_name`,
    [...imp.params, pieceName],
  )!;
}

/** Every piece with usage data, plus Enterprise-list pieces that have none yet. */
export function listPieceUsage(): PieceImportanceRow[] {
  const imp = importanceSelect('n.piece_name');
  return getDb().all<PieceImportanceRow>(
    `SELECT n.piece_name, ${imp.sql}
     FROM (SELECT piece_name FROM piece_usage UNION SELECT value FROM json_each(?)) n
     LEFT JOIN piece_usage u ON u.piece_name = n.piece_name
     ORDER BY u.projects DESC, n.piece_name`,
    [...imp.params, JSON.stringify(enterpriseList(getWatchConfig().enterprise_pieces))],
  );
}

/** The names with no usage row, a row older than `maxAgeDays`, or a partial row (some versions failed) older than a day. */
export function stalePieces(names: string[], maxAgeDays: number): string[] {
  if (names.length === 0) return [];
  const fresh = new Set(getDb().all<{ piece_name: string }>(
    `SELECT piece_name FROM piece_usage
     WHERE fetched_at >= datetime('now', CASE WHEN versions_failed = 0 THEN ? ELSE '-1 days' END)`,
    [`-${maxAgeDays} days`],
  ).map(r => r.piece_name));
  return names.filter(n => !fresh.has(n));
}

export function listWatchedPieceNames(): string[] {
  return getDb().all<{ piece_name: string }>('SELECT piece_name FROM watch_plans ORDER BY piece_name').map(r => r.piece_name);
}

export function usageSummary(): { rated: number; oldest_fetched_at: string | null; newest_fetched_at: string | null } {
  return getDb().get<{ rated: number; oldest_fetched_at: string | null; newest_fetched_at: string | null }>(
    `SELECT COUNT(*) AS rated, MIN(fetched_at) AS oldest_fetched_at, MAX(fetched_at) AS newest_fetched_at FROM piece_usage`,
  )!;
}

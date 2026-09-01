import { getDb } from './schema.js';
import { buildConnectionBacklinks, type ConnectionBacklinks } from '../services/connection-health.js';

// ── Settings ──

export interface SettingsRow {
  id: number;
  base_url: string;
  api_key: string;
  project_id: string;
  test_timeout_ms: number;
  jwt_token: string;
  anthropic_api_key: string;
  ai_model: string;
  mcp_token: string;
  // MCP OAuth 2.1 fields
  mcp_access_token: string;
  mcp_refresh_token: string;
  mcp_token_expiry: string;  // ISO timestamp
  mcp_client_id: string;
  mcp_pkce_verifier: string; // temporary during OAuth flow
  mcp_oauth_state: string;   // temporary CSRF state
  updated_at: string;
}

export function getSettings(): SettingsRow {
  return getDb().get<SettingsRow>('SELECT * FROM settings WHERE id = 1')!;
}

export function updateSettings(s: Partial<Omit<SettingsRow, 'id' | 'updated_at'>>): SettingsRow {
  const current = getSettings();
  getDb().run(`
    UPDATE settings SET
      base_url = ?,
      api_key = ?,
      project_id = ?,
      test_timeout_ms = ?,
      jwt_token = ?,
      anthropic_api_key = ?,
      ai_model = ?,
      mcp_token = ?,
      mcp_access_token = ?,
      mcp_refresh_token = ?,
      mcp_token_expiry = ?,
      mcp_client_id = ?,
      mcp_pkce_verifier = ?,
      mcp_oauth_state = ?,
      updated_at = datetime('now')
    WHERE id = 1
  `, [
    s.base_url ?? current.base_url,
    s.api_key ?? current.api_key,
    s.project_id ?? current.project_id,
    s.test_timeout_ms ?? current.test_timeout_ms,
    s.jwt_token ?? current.jwt_token,
    s.anthropic_api_key ?? current.anthropic_api_key,
    s.ai_model ?? current.ai_model,
    s.mcp_token ?? current.mcp_token,
    s.mcp_access_token ?? current.mcp_access_token,
    s.mcp_refresh_token ?? current.mcp_refresh_token,
    s.mcp_token_expiry ?? current.mcp_token_expiry,
    s.mcp_client_id ?? current.mcp_client_id,
    s.mcp_pkce_verifier ?? current.mcp_pkce_verifier,
    s.mcp_oauth_state ?? current.mcp_oauth_state,
  ]);
  return getSettings();
}

// ── Piece Connections ──

export interface PieceConnectionRow {
  id: number;
  piece_name: string;
  display_name: string;
  connection_type: string;
  connection_value: string; // JSON
  actions_config: string;   // JSON - { actionName: { prop: value, ... }, ... }
  ai_config_meta: string;   // JSON - { actionName: { fields: [...], note: string, readyToTest: bool }, ... }
  project_id: string;
  is_active: number;        // 1 = active, 0 = inactive
  created_at: string;
  updated_at: string;
}

/** List active connections for the current project (used by test engine). */
export function listConnections(): PieceConnectionRow[] {
  const projectId = getSettings().project_id;
  return getDb().all<PieceConnectionRow>(
    'SELECT * FROM piece_connections WHERE project_id = ? AND is_active = 1 ORDER BY piece_name',
    [projectId],
  );
}

/** List ALL connections for the current project (active + inactive). */
export function listAllProjectConnections(): PieceConnectionRow[] {
  const projectId = getSettings().project_id;
  return getDb().all<PieceConnectionRow>(
    'SELECT * FROM piece_connections WHERE project_id = ? ORDER BY piece_name, is_active DESC',
    [projectId],
  );
}

/** List ALL connections for a piece in the current project (active + inactive). */
export function listConnectionsForPiece(pieceName: string): PieceConnectionRow[] {
  const projectId = getSettings().project_id;
  return getDb().all<PieceConnectionRow>(
    'SELECT * FROM piece_connections WHERE piece_name = ? AND project_id = ? ORDER BY is_active DESC, updated_at DESC',
    [pieceName, projectId],
  );
}

export function getConnection(id: number): PieceConnectionRow | undefined {
  return getDb().get<PieceConnectionRow>('SELECT * FROM piece_connections WHERE id = ?', [id]);
}

/** Get the ACTIVE connection for a piece in the current project. */
export function getConnectionByPiece(pieceName: string): PieceConnectionRow | undefined {
  const projectId = getSettings().project_id;
  return getDb().get<PieceConnectionRow>(
    'SELECT * FROM piece_connections WHERE piece_name = ? AND project_id = ? AND is_active = 1',
    [pieceName, projectId],
  );
}

export function createConnection(c: {
  piece_name: string;
  display_name: string;
  connection_type: string;
  connection_value: string;
  actions_config?: string;
  project_id?: string;
}): PieceConnectionRow {
  const db = getDb();
  return db.transaction(() => {
    const projectId = c.project_id || getSettings().project_id;
    db.run(
      'UPDATE piece_connections SET is_active = 0 WHERE piece_name = ? AND project_id = ?',
      [c.piece_name, projectId],
    );
    const result = db.run(`
      INSERT INTO piece_connections (piece_name, display_name, connection_type, connection_value, actions_config, project_id, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `, [c.piece_name, c.display_name, c.connection_type, c.connection_value, c.actions_config ?? '{}', projectId]);
    return getConnection(result.lastId)!;
  });
}

/** Set a connection as active, deactivating others for the same piece+project. */
export function activateConnection(id: number): PieceConnectionRow | undefined {
  const db = getDb();
  return db.transaction(() => {
    const conn = getConnection(id);
    if (!conn) return undefined;
    db.run(
      'UPDATE piece_connections SET is_active = 0 WHERE piece_name = ? AND project_id = ?',
      [conn.piece_name, conn.project_id],
    );
    db.run(
      "UPDATE piece_connections SET is_active = 1, updated_at = datetime('now') WHERE id = ?",
      [id],
    );
    return getConnection(id);
  });
}

export function updateConnection(id: number, c: Partial<{
  display_name: string;
  connection_type: string;
  connection_value: string;
  actions_config: string;
  ai_config_meta: string;
}>): PieceConnectionRow | undefined {
  const current = getConnection(id);
  if (!current) return undefined;
  getDb().run(`
    UPDATE piece_connections SET
      display_name = ?,
      connection_type = ?,
      connection_value = ?,
      actions_config = ?,
      ai_config_meta = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `, [
    c.display_name ?? current.display_name,
    c.connection_type ?? current.connection_type,
    c.connection_value ?? current.connection_value,
    c.actions_config ?? current.actions_config,
    c.ai_config_meta ?? current.ai_config_meta,
    id,
  ]);
  return getConnection(id);
}

export function deleteConnection(id: number): boolean {
  const db = getDb();
  return db.transaction(() => {
    const conn = getConnection(id);
    const result = db.run('DELETE FROM piece_connections WHERE id = ?', [id]);
    if (conn && conn.is_active) {
      const next = db.get<{ id: number }>(
        'SELECT id FROM piece_connections WHERE piece_name = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 1',
        [conn.piece_name, conn.project_id],
      );
      if (next) {
        db.run('UPDATE piece_connections SET is_active = 1 WHERE id = ?', [next.id]);
      }
    }
    return result.changes > 0;
  });
}

// ── Test Runs ──

/**
 * Identifies the schedule fire ("wave") that spawned a run.
 * A single cron fire generates one wave_id shared by every run it creates, so runs
 * can be grouped by fire and linked back to the schedule. Both fields are undefined
 * for manual (non-scheduled) runs.
 */
export interface WaveInfo {
  wave_id?: string;
  schedule_id?: number;
}

// ── Schedules ──

export interface ScheduleTarget {
  piece_name: string;
  action_name?: string; // undefined = all actions for this piece
}

export interface ScheduleRow {
  id: number;
  piece_name: string | null; // kept for legacy display; use targets for filtering
  cron_expression: string;
  enabled: number;
  last_run_at: string | null;
  label: string;
  timezone: string;
  schedule_config: string; // JSON: { frequency, minute, hour, dayOfWeek, dayOfMonth }
  targets: string;         // JSON: ScheduleTarget[] — empty = all pieces/all actions
  created_at: string;
}

export function listSchedules(): ScheduleRow[] {
  return getDb().all<ScheduleRow>('SELECT * FROM schedules ORDER BY id');
}

export function getSchedule(id: number): ScheduleRow | undefined {
  return getDb().get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', [id]);
}

export function createSchedule(s: {
  piece_name?: string;
  cron_expression: string;
  label?: string;
  timezone?: string;
  schedule_config?: string;
  targets?: string;
}): ScheduleRow {
  const result = getDb().run(`
    INSERT INTO schedules (piece_name, cron_expression, label, timezone, schedule_config, targets)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    s.piece_name ?? null,
    s.cron_expression,
    s.label ?? '',
    s.timezone ?? 'UTC',
    s.schedule_config ?? '{}',
    s.targets ?? '[]',
  ]);
  return getSchedule(result.lastId)!;
}

export function updateSchedule(id: number, s: Partial<{
  piece_name: string | null;
  cron_expression: string;
  enabled: number;
  last_run_at: string;
  label: string;
  timezone: string;
  schedule_config: string;
  targets: string;
}>): ScheduleRow | undefined {
  const current = getSchedule(id);
  if (!current) return undefined;
  getDb().run(`
    UPDATE schedules SET
      piece_name = ?,
      cron_expression = ?,
      enabled = ?,
      last_run_at = ?,
      label = ?,
      timezone = ?,
      schedule_config = ?,
      targets = ?
    WHERE id = ?
  `, [
    s.piece_name !== undefined ? s.piece_name : current.piece_name,
    s.cron_expression ?? current.cron_expression,
    s.enabled ?? current.enabled,
    s.last_run_at !== undefined ? s.last_run_at : current.last_run_at,
    s.label !== undefined ? s.label : current.label,
    s.timezone ?? current.timezone,
    s.schedule_config ?? current.schedule_config,
    s.targets !== undefined ? s.targets : current.targets,
    id,
  ]);
  return getSchedule(id);
}

export function deleteSchedule(id: number): boolean {
  return getDb().run('DELETE FROM schedules WHERE id = ?', [id]).changes > 0;
}

// ── Test Plans ──

export type TestPlanTargetType = 'action' | 'trigger';

export interface TestPlanRow {
  id: number;
  piece_name: string;
  target_action: string;
  target_type: TestPlanTargetType; // 'action' (default) | 'trigger'
  steps: string;       // JSON array of TestPlanStep
  status: string;      // 'draft' | 'approved'
  agent_memory: string;
  automation_status: string; // 'fully_automated' | 'requires_human' | 'unknown'
  needs_regen: number; // 0 | 1 — 1 = connection changed since approval; regenerate before running
  created_at: string;
  updated_at: string;
}

/**
 * Compute the automation_status from a steps JSON string.
 * 'fully_automated' = no human_input steps or all have savedHumanResponse
 * 'requires_human'  = at least one human_input step without savedHumanResponse
 */
export function computeAutomationStatus(stepsJson: string): 'fully_automated' | 'requires_human' {
  try {
    const steps = JSON.parse(stepsJson) as { type: string; savedHumanResponse?: string }[];
    const needsHuman = steps.some(s => s.type === 'human_input' && !s.savedHumanResponse);
    return needsHuman ? 'requires_human' : 'fully_automated';
  } catch {
    return 'fully_automated';
  }
}

export function createTestPlan(p: {
  piece_name: string;
  target_action: string;
  target_type?: TestPlanTargetType;
  steps: string;
  status?: string;
  agent_memory?: string;
}): TestPlanRow {
  const db = getDb();
  const targetType = p.target_type || 'action';
  return db.transaction(() => {
    const automationStatus = computeAutomationStatus(p.steps);
    const existing = getTestPlanByTarget(p.piece_name, p.target_action, targetType);
    if (existing) {
      db.run(`
        UPDATE test_plans SET steps = ?, status = ?, agent_memory = ?, automation_status = ?, needs_regen = 0, updated_at = datetime('now')
        WHERE id = ?
      `, [p.steps, p.status || 'draft', p.agent_memory || '', automationStatus, existing.id]);
      return getTestPlan(existing.id)!;
    }
    const result = db.run(`
      INSERT INTO test_plans (piece_name, target_action, target_type, steps, status, agent_memory, automation_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [p.piece_name, p.target_action, targetType, p.steps, p.status || 'draft', p.agent_memory || '', automationStatus]);
    return getTestPlan(result.lastId)!;
  });
}

export function getTestPlan(id: number): TestPlanRow | undefined {
  return getDb().get<TestPlanRow>('SELECT * FROM test_plans WHERE id = ?', [id]);
}

/** Look up a plan by piece + target name + target type (action vs trigger). */
export function getTestPlanByTarget(pieceName: string, targetName: string, targetType: TestPlanTargetType): TestPlanRow | undefined {
  return getDb().get<TestPlanRow>(
    'SELECT * FROM test_plans WHERE piece_name = ? AND target_action = ? AND target_type = ?',
    [pieceName, targetName, targetType],
  );
}

export function getTestPlanByAction(pieceName: string, targetAction: string): TestPlanRow | undefined {
  return getTestPlanByTarget(pieceName, targetAction, 'action');
}

export function getTestPlanByTrigger(pieceName: string, targetTrigger: string): TestPlanRow | undefined {
  return getTestPlanByTarget(pieceName, targetTrigger, 'trigger');
}

export function listTestPlans(pieceName?: string): TestPlanRow[] {
  if (pieceName) {
    return getDb().all<TestPlanRow>(
      'SELECT * FROM test_plans WHERE piece_name = ? ORDER BY target_action',
      [pieceName],
    );
  }
  return getDb().all<TestPlanRow>('SELECT * FROM test_plans ORDER BY piece_name, target_action');
}

export function listTestPlansForActions(pieceName: string, actionNames: string[]): TestPlanRow[] {
  if (actionNames.length === 0) {
    return [];
  }
  const placeholders = actionNames.map(() => '?').join(', ');
  return getDb().all<TestPlanRow>(
    `SELECT * FROM test_plans WHERE piece_name = ? AND target_action IN (${placeholders}) ORDER BY target_action`,
    [pieceName, ...actionNames],
  );
}

export function updateTestPlan(id: number, updates: Partial<{
  steps: string;
  status: string;
  agent_memory: string;
}>): TestPlanRow | undefined {
  const current = getTestPlan(id);
  if (!current) return undefined;
  const stepsJson = updates.steps ?? current.steps;
  const automationStatus = computeAutomationStatus(stepsJson);
  // Clear stale ONLY when the plan's steps are rewritten (a real regeneration). A status-only or
  // memory-only update must not un-stale a plan whose content still targets the old account.
  const needsRegen = updates.steps !== undefined ? 0 : current.needs_regen;
  getDb().run(`
    UPDATE test_plans SET steps = ?, status = ?, agent_memory = ?, automation_status = ?, needs_regen = ?, updated_at = datetime('now')
    WHERE id = ?
  `, [
    stepsJson,
    updates.status ?? current.status,
    updates.agent_memory ?? current.agent_memory,
    automationStatus,
    needsRegen,
    id,
  ]);
  return getTestPlan(id);
}

export function deleteTestPlan(id: number): boolean {
  return getDb().run('DELETE FROM test_plans WHERE id = ?', [id]).changes > 0;
}

export function deleteTestPlansByPiece(pieceName: string, actionNames?: string[]): number {
  if (actionNames && actionNames.length > 0) {
    const placeholders = actionNames.map(() => '?').join(', ');
    return getDb().run(
      `DELETE FROM test_plans WHERE piece_name = ? AND target_action IN (${placeholders})`,
      [pieceName, ...actionNames],
    ).changes;
  }
  return getDb().run(
    'DELETE FROM test_plans WHERE piece_name = ?',
    [pieceName],
  ).changes;
}

/**
 * Mark all APPROVED plans for a piece as stale (connection changed → resource IDs may be wrong).
 * Draft plans are left alone. Returns the number of rows changed.
 */
export function markPlansStaleByPiece(pieceName: string): number {
  return getDb().run(
    `UPDATE test_plans SET needs_regen = 1, updated_at = datetime('now')
       WHERE piece_name = ? AND status = 'approved'`,
    [pieceName],
  ).changes;
}

// ── Test Plan Runs ──

export interface TestPlanRunRow {
  id: number;
  plan_id: number;
  status: string;           // 'running' | 'paused_for_human' | 'paused_for_approval' | 'completed' | 'failed'
  trigger_type: string;     // 'manual' | 'scheduled'
  current_step_id: string | null;
  step_results: string;     // JSON array of StepResult
  paused_prompt: string | null;
  started_at: string;
  completed_at: string | null;
  wave_id: string | null;     // schedule fire that spawned this run; NULL for manual runs
  schedule_id: number | null; // which schedule fired this run; NULL for manual runs
}

export function createPlanRun(planId: number, triggerType: string = 'manual', wave?: WaveInfo): TestPlanRunRow {
  const result = getDb().run(`
    INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, wave_id, schedule_id)
    VALUES (?, 'running', ?, '[]', ?, ?)
  `, [planId, triggerType, wave?.wave_id ?? null, wave?.schedule_id ?? null]);
  return getPlanRun(result.lastId)!;
}

export function getPlanRun(id: number): TestPlanRunRow | undefined {
  return getDb().get<TestPlanRunRow>('SELECT * FROM test_plan_runs WHERE id = ?', [id]);
}

export function reconcileOrphanedRuns(): number {
  const plan = getDb().run(
    `UPDATE test_plan_runs SET status = 'interrupted', completed_at = datetime('now') WHERE status = 'running'`,
  );
  return plan.changes;
}

export function listPlanRuns(planId: number): TestPlanRunRow[] {
  return getDb().all<TestPlanRunRow>(
    'SELECT * FROM test_plan_runs WHERE plan_id = ? ORDER BY id DESC',
    [planId],
  );
}

export interface PlanRunWithPlan extends TestPlanRunRow {
  piece_name: string;
  target_action: string;
}

/**
 * List all plan runs (globally, across all plans) with piece/action info.
 * Optionally filter by piece_name.
 */
export function listAllPlanRuns(options?: { pieceName?: string; limit?: number; offset?: number }): PlanRunWithPlan[] {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  if (options?.pieceName) {
    return getDb().all<PlanRunWithPlan>(`
      SELECT r.*, p.piece_name, p.target_action
      FROM test_plan_runs r
      JOIN test_plans p ON r.plan_id = p.id
      WHERE p.piece_name = ?
      ORDER BY r.id DESC LIMIT ? OFFSET ?
    `, [options.pieceName, limit, offset]);
  }
  return getDb().all<PlanRunWithPlan>(`
    SELECT r.*, p.piece_name, p.target_action
    FROM test_plan_runs r
    JOIN test_plans p ON r.plan_id = p.id
    ORDER BY r.id DESC LIMIT ? OFFSET ?
  `, [limit, offset]);
}

// ── Piece Lessons ──

export interface PieceLessonRow {
  id: number;
  piece_name: string;
  lesson: string;
  source: string;
  created_at: string;
}

export function getLessonsForPiece(pieceName: string): PieceLessonRow[] {
  return getDb().all<PieceLessonRow>(
    'SELECT * FROM piece_lessons WHERE piece_name = ? ORDER BY id DESC',
    [pieceName],
  );
}

export function addLesson(pieceName: string, lesson: string, source: string = 'fix'): PieceLessonRow {
  const db = getDb();
  return db.transaction(() => {
    const existing = getLessonsForPiece(pieceName);
    if (existing.length >= 20) {
      const toDelete = existing.slice(15);
      for (const row of toDelete) {
        db.run('DELETE FROM piece_lessons WHERE id = ?', [row.id]);
      }
    }
    const result = db.run(
      "INSERT INTO piece_lessons (piece_name, lesson, source) VALUES (?, ?, ?)",
      [pieceName, lesson, source],
    );
    return db.get<PieceLessonRow>('SELECT * FROM piece_lessons WHERE id = ?', [result.lastId])!;
  });
}

export function deleteLesson(id: number): boolean {
  return getDb().run('DELETE FROM piece_lessons WHERE id = ?', [id]).changes > 0;
}

// ── Report Queries ──

export interface ReportOverviewStats {
  total_plan_runs: number;
  passed_plan_runs: number;
  failed_plan_runs: number;
  running_plan_runs: number;
  blocked_plan_runs: number;
  total_legacy_runs: number;
  total_legacy_tests: number;
  passed_legacy_tests: number;
  failed_legacy_tests: number;
  error_legacy_tests: number;
  avg_plan_duration_ms: number;
  success_rate: number;
}

export function getReportOverviewStats(dateFrom?: string, dateTo?: string): ReportOverviewStats {
  const db = getDb();
  const planConditions = ["trigger_type = 'scheduled'"];
  const planParams: unknown[] = [];
  if (dateFrom) { planConditions.push('started_at >= ?'); planParams.push(dateFrom); }
  if (dateTo) { planConditions.push('started_at <= ?'); planParams.push(dateTo); }
  const planWhere = planConditions.join(' AND ');

  const planStats = db.get<any>(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
      AVG(CASE WHEN completed_at IS NOT NULL
        THEN (julianday(completed_at) - julianday(started_at)) * 86400000
        ELSE NULL END) AS avg_duration_ms
    FROM test_plan_runs WHERE ${planWhere}
  `, planParams);

  // Success rate is over decided (pass/fail) outcomes only. Blocked runs are skipped
  // because a connection was broken — they are not failures and must not drag the rate.
  const decided = (planStats.passed || 0) + (planStats.failed || 0);
  const successRate = decided > 0 ? Math.round(((planStats.passed || 0) / decided) * 100) : 0;

  return {
    total_plan_runs: planStats.total || 0,
    passed_plan_runs: planStats.passed || 0,
    failed_plan_runs: planStats.failed || 0,
    running_plan_runs: planStats.running || 0,
    blocked_plan_runs: planStats.blocked || 0,
    total_legacy_runs: 0,
    total_legacy_tests: 0,
    passed_legacy_tests: 0,
    failed_legacy_tests: 0,
    error_legacy_tests: 0,
    avg_plan_duration_ms: Math.round(planStats.avg_duration_ms || 0),
    success_rate: successRate,
  };
}

export interface PieceBreakdownRow {
  piece_name: string;
  total_runs: number;
  passed: number;
  failed: number;
  last_run_at: string | null;
  last_status: string | null;
  avg_duration_ms: number;
  actions_tested: number;
}

export function getPieceBreakdown(dateFrom?: string, dateTo?: string): PieceBreakdownRow[] {
  const db = getDb();
  const conditions = ["r.trigger_type = 'scheduled'"];
  const params: unknown[] = [];
  if (dateFrom) { conditions.push('r.started_at >= ?'); params.push(dateFrom); }
  if (dateTo) { conditions.push('r.started_at <= ?'); params.push(dateTo); }

  return db.all<PieceBreakdownRow>(`
    SELECT
      p.piece_name,
      COUNT(r.id) AS total_runs,
      SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      MAX(r.started_at) AS last_run_at,
      (SELECT r2.status FROM test_plan_runs r2 JOIN test_plans p2 ON r2.plan_id = p2.id
        WHERE p2.piece_name = p.piece_name AND r2.trigger_type = 'scheduled'
        ORDER BY r2.id DESC LIMIT 1) AS last_status,
      AVG(CASE WHEN r.completed_at IS NOT NULL
        THEN (julianday(r.completed_at) - julianday(r.started_at)) * 86400000
        ELSE NULL END) AS avg_duration_ms,
      COUNT(DISTINCT p.target_action) AS actions_tested
    FROM test_plans p
    JOIN test_plan_runs r ON r.plan_id = p.id
    WHERE ${conditions.join(' AND ')}
    GROUP BY p.piece_name
    ORDER BY failed DESC, total_runs DESC
  `, params);
}

// ── Piece Health (current-state board) ──
// Unlike getPieceBreakdown (aggregates over a date range = analytics), this reports the
// CURRENT health of each piece: the outcome of the LATEST scheduled run of each of its
// actions. This is the operational "are my 100 pieces OK right now?" view. Failing pieces
// sort to the top; each carries the failing action(s) + a short error hint, plus a
// sparkline of its recent run outcomes.

export interface PieceHealthRow {
  piece_name: string;
  status: 'failing' | 'blocked' | 'healthy' | 'unknown';
  actions_total: number;
  actions_passing: number;
  actions_failing: number;
  actions_blocked: number;
  last_run_at: string | null;
  failing_actions: { action: string; error: string | null; category: string; plan_id: number; run_id: number }[];
  blocked_reason: string | null;
  backlinks: ConnectionBacklinks | null;
  recent: string[]; // last ~12 run statuses, oldest→newest, for a sparkline
}

/** Pull the first failed step's message out of a run's step_results JSON, shortened. */
function extractFirstStepError(stepResultsJson: string): string | null {
  try {
    const steps = JSON.parse(stepResultsJson);
    if (!Array.isArray(steps)) return null;
    const failed = steps.find((s: any) => s && (s.status === 'failed' || s.status === 'assert_failed') && s.error);
    if (!failed) return null;
    let msg = String(failed.error);
    try { const o = JSON.parse(msg); if (o && typeof o.message === 'string') msg = o.message; } catch { /* not JSON */ }
    msg = msg.split('\n')[0].trim();
    return msg.length > 100 ? msg.slice(0, 100) + '…' : msg;
  } catch { return null; }
}

/** First step's error message regardless of status — used for blocked runs (sole step is 'skipped'). */
function firstStepMessage(stepResultsJson: string): string | null {
  try {
    const steps = JSON.parse(stepResultsJson);
    return Array.isArray(steps) && steps[0]?.error ? String(steps[0].error) : null;
  } catch { return null; }
}

/** First step's stepId — distinguishes a 'connection' block (PR #14) from a 'stale' block. */
function firstStepId(stepResultsJson: string): string | null {
  try {
    const steps = JSON.parse(stepResultsJson);
    return Array.isArray(steps) && steps[0]?.stepId ? String(steps[0].stepId) : null;
  } catch { return null; }
}

export function getPieceHealth(): PieceHealthRow[] {
  const db = getDb();

  // Latest scheduled run per plan (= per piece+action): its current status + error.
  const latest = db.all<{ plan_id: number; piece_name: string; target_action: string; last_status: string; last_run_at: string | null; step_results: string; run_id: number }>(`
    SELECT p.id AS plan_id, p.piece_name, p.target_action,
           r.id AS run_id, r.status AS last_status, r.started_at AS last_run_at, r.step_results
    FROM test_plans p
    JOIN test_plan_runs r ON r.id = (
      SELECT r2.id FROM test_plan_runs r2
      WHERE r2.plan_id = p.id AND r2.trigger_type = 'scheduled'
      ORDER BY r2.id DESC LIMIT 1
    )
  `);

  // Last ~12 scheduled runs per piece (any action) for the sparkline.
  const spark = db.all<{ piece_name: string; status: string; rn: number }>(`
    WITH ranked AS (
      SELECT p.piece_name AS piece_name, r.status AS status,
        ROW_NUMBER() OVER (PARTITION BY p.piece_name ORDER BY r.id DESC) AS rn
      FROM test_plans p JOIN test_plan_runs r ON r.plan_id = p.id
      WHERE r.trigger_type = 'scheduled'
    )
    SELECT piece_name, status, rn FROM ranked WHERE rn <= 12 ORDER BY piece_name, rn DESC
  `);

  const recentByPiece = new Map<string, string[]>();
  for (const row of spark) {
    if (!recentByPiece.has(row.piece_name)) recentByPiece.set(row.piece_name, []);
    recentByPiece.get(row.piece_name)!.push(row.status);
  }

  const connectionBlocked = new Set<string>(); // pieces whose block is a broken connection (not stale)
  const staleBlocked = new Set<string>();       // pieces whose block is a stale plan (connection changed)
  const byPiece = new Map<string, PieceHealthRow>();
  for (const row of latest) {
    let h = byPiece.get(row.piece_name);
    if (!h) {
      h = {
        piece_name: row.piece_name, status: 'unknown',
        actions_total: 0, actions_passing: 0, actions_failing: 0, actions_blocked: 0,
        last_run_at: null, failing_actions: [], blocked_reason: null, backlinks: null,
        recent: recentByPiece.get(row.piece_name) ?? [],
      };
      byPiece.set(row.piece_name, h);
    }
    h.actions_total++;
    if (row.last_status === 'completed') h.actions_passing++;
    else if (row.last_status === 'failed') {
      h.actions_failing++;
      // Reuse the attention-inbox classifier so the health board and the inbox agree on
      // the error category that drives the "what you can do" playbook.
      const { category } = analyzeFailedRun(row.step_results);
      h.failing_actions.push({
        action: row.target_action,
        error: extractFirstStepError(row.step_results),
        category,
        plan_id: row.plan_id,
        run_id: row.run_id,
      });
    }
    else if (row.last_status === 'blocked') {
      h.actions_blocked++;
      if (!h.blocked_reason) h.blocked_reason = firstStepMessage(row.step_results);
      if (firstStepId(row.step_results) === 'connection') connectionBlocked.add(row.piece_name);
      else if (firstStepId(row.step_results) === 'stale') staleBlocked.add(row.piece_name);
    }
    if (!h.last_run_at || (row.last_run_at && row.last_run_at > h.last_run_at)) h.last_run_at = row.last_run_at;
  }

  const result = [...byPiece.values()];
  const settings = getSettings();
  for (const h of result) {
    h.status = h.actions_failing > 0 ? 'failing'
      : h.actions_blocked > 0 ? 'blocked'
      : h.actions_passing > 0 ? 'healthy' : 'unknown';
    if (h.status === 'blocked' && connectionBlocked.has(h.piece_name) && !staleBlocked.has(h.piece_name)) {
      h.backlinks = buildConnectionBacklinks(settings.base_url, settings.project_id, h.piece_name);
    }
  }
  // Order: failing first, then blocked, then everything else — most-failing first within a rank.
  const rank = (h: PieceHealthRow) => (h.status === 'failing' ? 0 : h.status === 'blocked' ? 1 : 2);
  result.sort((a, b) =>
    (rank(a) - rank(b)) ||
    (b.actions_failing - a.actions_failing) ||
    a.piece_name.localeCompare(b.piece_name));
  return result;
}

// ── Quarantine (pieces/actions excluded from the Needs-Attention inbox) ──

export interface QuarantineRow {
  id: number;
  piece_name: string;
  action_name: string | null;
  reason: string;
  created_at: string;
  expires_at: string | null;
}

/** Active quarantines only (expired ones are ignored). */
export function listQuarantine(): QuarantineRow[] {
  return getDb().all<QuarantineRow>(
    `SELECT * FROM quarantined_items WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY id DESC`,
  );
}

export function addQuarantine(params: { piece_name: string; action_name?: string | null; reason?: string; expires_at?: string | null }): QuarantineRow {
  const res = getDb().run(
    `INSERT INTO quarantined_items (piece_name, action_name, reason, expires_at) VALUES (?, ?, ?, ?)`,
    [params.piece_name, params.action_name ?? null, params.reason ?? '', params.expires_at ?? null],
  );
  return getDb().get<QuarantineRow>('SELECT * FROM quarantined_items WHERE id = ?', [res.lastId])!;
}

export function removeQuarantine(id: number): boolean {
  return getDb().run('DELETE FROM quarantined_items WHERE id = ?', [id]).changes > 0;
}

// ── Needs-Attention inbox ──
// Collapses failing runs into one item per (piece, action), classified into a lane
// with a transparent reason. Derived entirely from existing run history — no engine
// changes. The strict-vs-inclusive filtering is applied client-side over these buckets.

export interface AttentionItem {
  plan_id: number;
  piece_name: string;
  action_name: string;
  bucket: 'reauth' | 'likely_broken' | 'watching' | 'noise';
  category: string;          // errorCategory or 'assert_failed'
  fail_streak: number;       // consecutive most-recent scheduled runs that failed
  flaky: boolean;            // recent history mixes passes and fails (not a clean streak)
  error: string | null;      // short one-line hint
  reason: string;            // human "why it's in this lane"
  failing_since: string | null;
  last_run_at: string | null;
  last_run_id: number;
  quarantined: boolean;
  quarantine_id: number | null;
  backlinks: ConnectionBacklinks | null;  // present for connection_broken items
}

function shortenError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let msg = String(raw);
  try { const o = JSON.parse(msg); if (o && typeof o.message === 'string') msg = o.message; } catch { /* not JSON */ }
  msg = msg.split('\n')[0].trim();
  return msg.length > 120 ? msg.slice(0, 120) + '…' : msg;
}

/** Classify a failed run from its step_results: a thrown step gives its errorCategory; else an assertion failure. */
function analyzeFailedRun(stepResultsJson: string): { category: string; error: string | null } {
  try {
    const steps = JSON.parse(stepResultsJson);
    if (!Array.isArray(steps)) return { category: 'unknown', error: null };
    const thrown = steps.find((s: any) => s && s.status === 'failed');
    if (thrown) return { category: thrown.errorCategory || 'piece_error', error: shortenError(thrown.error) };
    const asserted = steps.find((s: any) => s && s.status === 'assert_failed');
    if (asserted) return { category: 'assert_failed', error: shortenError(asserted.error) };
    return { category: 'unknown', error: null };
  } catch { return { category: 'unknown', error: null }; }
}

export function getAttentionItems(): AttentionItem[] {
  const db = getDb();

  // Plans whose LATEST scheduled run failed or was blocked = candidate attention items.
  const latest = db.all<{ plan_id: number; piece_name: string; target_action: string; run_id: number; last_run_at: string | null; step_results: string; last_status: string }>(`
    SELECT p.id AS plan_id, p.piece_name, p.target_action,
           r.id AS run_id, r.started_at AS last_run_at, r.step_results, r.status AS last_status
    FROM test_plans p
    JOIN test_plan_runs r ON r.id = (
      SELECT r2.id FROM test_plan_runs r2
      WHERE r2.plan_id = p.id AND r2.trigger_type = 'scheduled'
      ORDER BY r2.id DESC LIMIT 1
    )
    WHERE r.status IN ('failed', 'blocked')
  `);
  if (latest.length === 0) return [];

  // Recent statuses per plan (newest first) for fail-streak + flaky detection.
  const recent = db.all<{ plan_id: number; status: string; started_at: string; rn: number }>(`
    WITH ranked AS (
      SELECT r.plan_id AS plan_id, r.status AS status, r.started_at AS started_at,
        ROW_NUMBER() OVER (PARTITION BY r.plan_id ORDER BY r.id DESC) AS rn
      FROM test_plan_runs r
      WHERE r.trigger_type = 'scheduled'
    )
    SELECT plan_id, status, started_at, rn FROM ranked WHERE rn <= 10 ORDER BY plan_id, rn
  `);
  const historyByPlan = new Map<number, { status: string; started_at: string }[]>();
  for (const row of recent) {
    if (!historyByPlan.has(row.plan_id)) historyByPlan.set(row.plan_id, []);
    historyByPlan.get(row.plan_id)!.push({ status: row.status, started_at: row.started_at });
  }

  const quarantine = listQuarantine();
  const matchQuarantine = (piece: string, action: string) =>
    quarantine.find(q => q.piece_name === piece && (q.action_name === null || q.action_name === action)) ?? null;

  const items: AttentionItem[] = [];
  for (const row of latest) {
    const hist = historyByPlan.get(row.plan_id) ?? [];
    let streak = 0;
    for (const h of hist) { if (h.status === 'failed') streak++; else break; }
    if (streak === 0) streak = 1; // latest is failed by construction
    const failing_since = hist.slice(0, streak).at(-1)?.started_at ?? row.last_run_at;
    const flaky = hist.some(h => h.status === 'completed') && streak < 2;

    const isBlocked = row.last_status === 'blocked';
    const isStaleBlock = isBlocked && firstStepId(row.step_results) === 'stale';
    const { category, error } = isBlocked
      ? { category: 'connection_broken', error: firstStepMessage(row.step_results) }
      : analyzeFailedRun(row.step_results);

    let bucket: AttentionItem['bucket'];
    if (isBlocked || category === 'auth') bucket = 'reauth';
    else if (category === 'transient' || category === 'rate_limit') bucket = 'noise';
    else bucket = streak >= 2 ? 'likely_broken' : 'watching';

    let reason: string;
    if (isStaleBlock) reason = error || 'Connection changed — regenerate the plan';
    else if (isBlocked) reason = error || 'connection deleted/errored in Activepieces — fix it';
    else if (bucket === 'reauth') reason = 'connection auth failed — needs re-auth';
    else if (bucket === 'noise') reason = `${category} — likely environment/flake`;
    else if (bucket === 'likely_broken') reason = `failed ${streak}× in a row · ${category}`;
    else reason = flaky ? `flaky — recently passed and failed · ${category}` : `first failure · ${category}`;

    // A stale-plan block is not a connection problem — no Fix-in-AP / Re-import backlinks.
    const backlinks = (isBlocked && !isStaleBlock)
      ? buildConnectionBacklinks(getSettings().base_url, getSettings().project_id, row.piece_name)
      : null;

    const qItem = matchQuarantine(row.piece_name, row.target_action);

    items.push({
      plan_id: row.plan_id,
      piece_name: row.piece_name,
      action_name: row.target_action,
      bucket, category, fail_streak: streak, flaky,
      error, reason, failing_since, last_run_at: row.last_run_at, last_run_id: row.run_id,
      quarantined: qItem !== null, quarantine_id: qItem?.id ?? null,
      backlinks,
    });
  }

  const order: Record<string, number> = { likely_broken: 0, reauth: 1, watching: 2, noise: 3 };
  items.sort((a, b) =>
    (order[a.bucket] - order[b.bucket]) || (b.fail_streak - a.fail_streak) || a.piece_name.localeCompare(b.piece_name));
  return items;
}

// ── Scheduled Runs: wave-centric aggregation (redesigned feed) ──
// A "wave" = one schedule fire (shared wave_id). These power the wave-first Scheduled
// Runs view: a summary per fire + a failures-first Piece → Target drill — WITHOUT ever
// shipping step_results to the client (loaded lazily per run via getPlanRun on expand).
// The list scales with the number of FAILING targets, not the total run count.

export interface WaveSummary {
  wave_id: string;
  schedule_id: number | null;
  schedule_label: string | null;
  started_at: string;
  completed_at: string | null;
  total: number;
  passed: number;
  failed: number;
  running: number;
  blocked: number;
}

/** One row per schedule fire, newest first. Cheap: pure aggregate, no step_results. */
export function getScheduledWaves(limit = 30): WaveSummary[] {
  return getDb().all<WaveSummary>(`
    SELECT r.wave_id AS wave_id,
           r.schedule_id AS schedule_id,
           s.label AS schedule_label,
           MIN(r.started_at) AS started_at,
           MAX(r.completed_at) AS completed_at,
           COUNT(*) AS total,
           SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM test_plan_runs r
    LEFT JOIN schedules s ON s.id = r.schedule_id
    WHERE r.trigger_type = 'scheduled' AND r.wave_id IS NOT NULL
    GROUP BY r.wave_id
    ORDER BY started_at DESC
    LIMIT ?
  `, [limit]);
}

export interface WaveRun {
  run_id: number;
  target_action: string;
  target_type: string;    // 'action' | 'trigger'
  status: string;         // 'completed' | 'failed' | 'running' | ...
  category: string | null; // failed runs only (errorCategory | 'assert_failed' | 'unknown')
  error: string | null;    // failed runs only -- short one-line hint
  duration_ms: number | null;
  started_at: string;
}

export interface WavePiece {
  piece_name: string;
  total: number;
  passed: number;
  failed: number;
  running: number;
  blocked: number;
  worst_category: string | null;
  runs: WaveRun[];   // ALL runs enumerated; ordered failed(by severity) -> running -> passed
}

export interface WaveDetail {
  wave_id: string;
  schedule_id: number | null;
  schedule_label: string | null;
  started_at: string;
  total: number;
  passed: number;
  failed: number;
  running: number;
  blocked: number;
  pieces: WavePiece[];         // failing pieces first
  covered_total: number;       // pieces covered right now (enabled-schedule targets)
  covered_untested: number;    // covered pieces with no approved plans (a run can't test them)
}

// How piece-implicating a category is — drives worst_category + failure ordering.
function categorySeverity(cat: string | null): number {
  switch (cat) {
    case 'piece_error': return 6;
    case 'assert_failed': return 5;
    case 'not_found': return 4;
    case 'bad_request': return 3;
    case 'auth': return 2;
    case 'rate_limit':
    case 'transient': return 1;
    default: return 0;
  }
}

// Both timestamps are naive-UTC ("2026-07-29 10:45:01"); parse both the same way so the
// delta is correct regardless of the server's local zone (avoids the History.tsx TZ bug).
function runDurationMs(started?: string | null, completed?: string | null): number | null {
  if (!started || !completed) return null;
  const toUtc = (s: string) => Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  const a = toUtc(started), b = toUtc(completed);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

/**
 * Per-piece rollup for one wave. Three queries: cheap per-piece counts, ALL runs' lightweight
 * metadata (no step_results), and step_results ONLY for the failing runs (so JSON-parse cost
 * scales with failures, not total runs). step_results still load lazily per run on expand.
 */
export function getWaveDetail(waveId: string): WaveDetail | null {
  const db = getDb();

  const pieceCounts = db.all<{ piece_name: string; total: number; passed: number; failed: number; running: number; blocked: number }>(`
    SELECT p.piece_name AS piece_name,
           COUNT(*) AS total,
           SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM test_plan_runs r
    JOIN test_plans p ON p.id = r.plan_id
    WHERE r.wave_id = ?
    GROUP BY p.piece_name
  `, [waveId]);
  if (pieceCounts.length === 0) return null;

  // Every run in the wave -- metadata only, NO step_results (keeps the payload light).
  const allRuns = db.all<{ id: number; status: string; started_at: string; completed_at: string | null; piece_name: string; target_action: string; target_type: string }>(`
    SELECT r.id, r.status, r.started_at, r.completed_at,
           p.piece_name, p.target_action, p.target_type
    FROM test_plan_runs r
    JOIN test_plans p ON p.id = r.plan_id
    WHERE r.wave_id = ?
  `, [waveId]);

  // step_results ONLY for failed runs -> derive category/error (parse cost proportional to failures).
  const failingRows = db.all<{ id: number; step_results: string }>(`
    SELECT r.id, r.step_results
    FROM test_plan_runs r
    WHERE r.wave_id = ? AND r.status = 'failed'
  `, [waveId]);
  const failMeta = new Map<number, { category: string; error: string | null }>();
  for (const r of failingRows) failMeta.set(r.id, analyzeFailedRun(r.step_results));

  const meta = db.get<{ schedule_id: number | null; started_at: string; label: string | null }>(`
    SELECT r.schedule_id AS schedule_id, MIN(r.started_at) AS started_at, s.label AS label
    FROM test_plan_runs r
    LEFT JOIN schedules s ON s.id = r.schedule_id
    WHERE r.wave_id = ?
  `, [waveId]);

  const byPiece = new Map<string, WavePiece>();
  for (const c of pieceCounts) {
    byPiece.set(c.piece_name, {
      piece_name: c.piece_name, total: c.total, passed: c.passed, failed: c.failed, running: c.running, blocked: c.blocked,
      worst_category: null, runs: [],
    });
  }
  for (const r of allRuns) {
    const wp = byPiece.get(r.piece_name);
    if (!wp) continue;
    const fm = r.status === 'failed' ? (failMeta.get(r.id) ?? { category: 'unknown', error: null }) : null;
    wp.runs.push({
      run_id: r.id, target_action: r.target_action, target_type: r.target_type, status: r.status,
      category: fm?.category ?? null, error: fm?.error ?? null,
      duration_ms: runDurationMs(r.started_at, r.completed_at), started_at: r.started_at,
    });
  }

  // Within a piece: failed first (by category severity), then running, then everything else.
  const statusRank = (run: WaveRun): number =>
    run.status === 'failed' ? 100 + categorySeverity(run.category)
    : run.status === 'blocked' ? 60
    : run.status === 'running' ? 50
    : 10;

  const pieces = [...byPiece.values()];
  for (const wp of pieces) {
    wp.worst_category = wp.runs
      .filter(r => r.status === 'failed')
      .reduce<string | null>((w, f) => (categorySeverity(f.category) > categorySeverity(w) ? f.category : w), null);
    wp.runs.sort((a, b) => statusRank(b) - statusRank(a) || a.target_action.localeCompare(b.target_action));
  }
  // Failing pieces first (most failures first), then alphabetical.
  pieces.sort((a, b) => (b.failed - a.failed) || a.piece_name.localeCompare(b.piece_name));

  const agg = pieces.reduce((s, p) => ({
    total: s.total + p.total, passed: s.passed + p.passed, failed: s.failed + p.failed,
    running: s.running + p.running, blocked: s.blocked + p.blocked,
  }), { total: 0, passed: 0, failed: 0, running: 0, blocked: 0 });

  return {
    wave_id: waveId,
    schedule_id: meta?.schedule_id ?? null,
    schedule_label: meta?.label || null,
    started_at: meta?.started_at ?? '',
    ...agg,
    pieces,
    ...getCoverageCounts(),
  };
}

export interface TrendDataPoint {
  date: string;
  passed: number;
  failed: number;
  total: number;
}

export function getRunTrends(dateFrom?: string, dateTo?: string): TrendDataPoint[] {
  const db = getDb();
  const conditions = ["r.trigger_type = 'scheduled'"];
  const params: unknown[] = [];
  // Honor the selected range: when no dateFrom is given the caller means "all time",
  // so do NOT silently clamp to the last 30 days (that hid most history on this page).
  if (dateFrom) {
    conditions.push('r.started_at >= ?');
    params.push(dateFrom);
  }
  if (dateTo) { conditions.push('r.started_at <= ?'); params.push(dateTo); }

  return db.all<TrendDataPoint>(`
    SELECT
      DATE(r.started_at) AS date,
      SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COUNT(*) AS total
    FROM test_plan_runs r
    WHERE ${conditions.join(' AND ')}
    GROUP BY DATE(r.started_at)
    ORDER BY date
  `, params);
}

export interface FailureDetail {
  run_id: number;
  plan_id: number;
  piece_name: string;
  target_action: string;
  status: string;
  step_results: string;
  started_at: string;
  completed_at: string | null;
  trigger_type: string;
  wave_id: string | null;
  schedule_id: number | null;
}

export function getRecentFailures(limit: number = 50, dateFrom?: string, dateTo?: string): FailureDetail[] {
  const conditions = [`r.status = 'failed'`, `r.trigger_type = 'scheduled'`];
  const params: unknown[] = [];

  if (dateFrom) {
    conditions.push(`r.started_at >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`r.started_at <= ?`);
    params.push(dateTo);
  }

  params.push(limit);

  return getDb().all<FailureDetail>(`
    SELECT r.id AS run_id, r.plan_id, p.piece_name, p.target_action,
           r.status, r.step_results, r.started_at, r.completed_at, r.trigger_type,
           r.wave_id, r.schedule_id
    FROM test_plan_runs r
    JOIN test_plans p ON r.plan_id = p.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY r.id DESC
    LIMIT ?
  `, params);
}

// ── Report Analyses (cached AI analyses) ──

export interface ReportAnalysisRow {
  id: number;
  scope: string;
  status: string;
  time_range: string;
  date_from: string | null;
  date_to: string | null;
  summary: string;
  categories: string;
  recommendations: string;
  health_score: number;
  piece_issues_count: number;
  test_issues_count: number;
  transient_count: number;
  unknown_count: number;
  logs: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export function createRunningAnalysis(params: {
  scope: string;
  time_range: string;
  date_from?: string;
  date_to?: string;
}): ReportAnalysisRow {
  const result = getDb().run(`
    INSERT INTO report_analyses (scope, status, time_range, date_from, date_to, logs)
    VALUES (?, 'running', ?, ?, ?, '[]')
  `, [params.scope, params.time_range, params.date_from ?? null, params.date_to ?? null]);
  return getDb().get<ReportAnalysisRow>('SELECT * FROM report_analyses WHERE id = ?', [result.lastId])!;
}

export function getReportAnalysis(id: number): ReportAnalysisRow | undefined {
  return getDb().get<ReportAnalysisRow>('SELECT * FROM report_analyses WHERE id = ?', [id]);
}

export function updateReportAnalysis(id: number, updates: Partial<{
  status: string;
  summary: string;
  categories: string;
  recommendations: string;
  health_score: number;
  piece_issues_count: number;
  test_issues_count: number;
  transient_count: number;
  unknown_count: number;
  logs: string;
  error_message: string;
  completed_at: string;
}>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  getDb().run(`UPDATE report_analyses SET ${fields.join(', ')} WHERE id = ?`, values);
}

export function appendAnalysisLog(id: number, log: { type: string; message: string }): void {
  const db = getDb();
  db.transaction(() => {
    const row = getReportAnalysis(id);
    if (!row) return;
    const logs = JSON.parse(row.logs || '[]');
    logs.push({ ...log, timestamp: Date.now() });
    db.run('UPDATE report_analyses SET logs = ? WHERE id = ?', [JSON.stringify(logs), id]);
  });
}

export function getRunningAnalysis(): ReportAnalysisRow | undefined {
  return getDb().get<ReportAnalysisRow>(
    "SELECT * FROM report_analyses WHERE status = 'running' ORDER BY id DESC LIMIT 1",
  );
}

export function listReportAnalyses(limit: number = 10): ReportAnalysisRow[] {
  return getDb().all<ReportAnalysisRow>(
    'SELECT * FROM report_analyses ORDER BY id DESC LIMIT ?',
    [limit],
  );
}

export function getLatestCompletedAnalysis(): ReportAnalysisRow | undefined {
  return getDb().get<ReportAnalysisRow>(
    "SELECT * FROM report_analyses WHERE status = 'completed' ORDER BY id DESC LIMIT 1",
  );
}

// ── Resolved Issues ──

export interface ResolvedIssueRow {
  id: number;
  analysis_id: number;
  category: string;
  item_index: number;
  run_id: number | null;
  piece_name: string | null;
  action_name: string | null;
  note: string;
  resolved_at: string;
}

export function resolveIssue(params: {
  analysis_id: number;
  category: string;
  item_index: number;
  run_id?: number;
  piece_name?: string;
  action_name?: string;
  note?: string;
}): ResolvedIssueRow {
  const result = getDb().run(`
    INSERT OR REPLACE INTO resolved_issues (analysis_id, category, item_index, run_id, piece_name, action_name, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    params.analysis_id, params.category, params.item_index,
    params.run_id ?? null, params.piece_name ?? null, params.action_name ?? null,
    params.note ?? '',
  ]);
  return getDb().get<ResolvedIssueRow>('SELECT * FROM resolved_issues WHERE id = ?', [result.lastId])!;
}

export function unresolveIssue(analysisId: number, category: string, itemIndex: number): void {
  getDb().run(
    'DELETE FROM resolved_issues WHERE analysis_id = ? AND category = ? AND item_index = ?',
    [analysisId, category, itemIndex],
  );
}

export function getResolvedIssues(analysisId: number): ResolvedIssueRow[] {
  return getDb().all<ResolvedIssueRow>(
    'SELECT * FROM resolved_issues WHERE analysis_id = ? ORDER BY resolved_at DESC',
    [analysisId],
  );
}

export function updateResolvedIssueNote(id: number, note: string): void {
  getDb().run('UPDATE resolved_issues SET note = ? WHERE id = ?', [note, id]);
}

export function deletePlanRun(id: number): boolean {
  return getDb().run('DELETE FROM test_plan_runs WHERE id = ?', [id]).changes > 0;
}

export function deleteAllPlanRuns(before?: string): number {
  if (before) {
    return getDb().run('DELETE FROM test_plan_runs WHERE started_at < ?', [before]).changes;
  }
  return getDb().run('DELETE FROM test_plan_runs').changes;
}

// ── AI Usage Tracking ──

export interface AiUsageRow {
  id: number;
  session_id: string;
  piece_name: string;
  action_name: string;
  agent_role: string;
  agent_version: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  operation: string;
  created_at: string;
}

export function logAiUsage(params: {
  session_id: string;
  piece_name: string;
  action_name: string;
  agent_role: string;
  agent_version: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost_usd: number;
  operation: string;
}): void {
  getDb().run(
    `INSERT INTO ai_usage_logs (session_id, piece_name, action_name, agent_role, agent_version, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, operation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.session_id, params.piece_name, params.action_name,
      params.agent_role, params.agent_version, params.model,
      params.input_tokens, params.output_tokens,
      params.cache_creation_input_tokens || 0, params.cache_read_input_tokens || 0,
      params.cost_usd, params.operation,
    ],
  );
}

export function getAiUsageSummary(filters?: { piece_name?: string; date_from?: string; date_to?: string }): {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_requests: number;
  by_version: { version: string; cost_usd: number; requests: number }[];
  by_operation: { operation: string; cost_usd: number; requests: number }[];
} {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filters?.piece_name) { where.push('piece_name = ?'); vals.push(filters.piece_name); }
  if (filters?.date_from) { where.push('created_at >= ?'); vals.push(filters.date_from); }
  if (filters?.date_to) { where.push('created_at <= ?'); vals.push(filters.date_to); }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const totals = getDb().get<{ total_cost: number; total_input: number; total_output: number; total_reqs: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(input_tokens), 0) as total_input,
     COALESCE(SUM(output_tokens), 0) as total_output, COUNT(*) as total_reqs
     FROM ai_usage_logs ${whereClause}`, vals,
  )!;

  const byVersion = getDb().all<{ version: string; cost_usd: number; requests: number }>(
    `SELECT agent_version as version, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as requests
     FROM ai_usage_logs ${whereClause} GROUP BY agent_version`, vals,
  );

  const byOperation = getDb().all<{ operation: string; cost_usd: number; requests: number }>(
    `SELECT operation, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as requests
     FROM ai_usage_logs ${whereClause} GROUP BY operation`, vals,
  );

  return {
    total_cost_usd: totals.total_cost,
    total_input_tokens: totals.total_input,
    total_output_tokens: totals.total_output,
    total_requests: totals.total_reqs,
    by_version: byVersion,
    by_operation: byOperation,
  };
}

export function getAiUsageBySession(sessionId: string): AiUsageRow[] {
  return getDb().all<AiUsageRow>(
    'SELECT * FROM ai_usage_logs WHERE session_id = ? ORDER BY created_at ASC',
    [sessionId],
  );
}

export function getAiUsageByPiece(pieceName: string, limit = 50): AiUsageRow[] {
  return getDb().all<AiUsageRow>(
    'SELECT * FROM ai_usage_logs WHERE piece_name = ? ORDER BY created_at DESC LIMIT ?',
    [pieceName, limit],
  );
}

export function getAiUsageRecent(limit = 100): AiUsageRow[] {
  return getDb().all<AiUsageRow>(
    'SELECT * FROM ai_usage_logs ORDER BY created_at DESC LIMIT ?',
    [limit],
  );
}

export function updatePlanRun(id: number, updates: Partial<{
  status: string;
  current_step_id: string | null;
  step_results: string;
  paused_prompt: string | null;
  completed_at: string | null;
}>): TestPlanRunRow | undefined {
  const current = getPlanRun(id);
  if (!current) return undefined;
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return current;
  values.push(id);
  getDb().run(`UPDATE test_plan_runs SET ${fields.join(', ')} WHERE id = ?`, values);
  return getPlanRun(id);
}

// ── Coverage cockpit ─────────────────────────────────────────────────────────
// A piece-centric view over the whole catalog: is each piece under continuous
// testing (covered) and what's its readiness/health. Statuses are DERIVED from
// existing tables (connections, enabled schedules' targets, approved plans,
// piece health) — nothing new is stored. Enrollment maps onto the existing
// `schedules` table using "one schedule per cadence": each distinct cadence
// (schedule_config + timezone) is a single schedule row, and pieces are members
// of it via wildcard `{ piece_name }` targets.

export interface CoverageCadence {
  label: string;
  cron: string;
  config: unknown;      // parsed schedule_config
  timezone: string;
}

export interface CoverageRow {
  piece_name: string;
  display_name: string;
  logo_url: string | null;
  connected: boolean;
  requires_auth: boolean; // piece declares an auth/connection; if false it runs without one
  covered: boolean;
  schedule_id: number | null;
  cadence: CoverageCadence | null;
  has_plans: boolean;
  plan_count: number;
  planned_targets: number; // # of the piece's actions/triggers that have an APPROVED plan
  total_targets: number;   // # of actions + triggers the piece exposes (from the catalog)
  health: 'failing' | 'blocked' | 'healthy' | 'unknown' | null; // null = never run
  actions_failing: number;
  last_run_at: string | null;
  last_run_id: number | null; // latest SCHEDULED run for the piece (for the Runs deep-link)
}

/** A cadence payload sent by the client (already turned into cron + config). */
export interface CadenceInput {
  cron_expression: string;
  schedule_config: string; // JSON string
  timezone: string;
  label: string;
}

function parseTargetsJson(raw: string): ScheduleTarget[] {
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
  catch { return []; }
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Build the coverage rows for the given catalog (piece list fetched from AP).
 * Kept as a pure DB read so it can be unit-tested against fixtures.
 */
export function getCoverage(
  catalog: { name: string; displayName: string; logoUrl?: string | null; actions?: number; triggers?: number; hasAuth?: boolean }[],
): CoverageRow[] {
  const db = getDb();

  const connected = new Set(listConnections().map(c => c.piece_name));

  // Covered = piece appears as a target in an ENABLED schedule. An enabled
  // schedule with EMPTY targets means "all pieces" (legacy) — track it separately.
  const coverMap = new Map<string, { schedule_id: number; cadence: CoverageCadence }>();
  let allPiecesSchedule: ScheduleRow | undefined;
  for (const s of listSchedules()) {
    if (!s.enabled) continue;
    const targets = parseTargetsJson(s.targets);
    if (targets.length === 0) { if (!allPiecesSchedule) allPiecesSchedule = s; continue; }
    const cadence: CoverageCadence = {
      label: s.label, cron: s.cron_expression, config: safeParse(s.schedule_config), timezone: s.timezone,
    };
    for (const t of targets) {
      if (!coverMap.has(t.piece_name)) coverMap.set(t.piece_name, { schedule_id: s.id, cadence });
    }
  }

  const allCadence: CoverageCadence | null = allPiecesSchedule
    ? { label: allPiecesSchedule.label, cron: allPiecesSchedule.cron_expression, config: safeParse(allPiecesSchedule.schedule_config), timezone: allPiecesSchedule.timezone }
    : null;

  // Approved plan counts per piece.
  const planRows = db.all<{ piece_name: string; c: number }>(
    `SELECT piece_name, COUNT(*) AS c FROM test_plans WHERE status = 'approved' GROUP BY piece_name`,
  );
  const planCount = new Map(planRows.map(r => [r.piece_name, r.c]));

  // Current health per piece (reused verbatim from the Health board).
  const healthMap = new Map(getPieceHealth().map(h => [h.piece_name, h]));

  // Latest SCHEDULED run per piece (max id = most recent) — used to deep-link the Runs feed.
  const lastRunRows = db.all<{ piece_name: string; last_run_id: number }>(`
    SELECT p.piece_name AS piece_name, MAX(r.id) AS last_run_id
    FROM test_plan_runs r JOIN test_plans p ON p.id = r.plan_id
    WHERE r.trigger_type = 'scheduled'
    GROUP BY p.piece_name
  `);
  const lastRunMap = new Map(lastRunRows.map(r => [r.piece_name, r.last_run_id]));

  return catalog.map(p => {
    const cover = coverMap.get(p.name);
    const covered = !!cover || !!allPiecesSchedule;
    const h = healthMap.get(p.name);
    const total = (p.actions ?? 0) + (p.triggers ?? 0);
    // "N/M planned" counts only APPROVED plans — the ones that actually run on a schedule.
    const rawPlanned = planCount.get(p.name) ?? 0;
    return {
      piece_name: p.name,
      display_name: p.displayName,
      logo_url: p.logoUrl ?? null,
      connected: connected.has(p.name),
      requires_auth: p.hasAuth ?? false,
      covered,
      schedule_id: cover ? cover.schedule_id : (covered && allPiecesSchedule ? allPiecesSchedule.id : null),
      cadence: cover ? cover.cadence : (covered ? allCadence : null),
      has_plans: (planCount.get(p.name) ?? 0) > 0,
      plan_count: planCount.get(p.name) ?? 0,
      planned_targets: total ? Math.min(rawPlanned, total) : rawPlanned,
      total_targets: total,
      health: h ? h.status : null,
      actions_failing: h ? h.actions_failing : 0,
      last_run_at: h ? h.last_run_at : null,
      last_run_id: lastRunMap.get(p.name) ?? null,
    };
  });
}

function normalizeConfig(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; }
}

/**
 * Find the single schedule that owns a given cadence, or create it.
 * Only schedules that already have explicit targets (i.e. cockpit-managed) are
 * reused — a legacy empty-targets "all pieces" schedule is never appended to.
 */
export function findOrCreateCadenceSchedule(cadence: CadenceInput): ScheduleRow {
  const wantConfig = normalizeConfig(cadence.schedule_config);
  const wantTz = cadence.timezone || 'UTC';
  const existing = listSchedules().find(s =>
    parseTargetsJson(s.targets).length > 0 &&
    normalizeConfig(s.schedule_config) === wantConfig &&
    (s.timezone || 'UTC') === wantTz,
  );
  if (existing) return existing;
  return createSchedule({
    cron_expression: cadence.cron_expression,
    label: cadence.label,
    timezone: cadence.timezone,
    schedule_config: cadence.schedule_config,
    targets: '[]',
  });
}

/** Add pieces (wildcard = all their approved plans) to the matching-cadence schedule. */
export function enrollPieces(pieceNames: string[], cadence: CadenceInput): void {
  const sched = findOrCreateCadenceSchedule(cadence);
  const targets = parseTargetsJson(sched.targets);
  const seen = new Set(targets.map(t => `${t.piece_name}|${t.action_name ?? ''}`));
  for (const name of pieceNames) {
    if (!seen.has(`${name}|`)) { targets.push({ piece_name: name }); seen.add(`${name}|`); }
  }
  updateSchedule(sched.id, { targets: JSON.stringify(targets), enabled: 1 });
}

/**
 * Remove pieces from every explicit-target schedule they belong to. A schedule
 * that would be left with ZERO targets is deleted rather than emptied, because
 * empty targets mean "all pieces" — emptying it would silently cover everything.
 */
export function unenrollPieces(pieceNames: string[]): void {
  const set = new Set(pieceNames);
  for (const s of listSchedules()) {
    const targets = parseTargetsJson(s.targets);
    if (targets.length === 0) continue; // never touch legacy all-pieces schedules
    const kept = targets.filter(t => !set.has(t.piece_name));
    if (kept.length === targets.length) continue; // nothing removed
    if (kept.length === 0) deleteSchedule(s.id);
    else updateSchedule(s.id, { targets: JSON.stringify(kept) });
  }
}

/** Move pieces to a new cadence: pull them out of their current schedule(s), then enroll. */
export function setPiecesCadence(pieceNames: string[], cadence: CadenceInput): void {
  unenrollPieces(pieceNames);
  enrollPieces(pieceNames, cadence);
}

/**
 * Counts for the Runs feed's coverage context: how many pieces are covered right now
 * (targets of an enabled schedule), and how many of those have no approved plans — so a
 * run can't actually test them.
 */
export function getCoverageCounts(): { covered_total: number; covered_untested: number } {
  const db = getDb();
  const covered = new Set<string>();
  for (const s of listSchedules()) {
    if (!s.enabled) continue;
    for (const t of parseTargetsJson(s.targets)) covered.add(t.piece_name);
  }
  if (covered.size === 0) return { covered_total: 0, covered_untested: 0 };
  const approved = new Set(
    db.all<{ piece_name: string }>(`SELECT DISTINCT piece_name FROM test_plans WHERE status = 'approved'`)
      .map(r => r.piece_name),
  );
  let untested = 0;
  for (const p of covered) if (!approved.has(p)) untested++;
  return { covered_total: covered.size, covered_untested: untested };
}

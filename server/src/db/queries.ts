import { getDb } from './schema.js';

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

export interface TestRunRow {
  id: number;
  trigger_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  total_tests: number;
  passed: number;
  failed: number;
  errors: number;
}

export function createTestRun(triggerType: string): TestRunRow {
  const result = getDb().run(`
    INSERT INTO test_runs (trigger_type, status, started_at)
    VALUES (?, 'running', datetime('now'))
  `, [triggerType]);
  return getTestRun(result.lastId)!;
}

export function getTestRun(id: number): TestRunRow | undefined {
  return getDb().get<TestRunRow>('SELECT * FROM test_runs WHERE id = ?', [id]);
}

export function listTestRuns(limit = 20, offset = 0): TestRunRow[] {
  return getDb().all<TestRunRow>(
    'SELECT * FROM test_runs ORDER BY id DESC LIMIT ? OFFSET ?',
    [limit, offset],
  );
}

export function updateTestRun(id: number, updates: Partial<Omit<TestRunRow, 'id'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(val);
  }
  if (fields.length === 0) return;
  values.push(id);
  getDb().run(`UPDATE test_runs SET ${fields.join(', ')} WHERE id = ?`, values);
}

// ── Test Results ──

export interface TestResultRow {
  id: number;
  run_id: number;
  piece_name: string;
  action_name: string;
  status: string;
  duration_ms: number;
  flow_run_id: string | null;
  error_message: string | null;
  created_at: string;
}

export function createTestResult(r: {
  run_id: number;
  piece_name: string;
  action_name: string;
  status: string;
  duration_ms: number;
  flow_run_id?: string;
  error_message?: string;
}): TestResultRow {
  const result = getDb().run(`
    INSERT INTO test_results (run_id, piece_name, action_name, status, duration_ms, flow_run_id, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [r.run_id, r.piece_name, r.action_name, r.status, r.duration_ms, r.flow_run_id ?? null, r.error_message ?? null]);
  return getDb().get<TestResultRow>('SELECT * FROM test_results WHERE id = ?', [result.lastId])!;
}

export function listTestResults(runId: number): TestResultRow[] {
  return getDb().all<TestResultRow>(
    'SELECT * FROM test_results WHERE run_id = ? ORDER BY id',
    [runId],
  );
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

export interface TestPlanRow {
  id: number;
  piece_name: string;
  target_action: string;
  steps: string;       // JSON array of TestPlanStep
  status: string;      // 'draft' | 'approved'
  agent_memory: string;
  automation_status: string; // 'fully_automated' | 'requires_human' | 'unknown'
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
  steps: string;
  status?: string;
  agent_memory?: string;
}): TestPlanRow {
  const db = getDb();
  return db.transaction(() => {
    const automationStatus = computeAutomationStatus(p.steps);
    const existing = getTestPlanByAction(p.piece_name, p.target_action);
    if (existing) {
      db.run(`
        UPDATE test_plans SET steps = ?, status = ?, agent_memory = ?, automation_status = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [p.steps, p.status || 'draft', p.agent_memory || '', automationStatus, existing.id]);
      return getTestPlan(existing.id)!;
    }
    const result = db.run(`
      INSERT INTO test_plans (piece_name, target_action, steps, status, agent_memory, automation_status)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [p.piece_name, p.target_action, p.steps, p.status || 'draft', p.agent_memory || '', automationStatus]);
    return getTestPlan(result.lastId)!;
  });
}

export function getTestPlan(id: number): TestPlanRow | undefined {
  return getDb().get<TestPlanRow>('SELECT * FROM test_plans WHERE id = ?', [id]);
}

export function getTestPlanByAction(pieceName: string, targetAction: string): TestPlanRow | undefined {
  return getDb().get<TestPlanRow>(
    'SELECT * FROM test_plans WHERE piece_name = ? AND target_action = ?',
    [pieceName, targetAction],
  );
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
  getDb().run(`
    UPDATE test_plans SET steps = ?, status = ?, agent_memory = ?, automation_status = ?, updated_at = datetime('now')
    WHERE id = ?
  `, [
    stepsJson,
    updates.status ?? current.status,
    updates.agent_memory ?? current.agent_memory,
    automationStatus,
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
}

export function createPlanRun(planId: number, triggerType: string = 'manual'): TestPlanRunRow {
  const result = getDb().run(`
    INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results)
    VALUES (?, 'running', ?, '[]')
  `, [planId, triggerType]);
  return getPlanRun(result.lastId)!;
}

export function getPlanRun(id: number): TestPlanRunRow | undefined {
  return getDb().get<TestPlanRunRow>('SELECT * FROM test_plan_runs WHERE id = ?', [id]);
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
      AVG(CASE WHEN completed_at IS NOT NULL
        THEN (julianday(completed_at) - julianday(started_at)) * 86400000
        ELSE NULL END) AS avg_duration_ms
    FROM test_plan_runs WHERE ${planWhere}
  `, planParams);

  const finished = (planStats.total || 0) - (planStats.running || 0);
  const successRate = finished > 0 ? Math.round(((planStats.passed || 0) / finished) * 100) : 0;

  return {
    total_plan_runs: planStats.total || 0,
    passed_plan_runs: planStats.passed || 0,
    failed_plan_runs: planStats.failed || 0,
    running_plan_runs: planStats.running || 0,
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
  if (dateFrom) {
    conditions.push('r.started_at >= ?');
    params.push(dateFrom);
  } else {
    conditions.push("r.started_at >= datetime('now', '-30 days')");
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
           r.status, r.step_results, r.started_at, r.completed_at, r.trigger_type
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

export function deleteTestRun(id: number): boolean {
  return getDb().run('DELETE FROM test_runs WHERE id = ?', [id]).changes > 0;
}

export function deleteAllTestRuns(before?: string): number {
  if (before) {
    return getDb().run('DELETE FROM test_runs WHERE started_at < ?', [before]).changes;
  }
  return getDb().run('DELETE FROM test_runs').changes;
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

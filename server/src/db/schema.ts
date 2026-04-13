import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DatabaseAdapter, SQLiteAdapter } from './adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DB_PATH = process.env.DB_PATH || path.resolve(PROJECT_ROOT, 'data/piece-tester.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let adapter: DatabaseAdapter;

export function getDb(): DatabaseAdapter {
  if (!adapter) {
    adapter = new SQLiteAdapter(DB_PATH);
    initTables(adapter);
  }
  return adapter;
}

function initTables(db: DatabaseAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_url TEXT NOT NULL DEFAULT 'https://cloud.activepieces.com/api',
      api_key TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      test_timeout_ms INTEGER NOT NULL DEFAULT 180000,
      jwt_token TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO settings (id, base_url, api_key, project_id)
    VALUES (1, 'https://cloud.activepieces.com/api', '', '');

    -- Bump old timeout for existing DBs
    UPDATE settings SET test_timeout_ms = 180000 WHERE id = 1 AND test_timeout_ms <= 60000;
  `);

  // Migration: add jwt_token column if missing (existing DBs won't have it)
  const cols = db.pragma(`table_info(settings)`) as { name: string }[];
  if (!cols.some(c => c.name === 'jwt_token')) {
    db.exec(`ALTER TABLE settings ADD COLUMN jwt_token TEXT NOT NULL DEFAULT ''`);
  }

  // Migration: add anthropic_api_key column if missing
  const cols2 = db.pragma(`table_info(settings)`) as { name: string }[];
  if (!cols2.some(c => c.name === 'anthropic_api_key')) {
    db.exec(`ALTER TABLE settings ADD COLUMN anthropic_api_key TEXT NOT NULL DEFAULT ''`);
  }

  // Migration: add ai_model column if missing
  if (!cols2.some(c => c.name === 'ai_model')) {
    db.exec(`ALTER TABLE settings ADD COLUMN ai_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5-20250929'`);
  }

  // Fix wrong model ID from earlier migration
  db.exec(`UPDATE settings SET ai_model = 'claude-sonnet-4-5-20250929' WHERE ai_model = 'claude-sonnet-4-5-20250514'`);

  // Upgrade to Claude Sonnet 4.6 for existing users
  db.exec(`UPDATE settings SET ai_model = 'claude-sonnet-4-6' WHERE ai_model = 'claude-sonnet-4-5-20250929'`);
  // Fix incorrect model ID saved with wrong date suffix
  db.exec(`UPDATE settings SET ai_model = 'claude-sonnet-4-6' WHERE ai_model = 'claude-sonnet-4-6-20260514'`);

  // Migration: add ai_config_meta column to piece_connections if missing
  const connCols = db.pragma(`table_info(piece_connections)`) as { name: string }[];
  // (table may not exist yet — the CREATE TABLE below creates it; run migration only if table exists)
  if (connCols.length > 0 && !connCols.some(c => c.name === 'ai_config_meta')) {
    db.exec(`ALTER TABLE piece_connections ADD COLUMN ai_config_meta TEXT DEFAULT '{}'`);
  }

  // Migration: add project_id and is_active columns, remove UNIQUE constraint on piece_name.
  // SQLite can't drop constraints, so we recreate the table if the old schema is detected.
  if (connCols.length > 0 && !connCols.some(c => c.name === 'project_id')) {
    const currentProjectId = db.get<{ project_id: string }>("SELECT project_id FROM settings WHERE id = 1")?.project_id ?? '';
    db.exec(`
      CREATE TABLE piece_connections_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        piece_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        connection_type TEXT NOT NULL,
        connection_value TEXT NOT NULL DEFAULT '{}',
        actions_config TEXT DEFAULT '{}',
        ai_config_meta TEXT DEFAULT '{}',
        project_id TEXT NOT NULL DEFAULT '',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO piece_connections_new
        (id, piece_name, display_name, connection_type, connection_value, actions_config, ai_config_meta, project_id, is_active, created_at, updated_at)
      SELECT id, piece_name, display_name, connection_type, connection_value, actions_config, COALESCE(ai_config_meta, '{}'), '${currentProjectId}', 1, created_at, updated_at
      FROM piece_connections;
      DROP TABLE piece_connections;
      ALTER TABLE piece_connections_new RENAME TO piece_connections;
    `);
  }

  db.exec(`

    CREATE TABLE IF NOT EXISTS piece_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piece_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      connection_type TEXT NOT NULL,
      connection_value TEXT NOT NULL DEFAULT '{}',
      actions_config TEXT DEFAULT '{}',
      ai_config_meta TEXT DEFAULT '{}',
      project_id TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      total_tests INTEGER DEFAULT 0,
      passed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
      piece_name TEXT NOT NULL,
      action_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER DEFAULT 0,
      flow_run_id TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piece_name TEXT,
      cron_expression TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      label TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      schedule_config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS test_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piece_name TEXT NOT NULL,
      target_action TEXT NOT NULL,
      steps TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      agent_memory TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(piece_name, target_action)
    );

    CREATE TABLE IF NOT EXISTS piece_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piece_name TEXT NOT NULL,
      lesson TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'fix',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS test_plan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      current_step_id TEXT,
      step_results TEXT NOT NULL DEFAULT '[]',
      paused_prompt TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS report_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      time_range TEXT NOT NULL DEFAULT 'all',
      date_from TEXT,
      date_to TEXT,
      summary TEXT NOT NULL DEFAULT '',
      categories TEXT NOT NULL DEFAULT '{}',
      recommendations TEXT NOT NULL DEFAULT '[]',
      health_score INTEGER DEFAULT 0,
      piece_issues_count INTEGER DEFAULT 0,
      test_issues_count INTEGER DEFAULT 0,
      transient_count INTEGER DEFAULT 0,
      unknown_count INTEGER DEFAULT 0,
      logs TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS resolved_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      run_id INTEGER,
      piece_name TEXT,
      action_name TEXT,
      note TEXT DEFAULT '',
      resolved_at TEXT DEFAULT (datetime('now')),
      UNIQUE(analysis_id, category, item_index)
    );
  `);

  // Migration: add new columns to report_analyses if missing (existing DBs)
  const raCols = db.pragma(`table_info(report_analyses)`) as { name: string }[];
  if (raCols.length > 0 && !raCols.some(c => c.name === 'status')) {
    db.exec(`ALTER TABLE report_analyses ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'`);
  }
  if (raCols.length > 0 && !raCols.some(c => c.name === 'time_range')) {
    db.exec(`ALTER TABLE report_analyses ADD COLUMN time_range TEXT NOT NULL DEFAULT 'all'`);
  }
  if (raCols.length > 0 && !raCols.some(c => c.name === 'date_from')) {
    db.exec(`ALTER TABLE report_analyses ADD COLUMN date_from TEXT`);
  }
  if (raCols.length > 0 && !raCols.some(c => c.name === 'date_to')) {
    db.exec(`ALTER TABLE report_analyses ADD COLUMN date_to TEXT`);
  }
  if (raCols.length > 0 && !raCols.some(c => c.name === 'logs')) {
    db.exec(`ALTER TABLE report_analyses ADD COLUMN logs TEXT NOT NULL DEFAULT '[]'`);
  }
  if (raCols.length > 0 && !raCols.some(c => c.name === 'error_message')) {
    db.exec(`ALTER TABLE report_analyses ADD COLUMN error_message TEXT`);
  }
  if (raCols.length > 0 && !raCols.some(c => c.name === 'completed_at')) {
    db.exec(`ALTER TABLE report_analyses ADD COLUMN completed_at TEXT`);
  }

  // Migration: add label, timezone, schedule_config, targets columns to schedules if missing
  const schedCols = db.pragma(`table_info(schedules)`) as { name: string }[];
  if (schedCols.length > 0 && !schedCols.some(c => c.name === 'label')) {
    db.exec(`ALTER TABLE schedules ADD COLUMN label TEXT NOT NULL DEFAULT ''`);
  }
  if (schedCols.length > 0 && !schedCols.some(c => c.name === 'timezone')) {
    db.exec(`ALTER TABLE schedules ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`);
  }
  if (schedCols.length > 0 && !schedCols.some(c => c.name === 'schedule_config')) {
    db.exec(`ALTER TABLE schedules ADD COLUMN schedule_config TEXT NOT NULL DEFAULT '{}'`);
  }
  if (schedCols.length > 0 && !schedCols.some(c => c.name === 'targets')) {
    db.exec(`ALTER TABLE schedules ADD COLUMN targets TEXT NOT NULL DEFAULT '[]'`);
  }

  // Migration: add trigger_type column to test_plan_runs if missing
  const planRunCols = db.pragma(`table_info(test_plan_runs)`) as { name: string }[];
  if (planRunCols.length > 0 && !planRunCols.some(c => c.name === 'trigger_type')) {
    db.exec(`ALTER TABLE test_plan_runs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'manual'`);
  }

  // Migration: add automation_status column to test_plans if missing
  const planCols = db.pragma(`table_info(test_plans)`) as { name: string }[];
  if (planCols.length > 0 && !planCols.some(c => c.name === 'automation_status')) {
    db.exec(`ALTER TABLE test_plans ADD COLUMN automation_status TEXT NOT NULL DEFAULT 'unknown'`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      piece_name TEXT NOT NULL DEFAULT '',
      action_name TEXT NOT NULL DEFAULT '',
      agent_role TEXT NOT NULL DEFAULT '',
      agent_version TEXT NOT NULL DEFAULT 'v1',
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      operation TEXT NOT NULL DEFAULT 'create',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

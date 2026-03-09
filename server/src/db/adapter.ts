import Database from 'better-sqlite3';

export interface RunResult {
  changes: number;
  lastId: number;
}

/**
 * Synchronous database adapter — the only layer that touches the DB driver.
 *
 * Currently backed by SQLite (better-sqlite3).  To migrate to PostgreSQL:
 *
 *   1. Implement AsyncDatabaseAdapter (below) with pg / postgres.js
 *   2. Convert all functions in queries.ts to async / await
 *   3. Update Express route handlers to await queries
 *   4. Adjust SQL dialect:
 *        INTEGER PRIMARY KEY AUTOINCREMENT  →  SERIAL PRIMARY KEY
 *        datetime('now')                    →  NOW()
 *        julianday(x)                       →  EXTRACT(EPOCH FROM x)
 *        TEXT JSON columns                  →  JSONB
 *        INSERT OR REPLACE                  →  INSERT … ON CONFLICT … DO UPDATE
 *        INSERT OR IGNORE                   →  INSERT … ON CONFLICT DO NOTHING
 *        PRAGMA table_info(…)               →  information_schema.columns
 */
export interface DatabaseAdapter {
  run(sql: string, params?: unknown[]): RunResult;
  get<T = any>(sql: string, params?: unknown[]): T | undefined;
  all<T = any>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  pragma(directive: string): unknown;
  close(): void;
}

/**
 * Async counterpart for a future PostgreSQL (or any async driver) migration.
 * Method signatures mirror DatabaseAdapter but return Promises.
 */
export interface AsyncDatabaseAdapter {
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  get<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * SQLite implementation with concurrency mitigations:
 *
 *  • WAL journal   — readers never block writers (and vice-versa for reads)
 *  • busy_timeout   — waits up to N ms for a write-lock instead of throwing SQLITE_BUSY
 *  • synchronous = NORMAL — safe with WAL, cuts fsync overhead on every commit
 *  • Statement cache — avoids re-preparing the same SQL on every call
 *  • Explicit transactions — groups multi-statement writes into atomic units
 */
export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database;
  private stmtCache = new Map<string, Database.Statement>();

  constructor(dbPath: string, options?: { busyTimeout?: number }) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma(`busy_timeout = ${options?.busyTimeout ?? 5000}`);
    this.db.pragma('synchronous = NORMAL');
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const result = this.stmt(sql).run(...params);
    return { changes: result.changes, lastId: Number(result.lastInsertRowid) };
  }

  get<T = any>(sql: string, params: unknown[] = []): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = any>(sql: string, params: unknown[] = []): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  pragma(directive: string): unknown {
    return this.db.pragma(directive);
  }

  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }
}

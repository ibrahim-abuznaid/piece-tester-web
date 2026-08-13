import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/src/**/*.test.ts'],
    passWithNoTests: true,
    // better-sqlite3 is a native addon — run tests in forked processes, not worker
    // threads, to avoid native-module-in-worker issues.
    pool: 'forks',
    // Isolate tests from the real dev DB (schema.ts reads DB_PATH at import time).
    // data/*.db is already gitignored.
    env: {
      DB_PATH: './data/test.db',
    },
  },
});

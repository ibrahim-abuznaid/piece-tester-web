import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/schema.js';
import { initScheduler } from './services/scheduler.js';
import { initFlowReaper } from './services/flow-reaper.js';
import { reconcileOrphanedRuns } from './db/queries.js';
import settingsRoutes from './routes/settings.js';
import piecesRoutes from './routes/pieces.js';
import connectionsRoutes from './routes/connections.js';
import schedulesRoutes from './routes/schedules.js';
import testPlansRoutes from './routes/test-plans.js';
import reportsRoutes from './routes/reports.js';
import batchSetupRoutes from './routes/batch-setup.js';
import coverageRoutes from './routes/coverage.js';
import authRoutes from './routes/auth.js';
import { requireAuth, assertAuthConfig } from './middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '4000');
const HOST = process.env.HOST ?? '0.0.0.0';

const app = express();
// No reverse proxy in front of this app — treat the socket peer as the authoritative client IP.
app.set('trust proxy', false);
app.use(express.json({ limit: '10mb' }));

// ── Health check (before all other routes) ──
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── Auth (public: login/logout/status) ──
app.use('/api/auth', authRoutes);

// ── Everything else under /api requires a valid session ──
app.use('/api', requireAuth);

// ── API Routes ──
app.use('/api/settings', settingsRoutes);
app.use('/api/pieces', piecesRoutes);
app.use('/api/connections', connectionsRoutes);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/test-plans', testPlansRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/batch-setup', batchSetupRoutes);
app.use('/api/coverage', coverageRoutes);

// ── Serve React client in production ──
const clientDist = path.resolve(__dirname, '../../dist/client');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// ── Start ──
const db = getDb();
assertAuthConfig();
console.log('[server] Database initialized');

let backgroundStarted = false;
function startBackgroundWork() {
  if (backgroundStarted) return;
  backgroundStarted = true;

  // Any run still `running` at boot is from a dead process — close it out honestly.
  const reconciled = reconcileOrphanedRuns();
  if (reconciled > 0) console.log(`[server] Reconciled ${reconciled} orphaned run(s) → interrupted`);

  initScheduler();
  initFlowReaper();
}

function startServer(port: number, retries = 3) {
  const server = app.listen(port, HOST, () => {
    console.log(`[server] Piece Tester running at http://${HOST}:${port}`);
    startBackgroundWork();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`[server] Port ${port} in use — retrying in 3s (${retries} attempts left)`);
      server.close();
      setTimeout(() => startServer(port, retries - 1), 3000);
    } else {
      console.error('[server] Fatal listen error:', err.message);
      process.exit(1);
    }
  });

  // ── Graceful shutdown ──
  function shutdown(signal: string) {
    console.log(`[server] ${signal} received — shutting down gracefully`);
    server.close(() => {
      db.close();
      console.log('[server] Closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[server] Forceful shutdown after timeout');
      process.exit(1);
    }, 10_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

startServer(PORT);

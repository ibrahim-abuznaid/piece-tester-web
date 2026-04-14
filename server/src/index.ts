import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/schema.js';
import { initScheduler } from './services/scheduler.js';
import settingsRoutes from './routes/settings.js';
import piecesRoutes from './routes/pieces.js';
import connectionsRoutes from './routes/connections.js';
import testsRoutes from './routes/tests.js';
import historyRoutes from './routes/history.js';
import schedulesRoutes from './routes/schedules.js';
import testPlansRoutes from './routes/test-plans.js';
import reportsRoutes from './routes/reports.js';
import batchSetupRoutes from './routes/batch-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '4000');
const HOST = process.env.HOST ?? '0.0.0.0';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Health check (before all other routes) ──
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── API Routes ──
app.use('/api/settings', settingsRoutes);
app.use('/api/pieces', piecesRoutes);
app.use('/api/connections', connectionsRoutes);
app.use('/api/tests', testsRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/test-plans', testPlansRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/batch-setup', batchSetupRoutes);

// ── Serve React client in production ──
const clientDist = path.resolve(__dirname, '../../dist/client');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// ── Start ──
const db = getDb();
console.log('[server] Database initialized');

initScheduler();

function startServer(port: number, retries = 3) {
  const server = app.listen(port, HOST, () => {
    console.log(`[server] Piece Tester running at http://${HOST}:${port}`);
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

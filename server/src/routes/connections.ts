import { Router } from 'express';
import * as db from '../db/queries.js';
import { createClient } from '../services/test-engine.js';
import { ActivepiecesClient } from '../services/ap-client.js';
import { getSettings } from '../db/queries.js';

const router = Router();

// List local connections (filtered to current project, includes active + inactive)
router.get('/', (_req, res) => {
  const connections = db.listAllProjectConnections();
  const safe = connections.map(c => ({
    ...c,
    connection_value: '***',
    actions_config: safeParseJson(c.actions_config),
    ai_config_meta: safeParseJson(c.ai_config_meta || '{}'),
  }));
  res.json(safe);
});

// List all connections for a specific piece (current project)
router.get('/piece/:pieceName', (req, res) => {
  const connections = db.listConnectionsForPiece(req.params.pieceName);
  const safe = connections.map(c => ({
    ...c,
    connection_value: '***',
    actions_config: safeParseJson(c.actions_config),
    ai_config_meta: safeParseJson(c.ai_config_meta || '{}'),
  }));
  res.json(safe);
});

// Fetch connections from AP cloud
router.get('/remote', async (_req, res) => {
  try {
    const client = createClient();
    const remote = await client.listConnections();
    res.json(remote);
  } catch (err) {
    res.status(500).json({ error: ActivepiecesClient.formatError(err) });
  }
});

// Fetch remote connections filtered by piece name
router.get('/remote/:pieceName', async (req, res) => {
  try {
    const client = createClient();
    const remote = await client.listConnections();
    const filtered = remote.filter(c => c.pieceName === req.params.pieceName);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: ActivepiecesClient.formatError(err) });
  }
});

// Import a remote connection from AP cloud into local DB
router.post('/import', async (req, res) => {
  try {
    const { pieceName, remoteConnectionId, displayName, connectionType } = req.body;
    if (!pieceName || !remoteConnectionId) {
      return res.status(400).json({ error: 'pieceName and remoteConnectionId are required' });
    }

    // New connection becomes active (createConnection deactivates existing ones)
    const conn = db.createConnection({
      piece_name: pieceName,
      display_name: displayName || pieceName,
      connection_type: connectionType || 'IMPORTED',
      connection_value: JSON.stringify({ _imported: true, remote_id: remoteConnectionId }),
      actions_config: '{}',
    });
    res.status(201).json({ ...conn, connection_value: '***' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Activate a connection (deactivates others for same piece+project)
router.post('/:id/activate', (req, res) => {
  const id = parseInt(req.params.id);
  const conn = db.activateConnection(id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  res.json({ ...conn, connection_value: '***' });
});

// Get the AP dashboard URL for creating connections
router.get('/ap-dashboard-url', (_req, res) => {
  const s = getSettings();
  // Derive the dashboard URL from the API base URL
  // e.g. "https://cloud.activepieces.com/api" -> "https://cloud.activepieces.com"
  const dashboardUrl = s.base_url.replace(/\/api\/?$/, '');
  res.json({ dashboardUrl, projectId: s.project_id });
});

// Create (new connection becomes active; previous ones for the same piece are deactivated)
router.post('/', (req, res) => {
  try {
    const { piece_name, display_name, connection_type, connection_value, actions_config } = req.body;
    if (!piece_name || !connection_type) {
      return res.status(400).json({ error: 'piece_name and connection_type are required' });
    }
    const conn = db.createConnection({
      piece_name,
      display_name: display_name || piece_name,
      connection_type,
      connection_value: typeof connection_value === 'string' ? connection_value : JSON.stringify(connection_value ?? {}),
      actions_config: typeof actions_config === 'string' ? actions_config : JSON.stringify(actions_config ?? {}),
    });
    res.status(201).json({ ...conn, connection_value: '***' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const updates: Record<string, any> = {};
  if (req.body.display_name) updates.display_name = req.body.display_name;
  if (req.body.connection_type) updates.connection_type = req.body.connection_type;
  if (req.body.connection_value !== undefined) {
    updates.connection_value = typeof req.body.connection_value === 'string' ? req.body.connection_value : JSON.stringify(req.body.connection_value);
  }
  if (req.body.actions_config !== undefined) {
    updates.actions_config = typeof req.body.actions_config === 'string' ? req.body.actions_config : JSON.stringify(req.body.actions_config);
  }

  const conn = db.updateConnection(id, updates);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  res.json({ ...conn, connection_value: '***' });
});

// Save a single action's config + AI metadata (merge, don't replace)
router.patch('/:id/action/:actionName', (req, res) => {
  const id = parseInt(req.params.id);
  const actionName = req.params.actionName;
  const conn = db.getConnection(id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  // Merge input into actions_config
  const actionsConfig = safeParseJson(conn.actions_config);
  if (req.body.input !== undefined) {
    actionsConfig[actionName] = req.body.input;
  }

  // Merge AI metadata
  const aiMeta = safeParseJson(conn.ai_config_meta || '{}');
  if (req.body.ai_meta !== undefined) {
    aiMeta[actionName] = req.body.ai_meta;
  }

  // Save enabled state
  if (req.body.enabled !== undefined) {
    if (!aiMeta[actionName]) aiMeta[actionName] = {};
    aiMeta[actionName].enabled = req.body.enabled;
  }

  const updated = db.updateConnection(id, {
    actions_config: JSON.stringify(actionsConfig),
    ai_config_meta: JSON.stringify(aiMeta),
  });
  res.json({ success: true, actions_config: actionsConfig, ai_config_meta: aiMeta });
});

// Bulk save enabled actions (for toggling multiple)
router.patch('/:id/actions-bulk', (req, res) => {
  const id = parseInt(req.params.id);
  const conn = db.getConnection(id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const updates: Record<string, any> = {};

  if (req.body.actions_config !== undefined) {
    updates.actions_config = typeof req.body.actions_config === 'string'
      ? req.body.actions_config
      : JSON.stringify(req.body.actions_config);
  }

  if (req.body.ai_config_meta !== undefined) {
    updates.ai_config_meta = typeof req.body.ai_config_meta === 'string'
      ? req.body.ai_config_meta
      : JSON.stringify(req.body.ai_config_meta);
  }

  const updated = db.updateConnection(id, updates);
  if (!updated) return res.status(404).json({ error: 'Connection not found' });
  res.json({ success: true });
});

// Delete
router.delete('/:id', (req, res) => {
  const ok = db.deleteConnection(parseInt(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Connection not found' });
  res.json({ success: true });
});

function safeParseJson(s: string) {
  try { return JSON.parse(s); } catch { return {}; }
}

export default router;

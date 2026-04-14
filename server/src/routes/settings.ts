import { Router } from 'express';
import { getSettings, updateSettings, getAiUsageSummary, getAiUsageBySession, getAiUsageByPiece, getAiUsageRecent } from '../db/queries.js';
import { ActivepiecesClient } from '../services/ap-client.js';

const router = Router();

router.get('/', (_req, res) => {
  const s = getSettings();
  res.json({
    ...s,
    api_key_masked: s.api_key ? s.api_key.slice(0, 6) + '...' + s.api_key.slice(-4) : '',
    has_jwt: !!s.jwt_token,
    has_anthropic_key: !!s.anthropic_api_key,
    anthropic_key_masked: s.anthropic_api_key ? s.anthropic_api_key.slice(0, 10) + '...' + s.anthropic_api_key.slice(-4) : '',
    has_mcp_token: !!s.mcp_token,
    mcp_token_masked: s.mcp_token ? '...' + s.mcp_token.slice(-8) : '',
  });
});

router.put('/', (req, res) => {
  try {
    const updated = updateSettings(req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Test the connection by calling GET /v1/pieces
router.post('/test-connection', async (req, res) => {
  const s = getSettings();
  const baseUrl = req.body.base_url ?? s.base_url;
  const apiKey = req.body.api_key ?? s.api_key;
  const projectId = req.body.project_id ?? s.project_id;

  if (!apiKey || !projectId) {
    return res.status(400).json({ error: 'API key and project ID are required' });
  }

  try {
    const client = new ActivepiecesClient(baseUrl, apiKey, projectId);
    const pieces = await client.listPieces();
    res.json({ success: true, pieceCount: pieces.length });
  } catch (err) {
    res.status(400).json({ success: false, error: ActivepiecesClient.formatError(err) });
  }
});

/**
 * Sign in to Activepieces with email/password to get a JWT token.
 * The JWT is needed for the test-step endpoint (which requires a user principal).
 * Without it, testing falls back to the unreliable webhook approach.
 */
router.post('/sign-in', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const s = getSettings();
  try {
    const result = await ActivepiecesClient.signIn(s.base_url, email, password);
    // Save the JWT token
    updateSettings({ jwt_token: result.token });
    res.json({ success: true, message: 'Signed in successfully. JWT token saved.' });
  } catch (err) {
    res.status(400).json({ success: false, error: ActivepiecesClient.formatError(err) });
  }
});

/**
 * Save a manually-pasted JWT token.
 * This is for SSO / Google users who can't use email/password sign-in.
 * They can copy the token from the AP dashboard browser DevTools.
 */
router.post('/save-token', async (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'Token is required' });
  }

  // Quick validation: try using the token to call a user-only endpoint
  const s = getSettings();
  try {
    const client = new ActivepiecesClient(s.base_url, s.api_key, s.project_id, token.trim());
    // Verify it works by making a lightweight call
    await client.listPieces();
    updateSettings({ jwt_token: token.trim() });
    res.json({ success: true, message: 'Token saved and verified successfully.' });
  } catch (err) {
    // Still save it – the token might work for test-step even if listPieces fails
    // But warn the user
    updateSettings({ jwt_token: token.trim() });
    res.json({ success: true, message: 'Token saved (could not fully verify – it may still work for testing).' });
  }
});

/** Clear the stored JWT token */
router.post('/sign-out', (_req, res) => {
  updateSettings({ jwt_token: '' });
  res.json({ success: true });
});

/** Save Anthropic API key */
router.post('/save-anthropic-key', async (req, res) => {
  const { api_key, model } = req.body;
  if (!api_key || !api_key.trim()) {
    return res.status(400).json({ error: 'API key is required' });
  }

  // Validate the key by making a small API call
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: api_key.trim() });
    await client.messages.create({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say "ok"' }],
    });
    updateSettings({ anthropic_api_key: api_key.trim(), ai_model: model || 'claude-sonnet-4-6' });
    res.json({ success: true, message: 'Anthropic API key saved and verified.' });
  } catch (err: any) {
    // Still save if it might be a transient issue
    const msg = err?.message || String(err);
    if (msg.includes('401') || msg.includes('authentication') || msg.includes('invalid')) {
      res.status(400).json({ success: false, error: `Invalid API key: ${msg}` });
    } else {
      updateSettings({ anthropic_api_key: api_key.trim(), ai_model: model || 'claude-sonnet-4-6' });
      res.json({ success: true, message: `Key saved (verification warning: ${msg})` });
    }
  }
});

/** Remove Anthropic API key */
router.post('/remove-anthropic-key', (_req, res) => {
  updateSettings({ anthropic_api_key: '' });
  res.json({ success: true });
});

/** Save Activepieces MCP token */
router.post('/save-mcp-token', async (req, res) => {
  const { mcp_token } = req.body;
  if (!mcp_token || !mcp_token.trim()) {
    return res.status(400).json({ error: 'MCP token is required' });
  }

  const s = getSettings();
  const mcpUrl = s.base_url.replace(/\/api$/, '/mcp');

  try {
    // Validate by calling tools/list on the MCP server
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mcp_token.trim()}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    if (!response.ok) {
      return res.status(400).json({ success: false, error: `MCP server returned ${response.status}: ${await response.text()}` });
    }

    const data = await response.json() as any;
    if (data.error) {
      return res.status(400).json({ success: false, error: `MCP error: ${data.error.message}` });
    }

    const toolCount = data.result?.tools?.length ?? 0;
    updateSettings({ mcp_token: mcp_token.trim() });
    res.json({ success: true, message: `MCP token saved. ${toolCount} tools available.` });
  } catch (err: any) {
    res.status(400).json({ success: false, error: `Failed to connect to MCP server: ${err.message}` });
  }
});

/** Remove MCP token */
router.post('/remove-mcp-token', (_req, res) => {
  updateSettings({ mcp_token: '' });
  res.json({ success: true });
});

// ── AI Cost Tracking Routes ──

router.get('/ai-costs', (req, res) => {
  try {
    const summary = getAiUsageSummary({
      piece_name: req.query.piece_name as string | undefined,
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
    });
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ai-costs/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const rows = getAiUsageRecent(limit);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ai-costs/session/:sessionId', (req, res) => {
  try {
    const rows = getAiUsageBySession(req.params.sessionId);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ai-costs/piece/:pieceName', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const rows = getAiUsageByPiece(req.params.pieceName, limit);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

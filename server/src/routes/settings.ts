import crypto from 'crypto';
import { Router } from 'express';
import { getSettings, updateSettings, getAiUsageSummary, getAiUsageBySession, getAiUsageByPiece, getAiUsageRecent } from '../db/queries.js';
import { ActivepiecesClient } from '../services/ap-client.js';

// ── MCP OAuth constants ──
const MCP_OAUTH_AUTHORIZE_URL = 'https://mcp.activepieces.com/authorize';
const MCP_OAUTH_TOKEN_URL = 'https://mcp.activepieces.com/token';
const MCP_OAUTH_REGISTER_URL = 'https://mcp.activepieces.com/register';

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function buildCallbackUrl(req: any): string {
  // Derive callback URL from incoming request host
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost:3000';
  return `${proto}://${host}/api/settings/mcp-callback`;
}

/** Refresh MCP access token if expired or near-expiry. Returns fresh access token. */
export async function refreshMcpTokenIfNeeded(): Promise<string> {
  const s = getSettings();
  if (!s.mcp_access_token) throw new Error('MCP not connected via OAuth');

  const expiry = s.mcp_token_expiry ? new Date(s.mcp_token_expiry) : null;
  const needsRefresh = !expiry || expiry.getTime() - Date.now() < 5 * 60 * 1000; // 5 min buffer

  if (!needsRefresh) return s.mcp_access_token;

  if (!s.mcp_refresh_token || !s.mcp_client_id) {
    throw new Error('MCP token expired and no refresh token available. Please reconnect.');
  }

  const res = await fetch(MCP_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: s.mcp_refresh_token,
      client_id: s.mcp_client_id,
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MCP token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as any;
  const newExpiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  updateSettings({
    mcp_access_token: data.access_token,
    mcp_refresh_token: data.refresh_token || s.mcp_refresh_token,
    mcp_token_expiry: newExpiry,
  });
  return data.access_token;
}

const router = Router();

router.get('/', (_req, res) => {
  const s = getSettings();
  res.json({
    ...s,
    api_key_masked: s.api_key ? s.api_key.slice(0, 6) + '...' + s.api_key.slice(-4) : '',
    has_jwt: !!s.jwt_token,
    has_anthropic_key: !!s.anthropic_api_key,
    anthropic_key_masked: s.anthropic_api_key ? s.anthropic_api_key.slice(0, 10) + '...' + s.anthropic_api_key.slice(-4) : '',
    // MCP: OAuth takes priority over legacy token
    has_mcp_token: !!(s.mcp_access_token || s.mcp_token),
    mcp_connected_via_oauth: !!s.mcp_access_token,
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

/**
 * Step 1 of MCP OAuth flow: register a dynamic client and redirect to Activepieces authorization.
 * The browser navigates directly to this URL (GET), which performs a server-side redirect.
 */
router.get('/mcp-connect', async (req, res) => {
  try {
    const callbackUrl = buildCallbackUrl(req);

    // Dynamic client registration (RFC 7591) — public client, PKCE only
    const regRes = await fetch(MCP_OAUTH_REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'piece-tester-web',
        redirect_uris: [callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // public PKCE client
      }),
    });

    if (!regRes.ok) {
      const body = await regRes.text();
      return res.status(502).send(`OAuth client registration failed: ${body}`);
    }
    const reg = await regRes.json() as any;
    const clientId: string = reg.client_id;

    // Generate PKCE
    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('base64url');

    // Save transient OAuth state
    updateSettings({
      mcp_client_id: clientId,
      mcp_pkce_verifier: verifier,
      mcp_oauth_state: state,
    });

    const authUrl = new URL(MCP_OAUTH_AUTHORIZE_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('scope', 'mcp');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    res.redirect(authUrl.toString());
  } catch (err: any) {
    res.status(500).send(`MCP OAuth connect error: ${err.message}`);
  }
});

/**
 * Step 2 of MCP OAuth flow: exchange authorization code for tokens.
 * Activepieces redirects here after the user approves.
 */
router.get('/mcp-callback', async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    return res.redirect(`/#/settings?mcp_error=${encodeURIComponent(error_description || error)}`);
  }

  const s = getSettings();

  // CSRF check
  if (!state || state !== s.mcp_oauth_state) {
    return res.redirect(`/#/settings?mcp_error=${encodeURIComponent('Invalid OAuth state — please try again.')}`);
  }

  if (!code) {
    return res.redirect(`/#/settings?mcp_error=${encodeURIComponent('No authorization code received.')}`);
  }

  try {
    const callbackUrl = buildCallbackUrl(req);

    const tokenRes = await fetch(MCP_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: s.mcp_client_id,
        code_verifier: s.mcp_pkce_verifier,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return res.redirect(`/#/settings?mcp_error=${encodeURIComponent(`Token exchange failed: ${body}`)}`);
    }

    const tokens = await tokenRes.json() as any;
    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

    updateSettings({
      mcp_access_token: tokens.access_token,
      mcp_refresh_token: tokens.refresh_token || '',
      mcp_token_expiry: expiry,
      // Clear transient PKCE + state
      mcp_pkce_verifier: '',
      mcp_oauth_state: '',
    });

    res.redirect('/#/settings?mcp_connected=1');
  } catch (err: any) {
    res.redirect(`/#/settings?mcp_error=${encodeURIComponent(err.message)}`);
  }
});

/** Disconnect MCP OAuth — clears all OAuth tokens */
router.post('/mcp-disconnect', (_req, res) => {
  updateSettings({
    mcp_access_token: '',
    mcp_refresh_token: '',
    mcp_token_expiry: '',
    mcp_client_id: '',
    mcp_pkce_verifier: '',
    mcp_oauth_state: '',
    mcp_token: '', // also clear legacy token
  });
  res.json({ success: true });
});

/** Save Activepieces MCP token (legacy — kept for backward compat) */
router.post('/save-mcp-token', (req, res) => {
  const { mcp_token } = req.body;
  if (!mcp_token || !mcp_token.trim()) {
    return res.status(400).json({ error: 'MCP token is required' });
  }
  updateSettings({ mcp_token: mcp_token.trim() });
  res.json({ success: true, message: 'MCP token saved.' });
});

/** Remove MCP token (legacy) */
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

import { useState, useEffect } from 'react';
import { api, type AiCostSummary, type AiUsageRow } from '../lib/api';
import { CheckCircle, XCircle, Loader2, LogIn, LogOut, ShieldCheck, Brain, Trash2, DollarSign, TrendingUp, Zap, Plug } from 'lucide-react';
import LinearBugTrendCard from '../components/LinearBugTrendCard';

const AI_MODELS = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (latest)' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (faster, cheaper)' },
];

export default function Settings() {
  const [form, setForm] = useState({ base_url: '', api_key: '', project_id: '', test_timeout_ms: 180000, batch_concurrency: 3 });
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState('');
  const [hasJwt, setHasJwt] = useState(false);
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);
  const [anthropicKeyMasked, setAnthropicKeyMasked] = useState('');
  const [currentAiModel, setCurrentAiModel] = useState('claude-sonnet-4-6');
  const [hasMcpToken, setHasMcpToken] = useState(false);
  const [mcpTokenMasked, setMcpTokenMasked] = useState('');
  const [hasLinearWebhook, setHasLinearWebhook] = useState(false);
  const [linearWebhookMasked, setLinearWebhookMasked] = useState('');
  const [linearWebhookInput, setLinearWebhookInput] = useState('');
  const [savingLinear, setSavingLinear] = useState(false);
  const [linearResult, setLinearResult] = useState<{ success: boolean; message: string } | null>(null);
  const [hasNotifyWebhook, setHasNotifyWebhook] = useState(false);
  const [notifyWebhookMasked, setNotifyWebhookMasked] = useState('');
  const [notifyWebhookInput, setNotifyWebhookInput] = useState('');
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [stormThreshold, setStormThreshold] = useState(8);
  const [retestCount, setRetestCount] = useState(2);
  const [savingNotify, setSavingNotify] = useState(false);
  const [notifyResult, setNotifyResult] = useState<{ success: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveMsg, setSaveMsg] = useState('');

  // Sign-in form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [signInResult, setSignInResult] = useState<{ success: boolean; message: string } | null>(null);
  const [authMode, setAuthMode] = useState<'password' | 'token'>('token'); // default to token paste

  const [autoRefresh, setAutoRefresh] = useState(false);
  const [serviceEmailMasked, setServiceEmailMasked] = useState('');
  const [jwtExpiresAt, setJwtExpiresAt] = useState('');
  const [jwtStatus, setJwtStatus] = useState('');
  const [rememberMe, setRememberMe] = useState(true); // Email/Password tab: store creds for auto-refresh

  // AI config state
  const [anthropicKey, setAnthropicKey] = useState('');
  const [aiModel, setAiModel] = useState('claude-sonnet-4-6');
  const [savingAi, setSavingAi] = useState(false);
  const [aiResult, setAiResult] = useState<{ success: boolean; message: string } | null>(null);

  // MCP state
  const [mcpConnectedViaOAuth, setMcpConnectedViaOAuth] = useState(false);
  const [mcpResult, setMcpResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      setForm({ base_url: s.base_url, api_key: '', project_id: s.project_id, test_timeout_ms: s.test_timeout_ms, batch_concurrency: s.batch_concurrency ?? 3 });
      setHasApiKey(s.has_api_key || false);
      setApiKeyMasked(s.api_key_masked || '');
      setHasJwt(s.has_jwt);
      setAutoRefresh(!!s.auto_refresh_enabled);
      setServiceEmailMasked(s.service_email_masked || '');
      setJwtExpiresAt(s.jwt_expires_at || '');
      setJwtStatus(s.jwt_status || '');
      setHasAnthropicKey(s.has_anthropic_key);
      setAnthropicKeyMasked(s.anthropic_key_masked || '');
      setCurrentAiModel(s.ai_model || 'claude-sonnet-4-6');
      setAiModel(s.ai_model || 'claude-sonnet-4-6');
      setHasMcpToken(s.has_mcp_token || false);
      setMcpTokenMasked(s.mcp_token_masked || '');
      setHasLinearWebhook(s.has_linear_webhook || false);
      setLinearWebhookMasked(s.linear_webhook_masked || '');
      setHasNotifyWebhook(s.has_notify_webhook || false);
      setNotifyWebhookMasked(s.notify_webhook_masked || '');
      setNotifyEnabled(!!s.notify_enabled);
      setStormThreshold(s.notify_storm_threshold ?? 8);
      setRetestCount(s.notify_retest_count ?? 2);
      setMcpConnectedViaOAuth(s.mcp_connected_via_oauth || false);
      setLoading(false);
    });

    // Handle OAuth callback result passed via hash query params
    const hash = window.location.hash; // e.g. "#/settings?mcp_connected=1"
    const qIdx = hash.indexOf('?');
    if (qIdx !== -1) {
      const params = new URLSearchParams(hash.slice(qIdx + 1));
      if (params.get('mcp_connected') === '1') {
        setMcpResult({ success: true, message: 'Activepieces MCP connected successfully!' });
        setHasMcpToken(true);
        setMcpConnectedViaOAuth(true);
        // Clean up URL
        window.history.replaceState(null, '', '/#/settings');
      } else if (params.get('mcp_error')) {
        setMcpResult({ success: false, message: `MCP connection failed: ${params.get('mcp_error')}` });
        window.history.replaceState(null, '', '/#/settings');
      }
    }
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const payload: any = {
        base_url: form.base_url,
        project_id: form.project_id,
        test_timeout_ms: form.test_timeout_ms,
        batch_concurrency: form.batch_concurrency,
      };
      const submittedKey = form.api_key.trim();
      if (submittedKey) payload.api_key = submittedKey;
      const res = await api.updateSettings(payload);
      if (submittedKey) {
        setHasApiKey(res.has_api_key ?? true);
        setApiKeyMasked(res.api_key_masked || '');
        setForm((f) => ({ ...f, api_key: '' }));
      }
      setSaveMsg('Settings saved.');
    } catch (err: any) {
      setSaveMsg(`Error: ${err.message}`);
    }
    setSaving(false);
  };

  const handleSaveLinearWebhook = async () => {
    if (!linearWebhookInput.trim()) return;
    setSavingLinear(true);
    setLinearResult(null);
    try {
      await api.updateSettings({ linear_report_webhook_url: linearWebhookInput.trim() });
      const s = await api.getSettings();
      setHasLinearWebhook(s.has_linear_webhook || false);
      setLinearWebhookMasked(s.linear_webhook_masked || '');
      setLinearWebhookInput('');
      setLinearResult({ success: true, message: 'Linear reporting webhook saved.' });
    } catch (e: any) {
      setLinearResult({ success: false, message: e?.message || 'Failed to save.' });
    } finally {
      setSavingLinear(false);
    }
  };

  const handleRemoveLinearWebhook = async () => {
    try {
      await api.removeLinearWebhook();
      setHasLinearWebhook(false);
      setLinearWebhookMasked('');
      setLinearResult({ success: true, message: 'Linear reporting webhook removed.' });
    } catch (e: any) {
      setLinearResult({ success: false, message: e?.message || 'Failed to remove.' });
    }
  };

  const handleSaveNotify = async () => {
    setSavingNotify(true); setNotifyResult(null);
    try {
      const payload: any = { notify_enabled: notifyEnabled ? 1 : 0, notify_storm_threshold: stormThreshold, notify_retest_count: retestCount };
      if (notifyWebhookInput.trim()) payload.notify_webhook_url = notifyWebhookInput.trim();
      await api.updateSettings(payload);
      const s = await api.getSettings();
      setHasNotifyWebhook(s.has_notify_webhook || false);
      setNotifyWebhookMasked(s.notify_webhook_masked || '');
      setNotifyWebhookInput('');
      setNotifyResult({ success: true, message: 'Discord alert settings saved.' });
    } catch (e: any) { setNotifyResult({ success: false, message: e?.message || 'Failed to save.' }); }
    finally { setSavingNotify(false); }
  };

  const handleRemoveNotify = async () => {
    try { await api.removeNotifyWebhook(); setHasNotifyWebhook(false); setNotifyWebhookMasked(''); setNotifyEnabled(false);
      setNotifyResult({ success: true, message: 'Discord webhook removed.' });
    } catch (e: any) { setNotifyResult({ success: false, message: e?.message || 'Failed to remove.' }); }
  };

  const handleTestNotify = async () => {
    setNotifyResult(null);
    try { await api.testNotification(); setNotifyResult({ success: true, message: 'Test alert sent — check the channel.' }); }
    catch (e: any) { setNotifyResult({ success: false, message: e?.message || 'Failed to send.' }); }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const testPayload: any = { base_url: form.base_url, project_id: form.project_id };
      if (form.api_key.trim()) testPayload.api_key = form.api_key.trim();
      const res = await api.testConnection(testPayload);
      setTestResult({ success: true, message: `Connected! Found ${res.pieceCount} pieces.` });
    } catch (err: any) {
      setTestResult({ success: false, message: err.message });
    }
    setTesting(false);
  };

  const handleSignIn = async () => {
    setSigningIn(true);
    setSignInResult(null);
    try {
      if (authMode === 'token') {
        // Manual token paste
        const res = await api.saveToken(manualToken.trim());
        setSignInResult({ success: true, message: res.message || 'Token saved!' });
        setHasJwt(true);
        setManualToken('');
      } else {
        // Email/password
        const res = await api.signIn(email, password);
        setSignInResult({ success: true, message: res.message || 'Signed in!' });
        setHasJwt(true);
        setPassword('');
      }
    } catch (err: any) {
      setSignInResult({ success: false, message: err.message });
    }
    setSigningIn(false);
  };

  const handleSignOut = async () => {
    await api.signOut();
    setHasJwt(false);
    setSignInResult(null);
  };

  const handleSaveServiceAccount = async () => {
    setSigningIn(true);
    setSignInResult(null);
    try {
      const res = await api.saveServiceAccount(email.trim(), password);
      setSignInResult({ success: true, message: res.message || 'Auto-refresh enabled.' });
      setAutoRefresh(true);
      setServiceEmailMasked(maskEmailLocal(email.trim()));
      setJwtStatus('ok');
      setHasJwt(true);
      setPassword('');
    } catch (e: any) {
      setSignInResult({ success: false, message: e?.message || 'Failed to enable auto-refresh.' });
    } finally {
      setSigningIn(false);
    }
  };

  const handleRemoveServiceAccount = async () => {
    try {
      await api.removeServiceAccount();
      setAutoRefresh(false);
      setServiceEmailMasked('');
      setJwtStatus('');
      setJwtExpiresAt('');
      setSignInResult(null);
    } catch (e: any) {
      setSignInResult({ success: false, message: e?.message || 'Failed to turn off auto-refresh.' });
    }
  };

  const handleSaveAnthropicKey = async () => {
    setSavingAi(true);
    setAiResult(null);
    try {
      const res = await api.saveAnthropicKey(anthropicKey.trim(), aiModel);
      setAiResult({ success: true, message: res.message || 'API key saved!' });
      setHasAnthropicKey(true);
      setAnthropicKeyMasked(anthropicKey.trim().slice(0, 10) + '...' + anthropicKey.trim().slice(-4));
      setCurrentAiModel(aiModel);
      setAnthropicKey('');
    } catch (err: any) {
      setAiResult({ success: false, message: err.message });
    }
    setSavingAi(false);
  };

  const handleRemoveAnthropicKey = async () => {
    await api.removeAnthropicKey();
    setHasAnthropicKey(false);
    setAnthropicKeyMasked('');
    setAiResult(null);
  };

  const handleMcpConnect = () => {
    // Full-page navigation to server OAuth redirect
    window.location.href = '/api/settings/mcp-connect';
  };

  const handleMcpDisconnect = async () => {
    await api.mcpDisconnect();
    setHasMcpToken(false);
    setMcpConnectedViaOAuth(false);
    setMcpTokenMasked('');
    setMcpResult(null);
  };

  if (loading) return <div className="text-gray-400">Loading settings...</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      {/* API Connection */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 max-w-xl space-y-4 mb-6">
        <h3 className="text-lg font-semibold">API Connection</h3>
        <p className="text-sm text-gray-400">Connect to your Activepieces instance using an API key.</p>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Base URL</label>
          <input
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            placeholder="https://cloud.activepieces.com/api"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">API Key</label>
          <input
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
            type="password"
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            placeholder={hasApiKey ? `Saved: ${apiKeyMasked} — leave blank to keep` : 'sk-...'}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Project ID</label>
          <input
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
            value={form.project_id}
            onChange={(e) => setForm({ ...form, project_id: e.target.value })}
            placeholder="your-project-id"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Test Timeout (ms)</label>
          <input
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
            type="number"
            value={form.test_timeout_ms}
            onChange={(e) => setForm({ ...form, test_timeout_ms: parseInt(e.target.value) || 180000 })}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Batch concurrency</label>
          <input
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
            type="number"
            min={1}
            max={20}
            value={form.batch_concurrency}
            onChange={(e) => setForm({ ...form, batch_concurrency: parseInt(e.target.value) || 3 })}
          />
          <p className="text-xs text-gray-500 mt-1">
            Pieces tested at once across all running batches. Higher is faster, but too high can overload Activepieces (especially Cloud). Default 3.
          </p>
        </div>
        <div className="flex gap-3 pt-2">
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button onClick={handleTest} disabled={testing} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-2">
            {testing && <Loader2 size={14} className="animate-spin" />}
            Test Connection
          </button>
        </div>
        {saveMsg && <p className="text-sm text-green-400">{saveMsg}</p>}
        {testResult && (
          <div className={`flex items-center gap-2 text-sm ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
            {testResult.success ? <CheckCircle size={16} /> : <XCircle size={16} />}
            {testResult.message}
          </div>
        )}
      </div>

      {/* User Authentication (JWT + auto-refresh) */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 max-w-xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">User Authentication</h3>
          {autoRefresh ? (
            <span className="flex items-center gap-1.5 text-sm text-green-400">
              <ShieldCheck size={16} /> Auto-refresh on
            </span>
          ) : hasJwt ? (
            <span className="flex items-center gap-1.5 text-sm text-green-400">
              <ShieldCheck size={16} /> Authenticated
            </span>
          ) : null}
        </div>
        <div className="text-sm text-gray-400 space-y-1">
          <p>Authenticate to enable <strong className="text-gray-300">step-level testing</strong>. <strong className="text-yellow-400">Required</strong> for AP Cloud — without it, tests fall back to a less reliable webhook approach.</p>
        </div>

        {jwtExpiresAt && (() => { const l = jwtExpiryLabel(jwtExpiresAt); return <p className={`text-sm ${l.tone}`}>{l.text}</p>; })()}
        {jwtStatus.startsWith('needs_attention:') && (
          <div className="bg-red-900/20 border border-red-800/40 rounded p-3 text-sm text-red-300">
            Auto-refresh failed: {jwtStatus.slice('needs_attention:'.length)}. Re-enter your email &amp; password below.
          </div>
        )}

        {autoRefresh ? (
          <div className="space-y-3">
            <div className="bg-green-900/20 border border-green-800/40 rounded p-3 text-sm text-green-300">
              Auto-refresh is on for <strong>{serviceEmailMasked}</strong>. The app renews your session before it expires — no re-pasting, and scheduled runs keep working.
            </div>
            <button onClick={handleRemoveServiceAccount} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium flex items-center gap-2">
              <LogOut size={14} /> Turn off auto-refresh
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {hasJwt && (
              <div className="flex items-center justify-between gap-3 bg-green-900/20 border border-green-800/40 rounded p-3 text-sm text-green-300">
                <span>Signed in with a manual session.</span>
                <button onClick={handleSignOut} className="shrink-0 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium flex items-center gap-1.5">
                  <LogOut size={12} /> Sign Out
                </button>
              </div>
            )}

            {/* Tab Switcher */}
            <div className="flex border-b border-gray-700">
              <button
                onClick={() => { setAuthMode('token'); setSignInResult(null); }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  authMode === 'token' ? 'border-primary-500 text-primary-400' : 'border-transparent text-gray-400 hover:text-gray-300'
                }`}
              >
                Paste Token
              </button>
              <button
                onClick={() => { setAuthMode('password'); setSignInResult(null); }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  authMode === 'password' ? 'border-primary-500 text-primary-400' : 'border-transparent text-gray-400 hover:text-gray-300'
                }`}
              >
                Email &amp; Password
              </button>
            </div>

            {authMode === 'token' ? (
              <div className="space-y-3">
                <div className="bg-gray-800/50 border border-gray-700 rounded p-3 text-xs text-gray-400 space-y-1">
                  <p><strong className="text-gray-300">How to get your token:</strong></p>
                  <p>1. Open the AP dashboard in your browser</p>
                  <p>2. Open DevTools (F12) &rarr; Application tab &rarr; Local Storage &rarr; <code className="bg-gray-700 px-1 rounded">https://cloud.activepieces.com</code></p>
                  <p>3. Copy the value of the <code className="bg-gray-700 px-1 rounded">token</code> key</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">JWT Token</label>
                  <textarea
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500 font-mono h-20 resize-y"
                    value={manualToken}
                    onChange={(e) => setManualToken(e.target.value)}
                    placeholder="eyJhbGciOiJIUzI1NiIs..."
                  />
                </div>
                <p className="text-xs text-gray-500">A pasted token expires and must be re-pasted. To stop re-pasting, use the <strong className="text-gray-400">Email &amp; Password</strong> tab with auto-refresh.</p>
                <button
                  onClick={handleSignIn}
                  disabled={signingIn || !manualToken.trim()}
                  className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {signingIn ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  Save Token
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Email</label>
                  <input
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="piece-tester-bot@example.com"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Password</label>
                  <input
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Account password"
                    onKeyDown={(e) => e.key === 'Enter' && (rememberMe ? handleSaveServiceAccount() : handleSignIn())}
                  />
                </div>
                <label className="flex items-start gap-2 text-sm text-gray-300 cursor-pointer">
                  <input type="checkbox" className="mt-0.5" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
                  <span>
                    Keep me signed in (auto-refresh)
                    <span className="block text-xs text-gray-500">Stores the credentials encrypted and renews the session automatically — no re-pasting, and scheduled runs keep working. Needs an email/password account (not Google SSO), MFA off.</span>
                  </span>
                </label>
                <button
                  onClick={rememberMe ? handleSaveServiceAccount : handleSignIn}
                  disabled={signingIn || !email || !password}
                  className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {signingIn ? <Loader2 size={14} className="animate-spin" /> : rememberMe ? <ShieldCheck size={14} /> : <LogIn size={14} />}
                  {rememberMe ? 'Enable auto-refresh' : 'Sign In'}
                </button>
              </div>
            )}
          </div>
        )}

        {signInResult && (
          <div className={`flex items-center gap-2 text-sm ${signInResult.success ? 'text-green-400' : 'text-red-400'}`}>
            {signInResult.success ? <CheckCircle size={16} /> : <XCircle size={16} />}
            {signInResult.message}
          </div>
        )}
      </div>

      {/* AI Configuration */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 max-w-xl space-y-4 mt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold flex items-center gap-2"><Brain size={20} className="text-purple-400" /> AI Configuration</h3>
          {hasAnthropicKey && (
            <span className="flex items-center gap-1.5 text-sm text-purple-400">
              <CheckCircle size={16} /> Configured
            </span>
          )}
        </div>
        <div className="text-sm text-gray-400 space-y-1">
          <p>Connect your <strong className="text-gray-300">Anthropic API key</strong> to enable AI-powered test configuration.</p>
          <p>Claude will analyze piece schemas and generate intelligent test inputs, flagging fields that need your input.</p>
        </div>

        {hasAnthropicKey ? (
          <div className="space-y-3">
            <div className="bg-purple-900/20 border border-purple-800/40 rounded p-3 text-sm text-purple-300">
              <p>AI is enabled. Key: <code className="bg-gray-800 px-1.5 py-0.5 rounded text-xs">{anthropicKeyMasked}</code></p>
              <p className="text-xs text-gray-400 mt-1">Model: {AI_MODELS.find(m => m.value === currentAiModel)?.label || currentAiModel}</p>
            </div>
            <div className="flex gap-3">
              <button onClick={handleRemoveAnthropicKey} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium flex items-center gap-2">
                <Trash2 size={14} /> Remove Key
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Anthropic API Key</label>
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500 font-mono"
                type="password"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-api03-..."
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Model</label>
              <select
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
              >
                {AI_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <button
              onClick={handleSaveAnthropicKey}
              disabled={savingAi || !anthropicKey.trim()}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            >
              {savingAi ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
              Save & Verify Key
            </button>
          </div>
        )}

        {aiResult && (
          <div className={`flex items-center gap-2 text-sm ${aiResult.success ? 'text-green-400' : 'text-red-400'}`}>
            {aiResult.success ? <CheckCircle size={16} /> : <XCircle size={16} />}
            {aiResult.message}
          </div>
        )}
      </div>

      {/* MCP Integration */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 max-w-xl space-y-4 mt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold flex items-center gap-2"><Plug size={20} className="text-cyan-400" /> MCP Integration</h3>
          {hasMcpToken && (
            <span className="flex items-center gap-1.5 text-sm text-cyan-400">
              <CheckCircle size={16} /> Connected
            </span>
          )}
        </div>
        <div className="text-sm text-gray-400 space-y-1">
          <p>Connect your <strong className="text-gray-300">Activepieces account</strong> via OAuth to give AI agents native access to 35+ Activepieces tools.</p>
          <p>When enabled, agents can resolve live dropdown values, validate configs before execution, and test steps directly — <strong className="text-cyan-300">no JWT required for agent testing</strong>.</p>
        </div>

        {hasMcpToken ? (
          <div className="space-y-3">
            <div className="bg-cyan-900/20 border border-cyan-800/40 rounded p-3 text-sm text-cyan-300">
              {mcpConnectedViaOAuth ? (
                <>
                  <p className="font-medium">Connected via OAuth</p>
                  <p className="text-xs text-gray-400 mt-1">Agents have full access to all Activepieces MCP tools including <code className="bg-gray-800 px-1 rounded">ap_test_step</code>, <code className="bg-gray-800 px-1 rounded">ap_validate_step_config</code>, and more.</p>
                </>
              ) : (
                <>
                  <p>MCP is active (legacy token).</p>
                  <p className="text-xs text-gray-400 mt-1">Reconnect via OAuth to access all 35+ tools.</p>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={handleMcpConnect} className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded text-sm font-medium flex items-center gap-2">
                <Plug size={14} /> Reconnect
              </button>
              <button onClick={handleMcpDisconnect} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium flex items-center gap-2">
                <Trash2 size={14} /> Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="bg-gray-800/50 border border-gray-700 rounded p-3 text-xs text-gray-400 space-y-1">
              <p><strong className="text-gray-300">OAuth authorization flow:</strong></p>
              <p>Click the button below to be redirected to Activepieces where you can authorize this app to connect via MCP. You will be brought back automatically.</p>
            </div>
            <button
              onClick={handleMcpConnect}
              className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded text-sm font-medium flex items-center gap-2"
            >
              <Plug size={14} />
              Connect to Activepieces MCP
            </button>
          </div>
        )}

        {mcpResult && (
          <div className={`flex items-center gap-2 text-sm ${mcpResult.success ? 'text-green-400' : 'text-red-400'}`}>
            {mcpResult.success ? <CheckCircle size={16} /> : <XCircle size={16} />}
            {mcpResult.message}
          </div>
        )}
      </div>

      {/* Linear Reporting Webhook */}
      <div className="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-1 text-sm font-semibold text-gray-200">Linear reporting webhook</h3>
        <p className="mb-3 text-[12px] text-gray-500">
          Paste the Catch-Webhook URL of the ActivePieces flow that runs <span className="text-gray-300">Linear → Create Issue</span>.
          The Health board's "Report to Pieces team" action POSTs approved reports here.
        </p>
        {hasLinearWebhook ? (
          <div className="mb-2 flex items-center gap-2 text-[12px] text-gray-400">
            <span className="rounded bg-gray-800 px-2 py-1 font-mono">{linearWebhookMasked}</span>
            <button type="button" onClick={handleRemoveLinearWebhook} className="text-red-400 hover:underline">Remove</button>
          </div>
        ) : (
          <p className="mb-2 text-[12px] text-amber-400/80">Not configured — the report action will prompt for this.</p>
        )}
        <div className="flex gap-2">
          <input value={linearWebhookInput} onChange={e => setLinearWebhookInput(e.target.value)}
            placeholder="https://cloud.activepieces.com/api/v1/webhooks/…"
            className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200" />
          <button onClick={handleSaveLinearWebhook} disabled={savingLinear || !linearWebhookInput.trim()}
            className="rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
            {savingLinear ? 'Saving…' : 'Save'}
          </button>
        </div>
        {linearResult && (
          <p className={`mt-2 text-[12px] ${linearResult.success ? 'text-green-400' : 'text-red-400'}`}>{linearResult.message}</p>
        )}
      </div>

      <LinearBugTrendCard />

      {/* Discord alerts */}
      <div className="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-1 text-sm font-semibold text-gray-200">Discord alerts</h3>
        <p className="mb-3 text-[12px] text-gray-500">
          Paste a Discord channel <span className="text-gray-300">Incoming Webhook URL</span>. Confirmed piece bugs from scheduled sweeps post here and self-edit as they verify or recover.
        </p>
        {hasNotifyWebhook ? (
          <div className="mb-2 flex items-center gap-2 text-[12px] text-gray-400">
            <span className="rounded bg-gray-800 px-2 py-1 font-mono">{notifyWebhookMasked}</span>
            <button type="button" onClick={handleRemoveNotify} className="text-red-400 hover:underline">Remove</button>
          </div>
        ) : (
          <p className="mb-2 text-[12px] text-amber-400/80">Not configured — no alerts will be sent.</p>
        )}
        <div className="flex gap-2">
          <input value={notifyWebhookInput} onChange={e => setNotifyWebhookInput(e.target.value)}
            placeholder="https://discord.com/api/webhooks/…"
            className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200" />
          <button onClick={handleSaveNotify} disabled={savingNotify}
            className="rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
            {savingNotify ? 'Saving…' : 'Save'}
          </button>
          <button onClick={handleTestNotify} disabled={!hasNotifyWebhook}
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50">
            Send test alert
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-[12px] text-gray-400">
          <label className="flex items-center gap-2"><input type="checkbox" checked={notifyEnabled} onChange={e => setNotifyEnabled(e.target.checked)} /> Enabled</label>
          <label className="flex items-center gap-2">Storm threshold <input type="number" min={1} value={stormThreshold} onChange={e => setStormThreshold(Number(e.target.value))} className="w-16 rounded border border-gray-700 bg-gray-950 px-2 py-1" /></label>
          <label className="flex items-center gap-2">Retests <input type="number" min={0} max={5} value={retestCount} onChange={e => setRetestCount(Number(e.target.value))} className="w-16 rounded border border-gray-700 bg-gray-950 px-2 py-1" /></label>
        </div>
        {notifyResult && (
          <p className={`mt-2 text-[12px] ${notifyResult.success ? 'text-green-400' : 'text-red-400'}`}>{notifyResult.message}</p>
        )}
      </div>

      {/* AI Cost Tracking */}
      <AiCostDashboard />
    </div>
  );
}

/** Mask an email as first-char + domain, e.g. "p…@activepieces.com" (mirrors the server). */
function maskEmailLocal(v: string): string {
  const at = v.indexOf('@');
  if (at <= 0) return v ? '•••' : '';
  return `${v[0]}…${v.slice(at)}`;
}

/** Human label + tone for a JWT expiry ISO timestamp. */
function jwtExpiryLabel(iso: string): { text: string; tone: string } {
  if (!iso) return { text: '', tone: 'text-gray-500' };
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: 'Token expired — reconnect', tone: 'text-red-400' };
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return { text: `Token expires in ${hours}h`, tone: 'text-yellow-400' };
  return { text: `Token valid — expires in ${Math.floor(hours / 24)}d`, tone: 'text-green-400' };
}

function AiCostDashboard() {
  const [summary, setSummary] = useState<AiCostSummary | null>(null);
  const [recentLogs, setRecentLogs] = useState<AiUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRecent, setShowRecent] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getAiCostSummary(),
      api.getAiCostRecent(30),
    ]).then(([s, r]) => {
      setSummary(s);
      setRecentLogs(r);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (!summary || summary.total_requests === 0) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 max-w-xl space-y-4 mt-6">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <DollarSign size={20} className="text-green-400" /> AI Cost Tracking
        </h3>
        <p className="text-sm text-gray-400">No AI usage recorded yet. Create or fix a plan to start tracking costs.</p>
      </div>
    );
  }

  const formatCost = (n: number) => n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  const formatTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 max-w-xl space-y-4 mt-6">
      <h3 className="text-lg font-semibold flex items-center gap-2">
        <DollarSign size={20} className="text-green-400" /> AI Cost Tracking
      </h3>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-800/50 border border-gray-700 rounded p-3 text-center">
          <div className="text-xs text-gray-400 mb-1">Total Cost</div>
          <div className="text-lg font-bold text-green-400">{formatCost(summary.total_cost_usd)}</div>
        </div>
        <div className="bg-gray-800/50 border border-gray-700 rounded p-3 text-center">
          <div className="text-xs text-gray-400 mb-1">API Calls</div>
          <div className="text-lg font-bold text-blue-400">{summary.total_requests}</div>
        </div>
        <div className="bg-gray-800/50 border border-gray-700 rounded p-3 text-center">
          <div className="text-xs text-gray-400 mb-1">Total Tokens</div>
          <div className="text-lg font-bold text-purple-400">
            {formatTokens(summary.total_input_tokens + summary.total_output_tokens)}
          </div>
        </div>
      </div>

      {/* Breakdown by Version */}
      {summary.by_version.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
            <Zap size={14} className="text-yellow-400" /> By Version
          </div>
          <div className="flex gap-2 flex-wrap">
            {summary.by_version.map(v => (
              <div key={v.version} className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs">
                <span className="text-gray-300 font-medium">{v.version.toUpperCase()}</span>
                <span className="text-gray-500 mx-1.5">|</span>
                <span className="text-green-400">{formatCost(v.cost_usd)}</span>
                <span className="text-gray-500 mx-1.5">|</span>
                <span className="text-gray-400">{v.requests} calls</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Breakdown by Operation */}
      {summary.by_operation.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
            <TrendingUp size={14} className="text-cyan-400" /> By Operation
          </div>
          <div className="flex gap-2 flex-wrap">
            {summary.by_operation.map(op => (
              <div key={op.operation} className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs">
                <span className="text-gray-300 font-medium">{op.operation}</span>
                <span className="text-gray-500 mx-1.5">|</span>
                <span className="text-green-400">{formatCost(op.cost_usd)}</span>
                <span className="text-gray-500 mx-1.5">|</span>
                <span className="text-gray-400">{op.requests} calls</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Usage Table */}
      <div>
        <button
          onClick={() => setShowRecent(!showRecent)}
          className="text-sm text-primary-400 hover:text-primary-300"
        >
          {showRecent ? 'Hide' : 'Show'} recent API calls ({recentLogs.length})
        </button>

        {showRecent && recentLogs.length > 0 && (
          <div className="mt-2 max-h-64 overflow-auto border border-gray-700 rounded">
            <table className="w-full text-xs">
              <thead className="bg-gray-800 sticky top-0">
                <tr>
                  <th className="text-left px-2 py-1.5 text-gray-400">Time</th>
                  <th className="text-left px-2 py-1.5 text-gray-400">Piece</th>
                  <th className="text-left px-2 py-1.5 text-gray-400">Role</th>
                  <th className="text-right px-2 py-1.5 text-gray-400">Tokens</th>
                  <th className="text-right px-2 py-1.5 text-gray-400">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recentLogs.map(row => (
                  <tr key={row.id} className="border-t border-gray-800 hover:bg-gray-800/50">
                    <td className="px-2 py-1 text-gray-500">{new Date(row.created_at).toLocaleString()}</td>
                    <td className="px-2 py-1 text-gray-300 truncate max-w-[120px]">{row.piece_name.replace('@activepieces/piece-', '')}</td>
                    <td className="px-2 py-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        row.agent_version === 'v2' ? 'bg-purple-900/40 text-purple-300' : 'bg-blue-900/40 text-blue-300'
                      }`}>
                        {row.agent_version}/{row.agent_role}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right text-gray-400">{formatTokens(row.input_tokens + row.output_tokens)}</td>
                    <td className="px-2 py-1 text-right text-green-400">{formatCost(row.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

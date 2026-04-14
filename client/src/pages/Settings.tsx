import { useState, useEffect } from 'react';
import { api, type AiCostSummary, type AiUsageRow } from '../lib/api';
import { CheckCircle, XCircle, Loader2, LogIn, LogOut, ShieldCheck, Brain, Trash2, DollarSign, TrendingUp, Zap, Plug } from 'lucide-react';

const AI_MODELS = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (latest)' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (faster, cheaper)' },
];

export default function Settings() {
  const [form, setForm] = useState({ base_url: '', api_key: '', project_id: '', test_timeout_ms: 180000 });
  const [hasJwt, setHasJwt] = useState(false);
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);
  const [anthropicKeyMasked, setAnthropicKeyMasked] = useState('');
  const [currentAiModel, setCurrentAiModel] = useState('claude-sonnet-4-6');
  const [hasMcpToken, setHasMcpToken] = useState(false);
  const [mcpTokenMasked, setMcpTokenMasked] = useState('');
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

  // AI config state
  const [anthropicKey, setAnthropicKey] = useState('');
  const [aiModel, setAiModel] = useState('claude-sonnet-4-6');
  const [savingAi, setSavingAi] = useState(false);
  const [aiResult, setAiResult] = useState<{ success: boolean; message: string } | null>(null);

  // MCP token state
  const [mcpToken, setMcpToken] = useState('');
  const [savingMcp, setSavingMcp] = useState(false);
  const [mcpResult, setMcpResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      setForm({ base_url: s.base_url, api_key: s.api_key, project_id: s.project_id, test_timeout_ms: s.test_timeout_ms });
      setHasJwt(s.has_jwt);
      setHasAnthropicKey(s.has_anthropic_key);
      setAnthropicKeyMasked(s.anthropic_key_masked || '');
      setCurrentAiModel(s.ai_model || 'claude-sonnet-4-6');
      setAiModel(s.ai_model || 'claude-sonnet-4-6');
      setHasMcpToken(s.has_mcp_token || false);
      setMcpTokenMasked(s.mcp_token_masked || '');
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      await api.updateSettings(form);
      setSaveMsg('Settings saved.');
    } catch (err: any) {
      setSaveMsg(`Error: ${err.message}`);
    }
    setSaving(false);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testConnection(form);
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

  const handleFetchMcpToken = async () => {
    setSavingMcp(true);
    setMcpResult(null);
    try {
      const res = await api.fetchMcpToken();
      setMcpResult({ success: true, message: res.message || 'MCP token fetched!' });
      setHasMcpToken(true);
      setMcpTokenMasked(res.token_masked || '');
    } catch (err: any) {
      setMcpResult({ success: false, message: err.message });
    }
    setSavingMcp(false);
  };

  const handleSaveMcpToken = async () => {
    setSavingMcp(true);
    setMcpResult(null);
    try {
      const res = await api.saveMcpToken(mcpToken.trim());
      setMcpResult({ success: true, message: res.message || 'MCP token saved!' });
      setHasMcpToken(true);
      setMcpTokenMasked('...' + mcpToken.trim().slice(-8));
      setMcpToken('');
    } catch (err: any) {
      setMcpResult({ success: false, message: err.message });
    }
    setSavingMcp(false);
  };

  const handleRemoveMcpToken = async () => {
    await api.removeMcpToken();
    setHasMcpToken(false);
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
            placeholder="sk-..."
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

      {/* User Authentication (JWT) */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 max-w-xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">User Authentication</h3>
          {hasJwt && (
            <span className="flex items-center gap-1.5 text-sm text-green-400">
              <ShieldCheck size={16} /> Authenticated
            </span>
          )}
        </div>
        <div className="text-sm text-gray-400 space-y-1">
          <p>Authenticate to enable <strong className="text-gray-300">step-level testing</strong>.</p>
          <p>This is <strong className="text-yellow-400">required</strong> for AP Cloud. Without it, tests will fall back to a less reliable webhook-based approach.</p>
        </div>

        {hasJwt ? (
          <div className="space-y-3">
            <div className="bg-green-900/20 border border-green-800/40 rounded p-3 text-sm text-green-300">
              You are signed in. Step testing is enabled using your user session.
            </div>
            <button onClick={handleSignOut} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium flex items-center gap-2">
              <LogOut size={14} /> Sign Out
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Tab Switcher */}
            <div className="flex border-b border-gray-700">
              <button
                onClick={() => { setAuthMode('token'); setSignInResult(null); }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  authMode === 'token' ? 'border-primary-500 text-primary-400' : 'border-transparent text-gray-400 hover:text-gray-300'
                }`}
              >
                Paste Token (recommended)
              </button>
              <button
                onClick={() => { setAuthMode('password'); setSignInResult(null); }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  authMode === 'password' ? 'border-primary-500 text-primary-400' : 'border-transparent text-gray-400 hover:text-gray-300'
                }`}
              >
                Email / Password
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
                <p className="text-xs text-gray-500">Only works if you sign in with email/password (not Google SSO).</p>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Email</label>
                  <input
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Password</label>
                  <input
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your AP dashboard password"
                    onKeyDown={(e) => e.key === 'Enter' && handleSignIn()}
                  />
                </div>
                <button
                  onClick={handleSignIn}
                  disabled={signingIn || !email || !password}
                  className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {signingIn ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                  Sign In to Activepieces
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
          <p>Connect your <strong className="text-gray-300">Activepieces MCP token</strong> to give AI agents native access to 35+ Activepieces tools.</p>
          <p>When enabled, agents can resolve live dropdown values, validate configs before execution, and test steps directly — <strong className="text-cyan-300">no JWT required for agent testing</strong>.</p>
        </div>

        {hasMcpToken ? (
          <div className="space-y-3">
            <div className="bg-cyan-900/20 border border-cyan-800/40 rounded p-3 text-sm text-cyan-300">
              <p>MCP is active. Token: <code className="bg-gray-800 px-1.5 py-0.5 rounded text-xs font-mono">{mcpTokenMasked}</code></p>
              <p className="text-xs text-gray-400 mt-1">Agents will use <code className="bg-gray-800 px-1 rounded">ap_get_piece_props</code>, <code className="bg-gray-800 px-1 rounded">ap_validate_step_config</code>, and more.</p>
            </div>
            <div className="flex gap-3">
              <button onClick={handleFetchMcpToken} disabled={savingMcp} className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded text-sm font-medium flex items-center gap-2 disabled:opacity-50">
                {savingMcp ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                Refresh Token
              </button>
              <button onClick={handleRemoveMcpToken} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium flex items-center gap-2">
                <Trash2 size={14} /> Remove
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Auto-fetch — primary action */}
            <div className="bg-cyan-950/40 border border-cyan-800/40 rounded p-4 space-y-3">
              <p className="text-sm text-cyan-200 font-medium">Automatic setup (recommended)</p>
              <p className="text-xs text-gray-400">Fetches the token directly from Activepieces using your API key. Make sure <strong className="text-gray-300">API Connection</strong> is saved and MCP is enabled in Activepieces Settings → MCP Server.</p>
              <button
                onClick={handleFetchMcpToken}
                disabled={savingMcp}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {savingMcp ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                Auto-Fetch MCP Token from Activepieces
              </button>
            </div>

            {/* Manual paste — fallback */}
            <details className="text-sm">
              <summary className="text-gray-400 cursor-pointer hover:text-gray-300 select-none">Or paste token manually</summary>
              <div className="mt-3 space-y-2">
                <input
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-cyan-500 font-mono"
                  type="password"
                  value={mcpToken}
                  onChange={(e) => setMcpToken(e.target.value)}
                  placeholder="Paste your MCP token..."
                />
                <button
                  onClick={handleSaveMcpToken}
                  disabled={savingMcp || !mcpToken.trim()}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {savingMcp ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                  Save Token
                </button>
              </div>
            </details>
          </div>
        )}

        {mcpResult && (
          <div className={`flex items-center gap-2 text-sm ${mcpResult.success ? 'text-green-400' : 'text-red-400'}`}>
            {mcpResult.success ? <CheckCircle size={16} /> : <XCircle size={16} />}
            {mcpResult.message}
          </div>
        )}
      </div>

      {/* AI Cost Tracking */}
      <AiCostDashboard />
    </div>
  );
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

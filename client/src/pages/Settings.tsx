import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { CheckCircle, XCircle, Loader2, LogIn, LogOut, ShieldCheck, Brain, Trash2 } from 'lucide-react';

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

  useEffect(() => {
    api.getSettings().then((s) => {
      setForm({ base_url: s.base_url, api_key: s.api_key, project_id: s.project_id, test_timeout_ms: s.test_timeout_ms });
      setHasJwt(s.has_jwt);
      setHasAnthropicKey(s.has_anthropic_key);
      setAnthropicKeyMasked(s.anthropic_key_masked || '');
      setCurrentAiModel(s.ai_model || 'claude-sonnet-4-6');
      setAiModel(s.ai_model || 'claude-sonnet-4-6');
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
    </div>
  );
}

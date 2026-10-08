import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function GitHubTokenCard() {
  const [hasToken, setHasToken] = useState(false);
  const [tokenMasked, setTokenMasked] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const applySettings = (s: any) => {
    setHasToken(!!s.has_github_token);
    setTokenMasked(s.github_token_masked || '');
  };

  useEffect(() => {
    api.getSettings().then(applySettings).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!tokenInput.trim()) return;
    setSaving(true);
    setResult(null);
    try {
      const r = await api.saveGitHubToken(tokenInput.trim());
      setTokenInput('');
      setHasToken(true);
      const message = `Saved — GitHub allows ${r.limit} requests per hour with this token.`;
      setResult({ success: true, message });
      try {
        applySettings(await api.getSettings());
      } catch (e: any) {
        setResult({ success: true, message: `${message} Couldn't reload settings: ${e?.message || 'unknown error'}` });
      }
    } catch (e: any) {
      setResult({ success: false, message: e?.message || 'Failed to save.' });
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    setResult(null);
    try {
      await api.removeGitHubToken();
      setHasToken(false);
      setTokenMasked('');
      setResult({ success: true, message: 'GitHub token removed.' });
    } catch (e: any) {
      setResult({ success: false, message: e?.message || 'Failed to remove.' });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <h3 className="mb-1 text-sm font-semibold text-gray-200">GitHub token</h3>
      <p className="mb-3 text-[12px] text-gray-500">
        Optional. Used to read piece source code from GitHub. Without a token the server is limited to 60 GitHub API
        requests per hour, shared by test setup and Vendor Watch. A fine-grained token with no extra permissions (public
        repositories, read-only) is enough.
      </p>
      {hasToken ? (
        <div className="mb-2 flex items-center gap-2 text-[12px] text-gray-400">
          <span className="rounded bg-gray-800 px-2 py-1 font-mono">{tokenMasked}</span>
          <button type="button" onClick={handleRemove} disabled={removing}
            className="text-red-400 hover:underline disabled:opacity-50">
            {removing ? 'Removing…' : 'Remove'}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input value={tokenInput} onChange={e => setTokenInput(e.target.value)} type="password" autoComplete="off"
            placeholder="github_pat_…"
            className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200" />
          <button onClick={handleSave} disabled={saving || !tokenInput.trim()}
            className="rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
            {saving ? 'Checking…' : 'Save'}
          </button>
        </div>
      )}

      {result && (
        <p className={`mt-2 text-[12px] ${result.success ? 'text-green-400' : 'text-red-400'}`}>{result.message}</p>
      )}
    </div>
  );
}

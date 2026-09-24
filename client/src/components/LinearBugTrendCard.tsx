import { useEffect, useMemo, useState } from 'react';
import { api, type LinearUser, type RosterMember } from '../lib/api';
import { buildRosterRows } from '../lib/linearRoster';

export default function LinearBugTrendCard() {
  const [hasKey, setHasKey] = useState(false);
  const [keyMasked, setKeyMasked] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [saved, setSaved] = useState<RosterMember[]>([]);
  const [users, setUsers] = useState<LinearUser[] | null>(null);
  const [usersError, setUsersError] = useState('');
  const [search, setSearch] = useState('');
  const [savingRoster, setSavingRoster] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const applySettings = (s: any) => {
    const stored: RosterMember[] = Array.isArray(s.bug_trend_roster) ? s.bug_trend_roster : [];
    setHasKey(!!s.has_linear_api_key);
    setKeyMasked(s.linear_api_key_masked || '');
    setRoster(stored);
    setSaved(stored);
  };

  const loadUsers = async () => {
    setUsersError('');
    try {
      setUsers(await api.getLinearUsers());
    } catch (e: any) {
      setUsers(null);
      setUsersError(e?.message || 'Failed to load Linear users.');
    }
  };

  useEffect(() => {
    api.getSettings().then(s => {
      applySettings(s);
      if (s.has_linear_api_key) loadUsers();
    }).catch(() => {});
  }, []);

  const handleSaveKey = async () => {
    if (!keyInput.trim()) return;
    setSavingKey(true);
    setResult(null);
    try {
      const r = await api.saveLinearKey(keyInput.trim());
      setKeyInput('');
      const parts = [`Linear key saved (signed in as ${r.viewer}).`];
      if (r.seeded.length) parts.push(`Roster seeded with ${r.seeded.length} people.`);
      if (r.notFound.length) parts.push(`Couldn't find: ${r.notFound.join(', ')}. Pick them below.`);
      const message = parts.join(' ');
      setResult({ success: true, message });
      try {
        applySettings(await api.getSettings());
        await loadUsers();
      } catch (e: any) {
        setResult({ success: true, message: `${message} Saved, but couldn't reload settings: ${e?.message || 'unknown error'}` });
      }
    } catch (e: any) {
      setResult({ success: false, message: e?.message || 'Failed to save.' });
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemoveKey = async () => {
    try {
      await api.removeLinearKey();
      setHasKey(false);
      setKeyMasked('');
      setUsers(null);
      setResult({ success: true, message: 'Linear key removed. The roster is kept.' });
    } catch (e: any) {
      setResult({ success: false, message: e?.message || 'Failed to remove.' });
    }
  };

  const toggle = (id: string, name: string) =>
    setRoster(r => (r.some(m => m.id === id) ? r.filter(m => m.id !== id) : [...r, { id, name }]));

  const handleSaveRoster = async () => {
    setSavingRoster(true);
    setResult(null);
    try {
      applySettings(await api.updateSettings({ bug_trend_roster: roster }));
      setResult({ success: true, message: `Roster saved (${roster.length} people).` });
    } catch (e: any) {
      setResult({ success: false, message: e?.message || 'Failed to save the roster.' });
    } finally {
      setSavingRoster(false);
    }
  };

  const rows = useMemo(() => (users ? buildRosterRows(users, roster, saved, search) : []), [users, roster, saved, search]);
  const rosterChanged = roster.map(m => m.id).sort().join(',') !== saved.map(m => m.id).sort().join(',');

  return (
    <div className="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <h3 className="mb-1 text-sm font-semibold text-gray-200">Linear — Bug Trend</h3>
      <p className="mb-3 text-[12px] text-gray-500">
        Lets the <span className="text-gray-300">Bug Trend</span> page read bugs from Linear. Create a personal API key in
        Linear → Settings → Account → Security &amp; access. Give it Read access only, limited to the GIT and PIE teams,
        if Linear offers those options.
      </p>
      {hasKey ? (
        <div className="mb-2 flex items-center gap-2 text-[12px] text-gray-400">
          <span className="rounded bg-gray-800 px-2 py-1 font-mono">{keyMasked}</span>
          <button type="button" onClick={handleRemoveKey} className="text-red-400 hover:underline">Remove</button>
        </div>
      ) : (
        <p className="mb-2 text-[12px] text-amber-400/80">Not configured — the Bug Trend page will ask for this.</p>
      )}
      <div className="flex gap-2">
        <input value={keyInput} onChange={e => setKeyInput(e.target.value)} type="password" autoComplete="off"
          placeholder="lin_api_…"
          className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200" />
        <button onClick={handleSaveKey} disabled={savingKey || !keyInput.trim()}
          className="rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
          {savingKey ? 'Checking…' : 'Save'}
        </button>
      </div>

      {hasKey && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-[12px] font-semibold text-gray-300">Team members counted ({roster.length})</h4>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search people…"
              className="w-48 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[12px] text-gray-200" />
          </div>
          {usersError && <p className="mb-2 text-[12px] text-red-400">{usersError}</p>}
          {users === null && !usersError && <p className="text-[12px] text-gray-500">Loading Linear users…</p>}
          {users !== null && (
            <div className="max-h-64 overflow-y-auto rounded border border-gray-800">
              {rows.map(r => (
                <label key={r.id} className="flex cursor-pointer items-center gap-2 border-b border-gray-800 px-3 py-1.5 text-[12px] last:border-b-0 hover:bg-gray-800/50">
                  <input type="checkbox" checked={r.checked} onChange={() => toggle(r.id, r.name)} />
                  <span className="text-gray-200">{r.name}</span>
                  <span className={r.inactive ? 'text-amber-400/80' : 'text-gray-500'}>{r.detail}</span>
                </label>
              ))}
              {rows.length === 0 && <p className="px-3 py-2 text-[12px] text-gray-500">No matching people.</p>}
            </div>
          )}
          <button onClick={handleSaveRoster} disabled={savingRoster || !rosterChanged}
            className="mt-2 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
            {savingRoster ? 'Saving…' : 'Save roster'}
          </button>
        </div>
      )}

      {result && (
        <p className={`mt-2 text-[12px] ${result.success ? 'text-green-400' : 'text-red-400'}`}>{result.message}</p>
      )}
    </div>
  );
}

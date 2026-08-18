import { useState } from 'react';
import { api } from '../lib/api';
import { Loader2, Lock } from 'lucide-react';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
    setBusy(false);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gray-950 text-gray-100">
      <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-lg p-8 w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2 text-primary-400">
          <Lock size={20} />
          <h1 className="text-lg font-bold">Piece Tester</h1>
        </div>
        <p className="text-sm text-gray-400">Enter the password to continue.</p>
        <label htmlFor="password" className="sr-only">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoFocus
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm bg-primary-600 hover:bg-primary-500 disabled:opacity-50 rounded transition-colors"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          Log in
        </button>
      </form>
    </div>
  );
}

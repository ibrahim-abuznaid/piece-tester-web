import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Trash2, Download, X, Check } from 'lucide-react';

const CONNECTION_TYPES = ['SECRET_TEXT', 'BASIC_AUTH', 'OAUTH2', 'CUSTOM_AUTH', 'NO_AUTH'] as const;

export default function Connections() {
  const qc = useQueryClient();
  const { data: connections, isLoading } = useQuery({ queryKey: ['connections'], queryFn: api.listConnections });
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ piece_name: '', display_name: '', connection_type: 'SECRET_TEXT' as string, connection_value: '{}', actions_config: '{}' });

  const createMut = useMutation({
    mutationFn: (data: any) => api.createConnection(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); resetForm(); },
  });
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => api.updateConnection(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); resetForm(); },
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
  const activateMut = useMutation({
    mutationFn: (id: number) => api.activateConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });

  function resetForm() {
    setShowForm(false);
    setEditId(null);
    setForm({ piece_name: '', display_name: '', connection_type: 'SECRET_TEXT', connection_value: '{}', actions_config: '{}' });
  }

  function startEdit(conn: any) {
    setEditId(conn.id);
    setForm({ piece_name: conn.piece_name, display_name: conn.display_name, connection_type: conn.connection_type, connection_value: '{}', actions_config: JSON.stringify(conn.actions_config ?? {}, null, 2) });
    setShowForm(true);
  }

  function handleSubmit() {
    const payload = {
      ...form,
      connection_value: safeJson(form.connection_value),
      actions_config: safeJson(form.actions_config),
    };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else createMut.mutate(payload);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Connections</h2>
        <button onClick={() => { resetForm(); setShowForm(true); }} className="flex items-center gap-2 px-3 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium">
          <Plus size={16} /> Add Connection
        </button>
      </div>

      {/* Form modal */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6 max-w-xl">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">{editId ? 'Edit Connection' : 'Add Connection'}</h3>
            <button onClick={resetForm} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Piece Name</label>
              <input className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" value={form.piece_name} onChange={(e) => setForm({ ...form, piece_name: e.target.value })} placeholder="@activepieces/piece-http" disabled={!!editId} />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Display Name</label>
              <input className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="My HTTP piece" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Connection Type</label>
              <select className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" value={form.connection_type} onChange={(e) => setForm({ ...form, connection_type: e.target.value })}>
                {CONNECTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Credentials (JSON)</label>
              <CredentialFields type={form.connection_type} value={form.connection_value} onChange={(v) => setForm({ ...form, connection_value: v })} />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Actions Config (JSON) - which actions to test and their inputs</label>
              <textarea className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono h-24" value={form.actions_config} onChange={(e) => setForm({ ...form, actions_config: e.target.value })} placeholder='{"action_name": {"param": "value"}}' />
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={handleSubmit} className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium">
                {editId ? 'Update' : 'Create'}
              </button>
              <button onClick={resetForm} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm">Cancel</button>
            </div>
            {(createMut.error || updateMut.error) && (
              <p className="text-sm text-red-400">{((createMut.error || updateMut.error) as Error)?.message}</p>
            )}
          </div>
        </div>
      )}

      {/* Connections list */}
      {isLoading ? (
        <p className="text-gray-400">Loading...</p>
      ) : !connections?.length ? (
        <p className="text-gray-500">No connections configured yet. Add one to start testing pieces.</p>
      ) : (
        <div className="space-y-3">
          {connections.map((c: any) => (
            <div key={c.id} className={`bg-gray-900 border rounded-lg p-4 flex items-center justify-between ${c.is_active ? 'border-green-500/30' : 'border-gray-800 opacity-70'}`}>
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm">{c.display_name}</p>
                  {c.is_active ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 flex items-center gap-1"><Check size={9} /> Active</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">Inactive</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">{c.piece_name}</p>
                <div className="flex gap-3 mt-1 text-xs text-gray-500">
                  <span className="bg-gray-800 px-2 py-0.5 rounded">{c.connection_type}</span>
                  <span>{Object.keys(c.actions_config || {}).length} actions configured</span>
                </div>
              </div>
              <div className="flex gap-2">
                {!c.is_active && (
                  <button onClick={() => activateMut.mutate(c.id)} className="px-3 py-1.5 bg-primary-600/20 text-primary-400 hover:bg-primary-600/30 rounded text-xs">Activate</button>
                )}
                <button onClick={() => startEdit(c)} className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-xs">Edit</button>
                <button onClick={() => { if (confirm('Delete this connection?')) deleteMut.mutate(c.id); }} className="p-1.5 text-red-400 hover:bg-red-500/10 rounded"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CredentialFields({ type, value, onChange }: { type: string; value: string; onChange: (v: string) => void }) {
  const parsed = safeJson(value);

  if (type === 'NO_AUTH') return <p className="text-sm text-gray-500">No credentials needed.</p>;

  if (type === 'SECRET_TEXT') {
    return (
      <input className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" type="password"
        placeholder="API Key / Secret" value={parsed.secret_text ?? ''}
        onChange={(e) => onChange(JSON.stringify({ secret_text: e.target.value }))} />
    );
  }

  if (type === 'BASIC_AUTH') {
    return (
      <div className="space-y-2">
        <input className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" placeholder="Username / API Key"
          value={parsed.username ?? ''} onChange={(e) => onChange(JSON.stringify({ ...parsed, username: e.target.value }))} />
        <input className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" type="password" placeholder="Password / Token"
          value={parsed.password ?? ''} onChange={(e) => onChange(JSON.stringify({ ...parsed, password: e.target.value }))} />
      </div>
    );
  }

  // OAUTH2, CUSTOM_AUTH -- raw JSON
  return (
    <textarea className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono h-20"
      value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      onChange={(e) => onChange(e.target.value)} placeholder='{"access_token": "...", "client_id": "..."}' />
  );
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

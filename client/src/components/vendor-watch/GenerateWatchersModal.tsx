import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Search, Wand2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { shortPieceName } from '../../lib/vendorWatch';

const MAX_BATCH = 100;

interface PieceSummary { name: string; displayName: string }

export default function GenerateWatchersModal({ watched, onClose }: { watched: Set<string>; onClose: () => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const pieces = useQuery({
    queryKey: ['vw-catalog'],
    queryFn: () => api.listPieces() as Promise<PieceSummary[]>,
    staleTime: 5 * 60_000,
  });

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (pieces.data ?? []).filter(p => !f || `${p.displayName} ${p.name}`.toLowerCase().includes(f));
  }, [pieces.data, filter]);

  const generate = useMutation({
    mutationFn: () => api.vwGenerateBatch([...picked]),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vw-plans'] }); onClose(); },
    onError: (e: Error) => setErr(e.message),
  });

  const toggle = (name: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-gray-800 bg-gray-900 p-4" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">Generate watchers</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>
        <p className="mb-2 text-[12px] text-gray-400">
          An agent reads each piece's source, finds the vendor's changelog, spec and deprecation pages, and checks it can read them.
          Roughly $0.20–0.60 per piece. Generating again replaces the inventory and sources.
        </p>
        <div className="mb-2 flex items-center gap-2 rounded border border-gray-700 bg-gray-950 px-2">
          <Search size={13} className="text-gray-500" />
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter pieces…"
            className="w-full bg-transparent py-1.5 text-sm text-gray-200 outline-none" />
        </div>
        <div className="mb-3 min-h-0 flex-1 overflow-auto rounded border border-gray-800">
          {pieces.isLoading ? (
            <div className="flex items-center gap-2 p-3 text-sm text-gray-400"><Loader2 size={13} className="animate-spin" /> Loading pieces…</div>
          ) : pieces.isError ? (
            <div className="p-3 text-sm text-red-400">{(pieces.error as Error).message}</div>
          ) : (
            <ul>
              {list.map(p => (
                <li key={p.name}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-800">
                    <input type="checkbox" checked={picked.has(p.name)} onChange={() => toggle(p.name)} />
                    <span className="text-gray-200">{p.displayName}</span>
                    <span className="font-mono text-[11px] text-gray-500">{shortPieceName(p.name)}</span>
                    {watched.has(p.name) && <span className="ml-auto rounded bg-gray-800 px-1.5 text-[10px] text-gray-400">has watcher</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && <p className="mb-2 text-[12px] text-red-400">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[12px] text-gray-500">{picked.size} selected (max {MAX_BATCH})</span>
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          <button onClick={() => { setErr(''); generate.mutate(); }}
            disabled={generate.isPending || picked.size === 0 || picked.size > MAX_BATCH}
            className="flex items-center gap-1.5 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
            {generate.isPending ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            Generate {picked.size || ''} watcher{picked.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

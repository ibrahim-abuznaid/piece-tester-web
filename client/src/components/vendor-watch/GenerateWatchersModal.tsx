import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Search, Wand2, X } from 'lucide-react';
import { api, type VwImportanceFields, type VwImportanceFilter } from '../../lib/api';
import {
  addUpTo, compareImportance, countByImportance, generationEstimate, matchesImportance, pickEnterprise, pickTopByUsage,
  shortPieceName, watchedPieceNames,
} from '../../lib/vendorWatch';
import ImportanceBadge from './ImportanceBadge';
import ImportanceFilter from './ImportanceFilter';

const MAX_BATCH = 300;

interface PieceSummary { name: string; displayName: string; categories?: string[] }

const UNRATED: VwImportanceFields = { importance: null, enterprise: 0, usage_projects: null, usage_fetched_at: null };

export default function GenerateWatchersModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [importance, setImportance] = useState<VwImportanceFilter[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const [topN, setTopN] = useState('50');
  const [note, setNote] = useState('');
  const pieces = useQuery({
    queryKey: ['vw-catalog'],
    queryFn: () => api.listPieces() as Promise<PieceSummary[]>,
    staleTime: 5 * 60_000,
  });

  const usage = useQuery({ queryKey: ['vw-usage'], queryFn: api.vwUsage, staleTime: 60_000 });
  const plans = useQuery({ queryKey: ['vw-plans'], queryFn: api.vwPlans });
  const watched = useMemo(() => watchedPieceNames(plans.data ?? []), [plans.data]);

  const rated = useMemo(() => {
    const byName = new Map((usage.data?.pieces ?? []).map(u => [u.piece_name, u as VwImportanceFields]));
    return (pieces.data ?? [])
      .map(p => ({ ...p, ...(byName.get(p.name) ?? UNRATED) }))
      .sort((a, b) => compareImportance(a, b) || a.displayName.localeCompare(b.displayName));
  }, [pieces.data, usage.data]);

  const matching = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rated.filter(p => !f || `${p.displayName} ${p.name}`.toLowerCase().includes(f));
  }, [rated, filter]);
  const list = matching.filter(p => matchesImportance(p, importance));
  const unratedCount = rated.filter(p => !p.importance).length;

  const generate = useMutation({
    mutationFn: () => api.vwGenerateBatch([...picked]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vw-plans'] });
      qc.invalidateQueries({ queryKey: ['vw-generation-queue'] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const toggle = (name: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  const top = Number(topN);
  const topValid = Number.isInteger(top) && top >= 1 && top <= MAX_BATCH;
  const ready = pieces.isSuccess && usage.isSuccess && plans.isSuccess;
  const select = (names: string[], none: string) => {
    const next = addUpTo([...picked], names, MAX_BATCH);
    const fresh = names.filter(n => !picked.has(n)).length;
    const added = next.length - picked.size;
    setPicked(new Set(next));
    setNote(names.length === 0 ? none : added < fresh ? `Added ${added}: a batch holds at most ${MAX_BATCH} pieces.` : '');
  };
  const submit = () => {
    const n = picked.size;
    if (!window.confirm(`Generate watchers for ${n} piece${n === 1 ? '' : 's'}?\n\n${generationEstimate(n)}`)) return;
    setErr('');
    generate.mutate();
  };
  const bulkButton = 'rounded border border-gray-700 px-2 py-1 text-gray-300 hover:bg-gray-800 disabled:opacity-50';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-800 bg-gray-900 p-4" onClick={e => e.stopPropagation()}>
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
        {!pieces.isLoading && !pieces.isError && (
          <ImportanceFilter value={importance} counts={countByImportance(matching)} onChange={setImportance} />
        )}
        {rated.length > 0 && unratedCount > rated.length / 2 && (
          <p className="mb-2 text-[11px] text-gray-500">
            {unratedCount} of {rated.length} pieces have no usage yet. Refresh the whole catalog under Config → Importance to rank them all.
          </p>
        )}
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
          <label className="flex items-center gap-1.5 text-gray-400">
            Top
            <input type="number" min={1} max={MAX_BATCH} value={topN} onChange={e => setTopN(e.target.value)}
              className="w-16 rounded border border-gray-700 bg-gray-950 px-1.5 py-1 text-gray-200" />
            by usage
          </label>
          <button disabled={!ready || !topValid} className={bulkButton}
            onClick={() => select(pickTopByUsage(rated, top, watched), `No unwatched pieces in the top ${top} by usage.`)}>
            Select
          </button>
          <button disabled={!ready} className={bulkButton}
            onClick={() => select(pickEnterprise(rated, watched), 'No unwatched Enterprise pieces left to add.')}>
            Select all Enterprise
          </button>
          <button disabled={picked.size === 0} className={bulkButton} onClick={() => { setPicked(new Set()); setNote(''); }}>
            Clear
          </button>
        </div>
        {note && <p className="mb-2 text-[11px] text-amber-400">{note}</p>}
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
                    <span className="ml-auto flex items-center gap-1.5">
                      {watched.has(p.name) && <span className="rounded bg-gray-800 px-1.5 text-[10px] text-gray-400">has watcher</span>}
                      {p.usage_projects !== null && (
                        <span className="w-14 text-right text-[11px] tabular-nums text-gray-500" title="Cloud projects, all versions">
                          {p.usage_projects.toLocaleString('en-US')}
                        </span>
                      )}
                      <ImportanceBadge row={p} />
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && <p className="mb-2 text-[12px] text-red-400">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[12px] text-gray-500">
            {generationEstimate(picked.size)}
            {picked.size > MAX_BATCH && <span className="text-red-400"> · max {MAX_BATCH} per batch</span>}
          </span>
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          <button onClick={submit}
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

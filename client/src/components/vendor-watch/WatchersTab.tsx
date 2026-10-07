import { Fragment, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, Pause, Play, RefreshCw, Trash2, Wand2 } from 'lucide-react';
import { api, type VwPlan } from '../../lib/api';
import { PLAN_STATUS_CLASS, shortPieceName } from '../../lib/vendorWatch';
import GenerateWatchersModal from './GenerateWatchersModal';
import PlanDetail from './PlanDetail';

type PlanAction = 'run' | 'pause' | 'resume' | 'regenerate' | 'delete';

export default function WatchersTab({ piece }: { piece?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [note, setNote] = useState('');

  const plans = useQuery({
    queryKey: ['vw-plans'],
    queryFn: api.vwPlans,
    refetchInterval: (query) => (query.state.data?.some(p => p.status === 'generating') ? 3000 : 30_000),
  });

  const act = useMutation({
    mutationFn: ({ action, plan }: { action: PlanAction; plan: VwPlan }): Promise<unknown> => {
      if (action === 'run') return api.vwRunPlan(plan.id);
      if (action === 'pause') return api.vwSetPlanStatus(plan.id, 'paused');
      if (action === 'resume') return api.vwSetPlanStatus(plan.id, 'active');
      if (action === 'regenerate') return api.vwGenerate(plan.piece_name);
      return api.vwDeletePlan(plan.id);
    },
    onSuccess: (_data, { action, plan }) => {
      setNote(action === 'run' ? `Run started for ${shortPieceName(plan.piece_name)}.` : '');
      qc.invalidateQueries({ queryKey: ['vw-plans'] });
      qc.invalidateQueries({ queryKey: ['vw-plan', plan.id] });
    },
    onError: (e: Error) => setNote(e.message),
  });

  const runAll = useMutation({
    mutationFn: api.vwRunCycle,
    onSuccess: () => setNote('Watch cycle started. Runs show up under each watcher.'),
    onError: (e: Error) => setNote(e.message),
  });

  const all = plans.data ?? [];
  const rows = all.filter(p => !piece || p.piece_name === piece);
  const watched = new Set(all.map(p => p.piece_name));

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button onClick={() => setShowGenerate(true)} className="flex items-center gap-1.5 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500">
          <Wand2 size={14} /> Generate watchers
        </button>
        <button onClick={() => runAll.mutate()} disabled={runAll.isPending}
          className="flex items-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50">
          <Play size={14} /> Run all now
        </button>
        {note && <span className="text-[12px] text-gray-400">{note}</span>}
      </div>

      {plans.isLoading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : plans.isError ? (
        <div className="text-sm text-red-400">{(plans.error as Error).message}</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-gray-500">No watchers yet. Generate one for a piece to start watching its vendor.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-left text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2" />
                <th className="px-3 py-2">Piece</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Sources</th>
                <th className="px-3 py-2">Last run</th>
                <th className="px-3 py-2">Open</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const runnable = p.status === 'active' || p.status === 'stale';
                return (
                  <Fragment key={p.id}>
                    <tr className="border-t border-gray-800">
                      <td className="px-3 py-2">
                        <button onClick={() => setOpen(open === p.id ? null : p.id)} className="text-gray-500 hover:text-gray-300">
                          {open === p.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-gray-100">{p.piece_display_name || shortPieceName(p.piece_name)}</div>
                        <div className="font-mono text-[11px] text-gray-500">{p.piece_name}{p.piece_version ? ` · v${p.piece_version}` : ''}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-1.5 py-0.5 text-[11px] ${PLAN_STATUS_CLASS[p.status]}`}>
                          {p.status === 'generating' && <Loader2 size={10} className="mr-1 inline animate-spin" />}
                          {p.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-[12px] text-gray-400"
                        title={`${p.sources_total ?? 0} in total, counting disabled and not yet checked`}>
                        {p.sources_ok ?? 0} ok / <span className={p.sources_failing ? 'text-red-400' : undefined}>{p.sources_failing ?? 0} failing</span>
                      </td>
                      <td className="px-3 py-2 text-[12px] text-gray-400">{p.last_run_at ?? '—'}</td>
                      <td className="px-3 py-2 text-[12px] text-gray-300">{p.open_findings ?? 0}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          {runnable && <IconButton title="Run now" onClick={() => act.mutate({ action: 'run', plan: p })}><Play size={13} /></IconButton>}
                          {runnable && <IconButton title="Pause" onClick={() => act.mutate({ action: 'pause', plan: p })}><Pause size={13} /></IconButton>}
                          {p.status === 'paused' && <IconButton title="Resume" onClick={() => act.mutate({ action: 'resume', plan: p })}><Play size={13} /></IconButton>}
                          {p.status !== 'generating' && (
                            <IconButton title="Regenerate" onClick={() => {
                              const resume = p.status === 'paused' ? ' It will also resume the watcher.' : '';
                              if (window.confirm(`Regenerate the watcher for ${p.piece_name}? This runs the AI agent again (about $0.20–0.60) and replaces its sources.${resume}`)) {
                                act.mutate({ action: 'regenerate', plan: p });
                              }
                            }}>
                              <RefreshCw size={13} />
                            </IconButton>
                          )}
                          {p.status !== 'generating' && (
                            <IconButton title="Delete" onClick={() => {
                              if (window.confirm(`Delete the watcher for ${p.piece_name} and all its findings?`)) act.mutate({ action: 'delete', plan: p });
                            }}>
                              <Trash2 size={13} />
                            </IconButton>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open === p.id && (
                      <tr className="border-t border-gray-800 bg-gray-950/50">
                        <td colSpan={7}><PlanDetail planId={p.id} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showGenerate && <GenerateWatchersModal watched={watched} onClose={() => setShowGenerate(false)} />}
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button title={title} onClick={onClick} className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200">
      {children}
    </button>
  );
}

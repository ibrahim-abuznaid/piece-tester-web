import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import BoardCard from './BoardCard';
import { COLUMNS, groupByColumn, isConfirmed, type ColumnKey } from '../lib/healthBoard';
import { CheckCircle2, HelpCircle } from 'lucide-react';

const COLUMN_DOT: Record<ColumnKey, string> = {
  errors: 'bg-red-500',
  connection: 'bg-amber-500',
  reported: 'bg-green-500',
  muted: 'bg-gray-500',
};

export default function HealthBoard() {
  const { data: items = [], isLoading } = useQuery({ queryKey: ['attention'], queryFn: api.getAttention, refetchInterval: 30_000 });
  const { data: reports = [] } = useQuery({ queryKey: ['reported'], queryFn: api.getReported, refetchInterval: 30_000 });
  const { data: health = [] } = useQuery({ queryKey: ['piece-health'], queryFn: api.getPieceHealth, refetchInterval: 30_000 });

  const [showHealthy, setShowHealthy] = useState(false);

  if (isLoading) return <p className="text-sm text-gray-400">Loading piece health…</p>;

  const reportedPieces = new Set(reports.map(r => r.piece_name));
  const reportUrlByPiece = new Map(reports.map(r => [r.piece_name, r.linear_url]));
  const grouped = groupByColumn(items, reportedPieces);

  const healthy = health.filter(h => h.status === 'healthy');
  const unknown = health.filter(h => h.status === 'unknown');

  return (
    <section>
      {items.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-400 flex items-center gap-2 mb-4">
          <CheckCircle2 size={15} className="text-green-400" /> Everything is passing — nothing needs attention.
        </div>
      ) : (
        // Full-bleed columns row: break out of the page's max-w-6xl container to fill the
        // main area (viewport minus the w-56 / 14rem sidebar). Uniform fixed-width,
        // equal-height columns; the track is centered when it fits and scrolls when it
        // doesn't (w-max + mx-auto inside an overflow-x-auto parent).
        <div className="w-[calc(100vw-14rem)] ml-[calc(50%-50vw+7rem)] overflow-x-auto px-6 pb-3">
          <div className="flex items-stretch gap-3 w-max mx-auto">
            {COLUMNS.map(col => {
              const cards = grouped[col.key];
              const confirmed = cards.filter(isConfirmed);
              const unconfirmed = cards.filter(c => !isConfirmed(c));
              const reportable = col.key === 'errors'; // every error in this column can be reported
              return (
                <div key={col.key} className="w-[300px] shrink-0 h-[calc(100vh-300px)] min-h-[360px] flex flex-col rounded-xl border border-gray-800 bg-gray-900/30">
                  <div className="px-3.5 py-3 border-b border-gray-800/70 shrink-0">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${COLUMN_DOT[col.key]}`} />
                      <span className="text-sm font-semibold text-gray-200">{col.label}</span>
                      <span className="ml-auto text-[11px] font-medium text-gray-400 bg-gray-800 rounded-full px-2 py-0.5 min-w-[22px] text-center">{cards.length}</span>
                    </div>
                    <p className="text-[11px] text-gray-500 mt-1 leading-snug">{col.hint}</p>
                  </div>
                  <div className="p-2.5 space-y-2 overflow-y-auto flex-1">
                    {cards.length === 0 && (
                      <div className="flex items-center justify-center h-full text-[11px] text-gray-600">No pieces</div>
                    )}
                    {confirmed.map(it => <BoardCard key={it.plan_id} item={it} reportable={reportable} reportUrl={reportUrlByPiece.get(it.piece_name)} />)}
                    {unconfirmed.length > 0 && confirmed.length > 0 && (
                      <div className="flex items-center gap-2 pt-1">
                        <span className="h-px flex-1 bg-gray-800" />
                        <span className="text-[9px] uppercase tracking-wide text-gray-600">unconfirmed</span>
                        <span className="h-px flex-1 bg-gray-800" />
                      </div>
                    )}
                    {unconfirmed.map(it => <BoardCard key={it.plan_id} item={it} reportable={reportable} reportUrl={reportUrlByPiece.get(it.piece_name)} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-4">
        <button onClick={() => setShowHealthy(v => !v)} aria-expanded={showHealthy}
          className="flex items-center gap-3 text-xs text-gray-500 hover:text-gray-300">
          <span className="flex items-center gap-1"><CheckCircle2 size={13} className="text-green-400" /> {healthy.length} healthy</span>
          <span className="flex items-center gap-1"><HelpCircle size={13} className="text-gray-500" /> {unknown.length} unknown</span>
          <span className="text-gray-600">{showHealthy ? 'hide' : 'show'}</span>
        </button>
        {showHealthy && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[...healthy, ...unknown].map(h => (
              <span key={h.piece_name} className="text-[10px] text-gray-400 bg-gray-900 border border-gray-800 rounded px-1.5 py-0.5">
                {h.piece_name.replace('@activepieces/piece-', '')}
              </span>
            ))}
            {healthy.length + unknown.length === 0 && <span className="text-[11px] text-gray-600">No healthy pieces yet.</span>}
          </div>
        )}
      </div>
    </section>
  );
}

import { type PieceGroup, pieceKindCounts } from '../lib/healthBoard';
import { ChevronRight, CheckCircle } from 'lucide-react';

const clean = (n: string) => n.replace('@activepieces/piece-', '');

/** A single piece on the Health board: one card summarising all its failing actions. */
export default function PieceCard({ group, reportUrl, onOpen }: {
  group: PieceGroup;
  reportUrl?: string;
  onOpen: () => void;
}) {
  const counts = pieceKindCounts(group.items);
  const worst = group.items.reduce((m, it) => Math.max(m, it.fail_streak), 0);
  const n = group.items.length;

  return (
    <div className={`rounded-lg border bg-gray-900 transition-colors ${group.confirmed ? 'border-gray-700/80' : 'border-gray-800 opacity-70'}`}>
      <button onClick={onOpen}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left rounded-lg hover:bg-gray-800/40">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-100 truncate leading-tight flex-1">{clean(group.piece_name)}</span>
            <ChevronRight size={13} className="text-gray-500 shrink-0" />
          </div>

          <div className="flex items-center flex-wrap gap-1.5 mt-2">
            <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-red-500/15 text-red-300 border-red-500/25">
              {n} failing
            </span>
            {counts.connection > 0 && group.lane !== 'connection' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-amber-500/15 text-amber-300 border-amber-500/25">
                {counts.connection} re-auth
              </span>
            )}
            {counts.muted > 0 && group.lane !== 'muted' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-gray-500/15 text-gray-400 border-gray-600/40">
                {counts.muted} muted
              </span>
            )}
            <span className="ml-auto text-[10px] text-gray-500 tabular-nums shrink-0">{worst}× fail</span>
          </div>
        </div>
      </button>

      {reportUrl && (
        <div className="px-3 pb-2.5 pl-3">
          <a href={reportUrl} target="_blank" rel="noreferrer"
            className="flex items-center gap-1 text-[10px] text-green-500 hover:text-green-400 w-fit">
            <CheckCircle size={10} /> Linear ↗
          </a>
        </div>
      )}
    </div>
  );
}

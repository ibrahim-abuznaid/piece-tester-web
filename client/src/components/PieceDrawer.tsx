import { useEffect } from 'react';
import { type PieceGroup } from '../lib/healthBoard';
import ActionErrorRow from './ActionErrorRow';
import { X, CheckCircle } from 'lucide-react';

const clean = (n: string) => n.replace('@activepieces/piece-', '');

/** Slide-over listing every failing action of one piece. Closes on backdrop / Esc. */
export default function PieceDrawer({ group, reportUrl, onClose }: {
  group: PieceGroup;
  reportUrl?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const n = group.items.length;
  // The whole piece is reportable when it sits in the Errors lane (report is per-piece).
  const reportable = group.lane === 'errors';

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <aside className="fixed right-0 top-0 h-full w-[380px] max-w-[90vw] bg-gray-950 border-l border-gray-800 z-50 flex flex-col shadow-xl">
        <header className="flex items-start gap-2 px-4 py-3 border-b border-gray-800 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold text-gray-100 truncate">{clean(group.piece_name)}</div>
            <div className="text-[11px] text-gray-500 mt-0.5">{n} failing action{n === 1 ? '' : 's'}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-200 mt-0.5">
            <X size={16} />
          </button>
        </header>

        {reportUrl && (
          <div className="px-4 py-2 border-b border-gray-800/70 shrink-0">
            <a href={reportUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-[11px] text-green-500 hover:text-green-400 w-fit">
              <CheckCircle size={12} /> Reported in Linear ↗
            </a>
          </div>
        )}

        <div className="p-3 space-y-2 overflow-y-auto flex-1">
          {group.items.map(it => (
            <ActionErrorRow key={it.plan_id} item={it} reportable={reportable} />
          ))}
        </div>
      </aside>
    </>
  );
}

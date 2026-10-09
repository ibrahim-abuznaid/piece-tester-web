import { History, ChevronRight } from 'lucide-react';
import type { SetupRunSummary } from '../lib/api';

export function SetupRunHistory({ runs, onOpen }: { runs: SetupRunSummary[]; onOpen: (id: number) => void }) {
  if (runs.length === 0) {
    return <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center text-gray-500 text-sm">No setup runs yet.</div>;
  }
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
      {runs.map(r => (
        <button key={r.id} onClick={() => onOpen(r.id)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 text-left">
          <div className="flex items-center gap-3">
            <History size={16} className="text-primary-400" />
            <div>
              <div className="text-sm">{new Date(r.started_at.replace(' ', 'T') + 'Z').toLocaleString()}</div>
              <div className="text-xs text-gray-500">
                {r.piece_count} pieces · {r.plans_created} plans · {r.plans_errored} err · {r.schedules_created} schedules
                {r.first_run_wave_id && ` · first run ${r.first_run_completed_at ? 'done' : 'running'}`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className={r.status === 'done' ? 'text-green-400' : r.status === 'running' ? 'text-blue-400' : 'text-yellow-400'}>{r.status}</span>
            <ChevronRight size={14} />
          </div>
        </button>
      ))}
    </div>
  );
}

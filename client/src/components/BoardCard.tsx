import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type AttentionItem } from '../lib/api';
import { isConfirmed } from '../lib/healthBoard';
import ErrorPlaybook from './ErrorPlaybook';
import { ChevronDown, ChevronRight, ExternalLink, CheckCircle } from 'lucide-react';

const clean = (n: string) => n.replace('@activepieces/piece-', '');

const CHIP: Record<string, string> = {
  piece_error: 'bg-red-500/15 text-red-300 border-red-500/25',
  auth: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  connection_broken: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  bad_request: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
  not_found: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
  assert_failed: 'bg-purple-500/15 text-purple-300 border-purple-500/25',
  rate_limit: 'bg-gray-500/15 text-gray-300 border-gray-600/40',
  transient: 'bg-gray-500/15 text-gray-300 border-gray-600/40',
  unknown: 'bg-gray-500/15 text-gray-400 border-gray-600/40',
};

export default function BoardCard({ item, reportUrl }: { item: AttentionItem; reportUrl?: string }) {
  const [open, setOpen] = useState(false);
  const confirmed = isConfirmed(item);
  const chip = CHIP[item.category] ?? CHIP.unknown;

  return (
    <div className={`rounded-lg border bg-gray-900 transition-colors ${confirmed ? 'border-gray-700/80' : 'border-gray-800 opacity-70'}`}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left rounded-lg hover:bg-gray-800/40">
        {open
          ? <ChevronDown size={13} className="text-gray-500 mt-1 shrink-0" />
          : <ChevronRight size={13} className="text-gray-500 mt-1 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-100 truncate leading-tight">{clean(item.piece_name)}</div>
          <div className="text-[11px] text-gray-500 truncate mt-0.5">{item.action_name}</div>

          <div className="flex items-center gap-1.5 mt-2">
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${chip}`}>{item.category}</span>
            <span className="ml-auto text-[10px] text-gray-500 tabular-nums shrink-0">{item.fail_streak}× fail</span>
          </div>

          {item.error && <p className="text-[11px] text-gray-500 mt-2 line-clamp-2 leading-snug">{item.error}</p>}
        </div>
      </button>

      {/* Deep-links live outside the toggle button — nesting <a> in <button> is invalid HTML. */}
      {(reportUrl || item.backlinks) && (
        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 px-3 pb-2.5 pl-8">
          {reportUrl && (
            <a href={reportUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-[10px] text-green-500 hover:text-green-400">
              <CheckCircle size={10} /> Linear ↗
            </a>
          )}
          {item.backlinks && (
            <>
              <a href={item.backlinks.activepieces} target="_blank" rel="noreferrer"
                className="flex items-center gap-1 text-[10px] text-primary-400 hover:underline">
                Fix in AP <ExternalLink size={9} />
              </a>
              <Link to={item.backlinks.reimport}
                className="text-[10px] text-primary-400 hover:underline">Re-import</Link>
            </>
          )}
        </div>
      )}

      {open && (
        <div className="px-3 pb-3">
          <ErrorPlaybook
            pieceName={item.piece_name}
            actionName={item.action_name}
            category={item.category}
            planId={item.plan_id}
            lastRunId={item.last_run_id}
            failStreak={item.fail_streak}
            flaky={item.flaky}
            quarantined={item.quarantined}
            quarantineId={item.quarantine_id}
            reportable={item.bucket === 'likely_broken' || item.category === 'piece_error'}
          />
        </div>
      )}
    </div>
  );
}

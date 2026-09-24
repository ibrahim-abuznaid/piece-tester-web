import { useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { formatDateRange } from '../lib/bugTrendFormat';
import KpiRow from '../components/bug-trend/KpiRow';
import OpenedPerWeekChart from '../components/bug-trend/OpenedPerWeekChart';
import OpenBugsChart from '../components/bug-trend/OpenBugsChart';
import BugTable from '../components/bug-trend/BugTable';

const DEFAULT_FROM = '2026-06-01';
const FOOTNOTE =
  'Counts GIT bugs whose current assignee is on the Pieces team, plus bugs the Piece Tester filed on PIE. ' +
  'Support routes some piece bugs to other engineers, so routing changes move these numbers. ' +
  'Canceled and duplicate issues are left out. Weeks start Monday (UTC). Lighter bar = this week so far.';

export default function BugTrend() {
  const [from, setFrom] = useState(DEFAULT_FROM);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ['bug-trend', from, refreshNonce],
    queryFn: () => api.getBugTrend({ from, refresh: refreshNonce > 0 }),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const refresh = () => setRefreshNonce(n => n + 1);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">Bug Trend</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-400">
          <label className="flex items-center gap-2">
            From
            <input type="date" value={from} max={new Date().toISOString().slice(0, 10)}
              onChange={e => { if (e.target.value) { setFrom(e.target.value); setRefreshNonce(0); } }}
              className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200" />
          </label>
          {data?.state === 'ok' && <span>Updated {data.fetchedAt.slice(11, 16)} UTC</span>}
          <button onClick={refresh} disabled={query.isFetching} title="Pull fresh data from Linear"
            className="flex items-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-gray-200 hover:bg-gray-800 disabled:opacity-50">
            <RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {query.isLoading && (
        <div className="flex items-center gap-2 text-gray-400"><Loader2 size={16} className="animate-spin" /> Loading bugs from Linear…</div>
      )}
      {query.error && (
        <div className="mb-3 flex items-center justify-between rounded border border-red-800/60 bg-red-900/20 px-3 py-2 text-[12px] text-red-300">
          <span>{(query.error as Error).message}</span>
          <button onClick={refresh} className="text-red-200 underline">Retry</button>
        </div>
      )}
      {data?.state === 'needs-setup' && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-center">
          <p className="text-gray-200">{data.missing === 'key' ? 'Connect Linear to see the bug trend' : 'Pick the team members to count'}</p>
          <Link to="/settings" className="mt-3 inline-block rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500">
            Open Settings
          </Link>
        </div>
      )}
      {data?.state === 'ok' && (
        <div className="overflow-x-auto">
          {data.warnings.map(w => (
            <p key={w} className="mx-auto mb-2 w-[960px] rounded border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-[12px] text-amber-300">{w}</p>
          ))}
          <div ref={cardRef} className="mx-auto w-[960px] space-y-6 rounded-lg border border-gray-800 bg-gray-900 p-6">
            <div>
              <h3 className="text-lg font-semibold text-gray-100">Pieces Team bugs</h3>
              <p className="text-[12px] text-gray-500">
                GIT 🐛 bug assigned to the team + tester-filed PIE · {formatDateRange(data.trend.from, data.trend.asOf)}
              </p>
            </div>
            <KpiRow kpis={data.trend.kpis} />
            <OpenedPerWeekChart weeks={data.trend.weeks} markerDate={data.trend.markerDate} />
            <OpenBugsChart days={data.trend.days} markerDate={data.trend.markerDate} />
            <p className="text-[11px] leading-relaxed text-gray-500">{FOOTNOTE}</p>
          </div>
          <div className="mx-auto w-[960px]"><BugTable issues={data.trend.issues} /></div>
        </div>
      )}
    </div>
  );
}

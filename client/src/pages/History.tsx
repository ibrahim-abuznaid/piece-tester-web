import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type PlanRunRecord, type StepResult } from '../lib/api';
import TestResultBadge from '../components/TestResultBadge';
import {
  ChevronDown, ChevronRight, Clock, CheckCircle, XCircle,
  Loader2, SkipForward, MessageSquare, Play, Calendar,
  Filter, RefreshCw, Trash2,
} from 'lucide-react';

type TabId = 'plan-runs' | 'legacy-runs';

export default function History() {
  const [tab, setTab] = useState<TabId>('plan-runs');
  const [pieceFilter, setPieceFilter] = useState('');

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Test Logs</h2>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-4 border-b border-gray-800 pb-1">
        {([
          { id: 'plan-runs' as TabId, label: 'Plan Runs', icon: Play },
          { id: 'legacy-runs' as TabId, label: 'Legacy Runs', icon: Clock },
        ]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm rounded-t transition-colors ${
              tab === t.id
                ? 'bg-gray-800 text-white border-b-2 border-primary-400'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
            }`}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}

        <div className="flex-1" />

        {/* Piece filter */}
        <div className="flex items-center gap-2">
          <Filter size={12} className="text-gray-500" />
          <input
            type="text"
            placeholder="Filter by piece..."
            value={pieceFilter}
            onChange={e => setPieceFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 w-48"
          />
        </div>
      </div>

      {tab === 'plan-runs' && <PlanRunHistory pieceFilter={pieceFilter} />}
      {tab === 'legacy-runs' && <LegacyRunHistory pieceFilter={pieceFilter} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Plan Run History
// ══════════════════════════════════════════════════════════════

function PlanRunHistory({ pieceFilter }: { pieceFilter: string }) {
  const { data: runs, isLoading, refetch } = useQuery({
    queryKey: ['plan-runs-all', pieceFilter],
    queryFn: () => api.listAllPlanRuns({
      pieceName: pieceFilter || undefined,
      limit: 100,
    }),
    refetchInterval: 10_000,
  });

  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [showClearMenu, setShowClearMenu] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const clearMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (clearMenuRef.current && !clearMenuRef.current.contains(e.target as Node)) {
        setShowClearMenu(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  async function handleDeleteRun(runId: number) {
    setDeletingId(runId);
    try {
      await api.deletePlanRun(runId);
      if (expandedRun === runId) setExpandedRun(null);
      refetch();
    } finally {
      setDeletingId(null);
    }
  }

  async function handleClearBefore(days: number | null) {
    setShowClearMenu(false);
    const label = days === null ? 'all plan run logs' : `plan run logs older than ${days} days`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    const before = days !== null ? daysAgoISO(days) : undefined;
    await api.deleteAllPlanRuns(before);
    setExpandedRun(null);
    refetch();
  }

  if (isLoading) return <div className="text-gray-400">Loading plan runs...</div>;

  const filteredRuns = (runs || []).filter(r =>
    !pieceFilter || r.piece_name.toLowerCase().includes(pieceFilter.toLowerCase()) ||
    r.target_action.toLowerCase().includes(pieceFilter.toLowerCase())
  );

  const grouped = groupByDate(filteredRuns);

  return (
    <div className="space-y-6">
      {/* Summary stats + controls */}
      {(() => {
        const total = filteredRuns.length;
        const completed = filteredRuns.filter(r => r.status === 'completed').length;
        const failed = filteredRuns.filter(r => r.status === 'failed').length;
        const running = filteredRuns.filter(r => r.status === 'running').length;
        return (
          <div className="flex items-center gap-4 text-sm mb-2">
            <span className="text-gray-400">Total: {total}</span>
            <span className="text-green-400">Passed: {completed}</span>
            <span className="text-red-400">Failed: {failed}</span>
            {running > 0 && <span className="text-blue-400">Running: {running}</span>}
            <button onClick={() => refetch()} className="text-gray-500 hover:text-gray-300 ml-2">
              <RefreshCw size={12} />
            </button>

            {/* Clear logs dropdown */}
            <div className="relative ml-auto" ref={clearMenuRef}>
              <button
                onClick={() => setShowClearMenu(v => !v)}
                disabled={total === 0}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-gray-700 text-gray-400 hover:text-red-400 hover:border-red-500/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Trash2 size={11} />
                Clear Logs
                <ChevronDown size={10} className={`transition-transform ${showClearMenu ? 'rotate-180' : ''}`} />
              </button>
              {showClearMenu && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-20 overflow-hidden">
                  <div className="px-3 py-2 text-[10px] text-gray-500 border-b border-gray-800 uppercase tracking-wider">Delete range</div>
                  {[
                    { label: 'Older than 7 days', days: 7 },
                    { label: 'Older than 30 days', days: 30 },
                    { label: 'Older than 90 days', days: 90 },
                  ].map(opt => (
                    <button
                      key={opt.days}
                      onClick={() => handleClearBefore(opt.days)}
                      className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 hover:text-red-400 transition-colors"
                    >
                      {opt.label}
                    </button>
                  ))}
                  <div className="border-t border-gray-800">
                    <button
                      onClick={() => handleClearBefore(null)}
                      className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors font-medium"
                    >
                      Delete all logs
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {filteredRuns.length === 0 && (
        <p className="text-gray-500">No plan runs yet. Run test plans from a piece's detail page.</p>
      )}

      {grouped.map(([dateLabel, dateRuns]) => (
        <div key={dateLabel}>
          <h3 className="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-2">{dateLabel}</h3>
          <div className="space-y-2">
            {dateRuns.map((run) => (
              <PlanRunCard
                key={run.id}
                run={run}
                expanded={expandedRun === run.id}
                onToggle={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                onDelete={() => handleDeleteRun(run.id)}
                isDeleting={deletingId === run.id}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlanRunCard({ run, expanded, onToggle, onDelete, isDeleting }: {
  run: PlanRunRecord;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}) {
  const statusIcon = run.status === 'completed' ? <CheckCircle size={14} className="text-green-400" />
    : run.status === 'failed' ? <XCircle size={14} className="text-red-400" />
    : run.status === 'running' ? <Loader2 size={14} className="text-blue-400 animate-spin" />
    : run.status.startsWith('paused') ? <MessageSquare size={14} className="text-yellow-400" />
    : <Clock size={14} className="text-gray-500" />;

  const triggerIcon = run.trigger_type === 'scheduled'
    ? <Calendar size={10} className="text-purple-400" />
    : <Play size={10} className="text-blue-400" />;

  const statusBorder = run.status === 'completed' ? 'border-green-500/20'
    : run.status === 'failed' ? 'border-red-500/20'
    : run.status === 'running' ? 'border-blue-500/20'
    : 'border-gray-800';

  const stepResults = run.step_results || [];
  const stepsCompleted = stepResults.filter(s => s.status === 'completed').length;
  const stepsFailed = stepResults.filter(s => s.status === 'failed').length;
  const totalSteps = stepResults.length;

  // Duration
  const duration = run.completed_at && run.started_at
    ? Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000)
    : null;

  return (
    <div className={`border rounded-lg ${statusBorder} bg-gray-900 overflow-hidden ${isDeleting ? 'opacity-50' : ''}`}>
      <div
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/50 transition-colors cursor-pointer"
      >
        {statusIcon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-200">{run.target_action}</span>
            <span className="text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{run.piece_name}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="flex items-center gap-1 text-[10px] text-gray-500">
              {triggerIcon}
              {run.trigger_type}
            </span>
            <span className="text-[10px] text-gray-600">#{run.id}</span>
          </div>
        </div>

        {/* Step progress mini-dots */}
        <div className="flex items-center gap-0.5">
          {stepResults.map((sr, i) => {
            const color = sr.status === 'completed' ? 'bg-green-500'
              : sr.status === 'failed' ? 'bg-red-500'
              : sr.status === 'running' ? 'bg-blue-500 animate-pulse'
              : sr.status === 'waiting' ? 'bg-yellow-500'
              : sr.status === 'skipped' ? 'bg-gray-600'
              : 'bg-gray-700';
            return <div key={i} className={`w-2.5 h-1.5 rounded-sm ${color}`} />;
          })}
        </div>

        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span>{stepsCompleted}/{totalSteps} steps</span>
          {stepsFailed > 0 && <span className="text-red-400">{stepsFailed} failed</span>}
          {duration != null && <span>{duration}s</span>}
          <span>{formatTime(run.started_at)}</span>
        </div>

        {/* Delete button */}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          disabled={isDeleting}
          className="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
          title="Delete this run"
        >
          {isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        </button>

        {expanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
      </div>

      {expanded && (
        <div className="border-t border-gray-800/50 px-4 py-3 space-y-1">
          {stepResults.length === 0 && <p className="text-xs text-gray-500">No step results recorded.</p>}
          {stepResults.map((sr, idx) => (
            <StepResultRow key={sr.stepId || idx} sr={sr} idx={idx} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepResultRow({ sr, idx }: { sr: StepResult; idx: number }) {
  const [showOutput, setShowOutput] = useState(false);

  const stepIcon = sr.status === 'completed' ? <CheckCircle size={12} className="text-green-400" />
    : sr.status === 'failed' ? <XCircle size={12} className="text-red-400" />
    : sr.status === 'running' ? <Loader2 size={12} className="text-blue-400 animate-spin" />
    : sr.status === 'waiting' ? <MessageSquare size={12} className="text-yellow-400" />
    : sr.status === 'skipped' ? <SkipForward size={12} className="text-gray-600" />
    : <Clock size={12} className="text-gray-600" />;

  return (
    <div>
      <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
        sr.status === 'failed' ? 'bg-red-500/5' :
        sr.status === 'completed' ? 'bg-green-500/5' : ''
      }`}>
        <span className="text-[10px] text-gray-600 w-3 text-right">{idx + 1}</span>
        {stepIcon}
        <span className="flex-1 truncate text-gray-300">{sr.label || sr.stepId}</span>
        {sr.label && <span className="text-[10px] text-gray-600 font-mono shrink-0">{sr.stepId}</span>}
        {sr.duration_ms > 0 && (
          <span className="text-[10px] text-gray-500">{(sr.duration_ms / 1000).toFixed(1)}s</span>
        )}
        {sr.output != null && sr.status === 'completed' && (
          <button
            onClick={() => setShowOutput(!showOutput)}
            className="text-[10px] text-gray-500 hover:text-gray-300 px-1"
          >
            {showOutput ? 'hide' : 'output'}
          </button>
        )}
      </div>

      {sr.error && (
        <div className="ml-8 mt-1 text-[10px] text-red-400 bg-red-500/5 rounded p-1.5 font-mono whitespace-pre-wrap">
          {sr.error}
        </div>
      )}

      {showOutput && sr.output != null && (
        <div className="ml-8 mt-1 text-[10px] text-green-400/60 bg-green-500/5 rounded p-1.5 font-mono max-h-32 overflow-y-auto whitespace-pre-wrap">
          {typeof sr.output === 'string' ? sr.output : JSON.stringify(sr.output, null, 2)}
        </div>
      )}

      {sr.humanResponse && (
        <div className="ml-8 mt-1 text-[10px] text-purple-400/80 bg-purple-500/5 rounded p-1.5">
          Human response: {sr.humanResponse}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Legacy Run History (old test_runs / test_results)
// ══════════════════════════════════════════════════════════════

function LegacyRunHistory({ pieceFilter }: { pieceFilter: string }) {
  const { data: runs, isLoading, refetch } = useQuery({
    queryKey: ['history', pieceFilter],
    queryFn: () => api.listHistory(50),
  });
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [runDetail, setRunDetail] = useState<any>(null);
  const [showClearMenu, setShowClearMenu] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const clearMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (clearMenuRef.current && !clearMenuRef.current.contains(e.target as Node)) {
        setShowClearMenu(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  async function toggleExpand(runId: number) {
    if (expandedRun === runId) {
      setExpandedRun(null);
      setRunDetail(null);
      return;
    }
    setExpandedRun(runId);
    const data = await api.getHistoryRun(runId);
    setRunDetail(data);
  }

  async function handleDeleteRun(runId: number) {
    setDeletingId(runId);
    try {
      await api.deleteHistoryRun(runId);
      if (expandedRun === runId) { setExpandedRun(null); setRunDetail(null); }
      refetch();
    } finally {
      setDeletingId(null);
    }
  }

  async function handleClearBefore(days: number | null) {
    setShowClearMenu(false);
    const label = days === null ? 'all legacy run logs' : `legacy run logs older than ${days} days`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    const before = days !== null ? daysAgoISO(days) : undefined;
    await api.deleteAllHistoryRuns(before);
    setExpandedRun(null);
    setRunDetail(null);
    refetch();
  }

  if (isLoading) return <div className="text-gray-400">Loading history...</div>;

  const total = runs?.length ?? 0;

  return (
    <div className="space-y-2">
      {/* Controls row */}
      <div className="flex items-center mb-2">
        <span className="text-sm text-gray-500">{total} run{total !== 1 ? 's' : ''}</span>
        <div className="relative ml-auto" ref={clearMenuRef}>
          <button
            onClick={() => setShowClearMenu(v => !v)}
            disabled={total === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-gray-700 text-gray-400 hover:text-red-400 hover:border-red-500/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 size={11} />
            Clear Logs
            <ChevronDown size={10} className={`transition-transform ${showClearMenu ? 'rotate-180' : ''}`} />
          </button>
          {showClearMenu && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-20 overflow-hidden">
              <div className="px-3 py-2 text-[10px] text-gray-500 border-b border-gray-800 uppercase tracking-wider">Delete range</div>
              {[
                { label: 'Older than 7 days', days: 7 },
                { label: 'Older than 30 days', days: 30 },
                { label: 'Older than 90 days', days: 90 },
              ].map(opt => (
                <button
                  key={opt.days}
                  onClick={() => handleClearBefore(opt.days)}
                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 hover:text-red-400 transition-colors"
                >
                  {opt.label}
                </button>
              ))}
              <div className="border-t border-gray-800">
                <button
                  onClick={() => handleClearBefore(null)}
                  className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors font-medium"
                >
                  Delete all logs
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {total === 0 && (
        <p className="text-gray-500">No legacy test runs. These are from the old single-action test runner.</p>
      )}

      {(runs || []).map((run: any) => (
        <div
          key={run.id}
          className={`bg-gray-900 border border-gray-800 rounded-lg overflow-hidden transition-opacity ${deletingId === run.id ? 'opacity-50' : ''}`}
        >
          <div
            onClick={() => toggleExpand(run.id)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3">
              {expandedRun === run.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="text-sm font-medium">Run #{run.id}</span>
              <TestResultBadge status={run.status} />
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                run.trigger_type === 'scheduled'
                  ? 'bg-purple-500/10 text-purple-400'
                  : 'bg-blue-500/10 text-blue-400'
              }`}>{run.trigger_type}</span>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span className="text-green-400">{run.passed} passed</span>
              <span className="text-red-400">{run.failed} failed</span>
              <span className="text-orange-400">{run.errors} errors</span>
              <span>{formatDate(run.started_at)}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteRun(run.id); }}
                disabled={deletingId === run.id}
                className="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                title="Delete this run"
              >
                {deletingId === run.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              </button>
            </div>
          </div>

          {expandedRun === run.id && runDetail && (
            <div className="border-t border-gray-800 px-4 py-3 space-y-2">
              {runDetail.results?.length === 0 && <p className="text-sm text-gray-500">No results recorded.</p>}
              {runDetail.results?.map((r: any, i: number) => (
                <div key={i} className="flex items-center justify-between py-1.5 px-3 bg-gray-800/50 rounded text-sm">
                  <div className="flex items-center gap-3">
                    <TestResultBadge status={r.status} />
                    <span className="text-gray-300">{r.piece_name}</span>
                    <span className="text-gray-500">{r.action_name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {r.duration_ms > 0 && <span>{(r.duration_ms / 1000).toFixed(1)}s</span>}
                    {r.error_message && <span className="text-red-400 max-w-sm truncate" title={r.error_message}>{r.error_message}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

function formatDate(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function groupByDate(runs: PlanRunRecord[]): [string, PlanRunRecord[]][] {
  const groups = new Map<string, PlanRunRecord[]>();
  const now = new Date();
  const todayStr = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();

  for (const run of runs) {
    const d = new Date(run.started_at);
    let label: string;
    if (d.toDateString() === todayStr) label = 'Today';
    else if (d.toDateString() === yesterdayStr) label = 'Yesterday';
    else label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(run);
  }

  return Array.from(groups.entries());
}

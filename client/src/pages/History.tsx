import { useState, useRef, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type PlanRunRecord, type StepResult } from '../lib/api';
import { runDurationSeconds, formatDbTime, parseDbTime } from '../lib/time';
import {
  ChevronDown, ChevronRight, Clock, CheckCircle, XCircle,
  Loader2, SkipForward, MessageSquare, Play, Calendar,
  Filter, RefreshCw, Trash2,
} from 'lucide-react';

export default function History() {
  const [searchParams] = useSearchParams();
  const [pieceFilter, setPieceFilter] = useState(searchParams.get('piece') ?? '');

  useEffect(() => {
    const p = searchParams.get('piece');
    if (p) setPieceFilter(p);
  }, [searchParams]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Test Logs</h2>
          <p className="text-sm text-gray-500 mt-1">
            Every run, newest first — manual and scheduled.{' '}
            <Link to="/schedules?tab=logs" className="text-primary-400 hover:underline">Scheduled sweeps grouped by fire →</Link>
          </p>
        </div>
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
      <PlanRunHistory pieceFilter={pieceFilter} />
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

  // schedule_id → label, so scheduled runs can name the schedule that fired them.
  const { data: schedules = [] } = useQuery({ queryKey: ['schedules'], queryFn: api.listSchedules });
  const scheduleLabels: Record<number, string> = {};
  for (const s of schedules as any[]) scheduleLabels[s.id] = s.label || `Schedule #${s.id}`;

  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [triggerFilter, setTriggerFilter] = useState<'all' | 'manual' | 'scheduled'>('all');
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

  const filteredRuns = (runs || []).filter(r => {
    const matchesPiece = !pieceFilter ||
      r.piece_name.toLowerCase().includes(pieceFilter.toLowerCase()) ||
      r.target_action.toLowerCase().includes(pieceFilter.toLowerCase());
    // "Scheduled" = fired by a cron sweep; "Manual" = every other ad-hoc run
    // (launcher, retest, auto-test).
    const matchesTrigger = triggerFilter === 'all' ||
      (triggerFilter === 'scheduled'
        ? r.trigger_type === 'scheduled'
        : r.trigger_type !== 'scheduled');
    return matchesPiece && matchesTrigger;
  });

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

            {/* Trigger-type filter */}
            <div className="flex items-center rounded border border-gray-700 overflow-hidden ml-2">
              {([
                { id: 'all' as const, label: 'All' },
                { id: 'manual' as const, label: 'Manual' },
                { id: 'scheduled' as const, label: 'Scheduled' },
              ]).map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setTriggerFilter(opt.id)}
                  className={`px-2.5 py-1 text-xs transition-colors ${
                    triggerFilter === opt.id
                      ? 'bg-primary-600/20 text-primary-300'
                      : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

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
        <p className="text-gray-500">
          {triggerFilter === 'scheduled' ? 'No scheduled runs match.'
            : triggerFilter === 'manual' ? 'No manual runs match.'
            : 'No plan runs yet. Run plans from the Test Runner or a piece\'s detail page.'}
        </p>
      )}

      {grouped.map(([dateLabel, dateRuns]) => (
        <div key={dateLabel}>
          <h3 className="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-2">{dateLabel}</h3>
          <div className="space-y-2">
            {dateRuns.map((run) => (
              <PlanRunCard
                key={run.id}
                run={run}
                scheduleLabels={scheduleLabels}
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

function PlanRunCard({ run, scheduleLabels, expanded, onToggle, onDelete, isDeleting }: {
  run: PlanRunRecord;
  scheduleLabels: Record<number, string>;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}) {
  // For scheduled runs, name the schedule fire ("wave") that produced this run.
  const schedName = run.trigger_type === 'scheduled' && run.schedule_id != null
    ? scheduleLabels[run.schedule_id]
    : undefined;
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
  const duration = runDurationSeconds(run.started_at, run.completed_at);

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
            {schedName && (
              <span className="text-[10px] text-purple-300/80" title="Fired by this schedule">· {schedName}</span>
            )}
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
          <span>{formatDbTime(run.started_at)}</span>
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
//  Helpers
// ══════════════════════════════════════════════════════════════

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
    const d = new Date(parseDbTime(run.started_at));
    let label: string;
    if (d.toDateString() === todayStr) label = 'Today';
    else if (d.toDateString() === yesterdayStr) label = 'Yesterday';
    else label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(run);
  }

  return Array.from(groups.entries());
}

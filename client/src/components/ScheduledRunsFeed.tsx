import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  api, type WaveSummary, type WaveDetail, type WavePiece, type WaveRun, type StepResult,
} from '../lib/api';
import {
  CalendarClock, ChevronDown, ChevronRight, CheckCircle, XCircle, Loader2,
  Zap, RefreshCw, Clock, SkipForward,
} from 'lucide-react';

/**
 * Runs feed — each run is one schedule fire testing your covered pieces (see docs/SCHEDULED-RUNS-UX.md).
 *
 * Left: a rail of runs (one per schedule fire). Right: the selected run's summary + a
 * failures-first Piece → Target drill. step_results are NEVER in the list — a run's steps load
 * lazily (getPlanRun) only when you expand it. Scales with #failures, not #runs.
 */

const clean = (n: string) => n.replace('@activepieces/piece-', '');

// Naive-UTC timestamps ("2026-07-29 10:45:01") are treated as UTC; ISO passes through.
function parseTs(s?: string | null): number {
  if (!s) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}
function formatDateTime(s?: string | null): string {
  const t = parseTs(s);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDur(ms?: number | null): string | null {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const CATEGORY_STYLE: Record<string, string> = {
  piece_error: 'bg-red-500/15 text-red-300 border-red-500/25',
  assert_failed: 'bg-orange-500/15 text-orange-300 border-orange-500/25',
  not_found: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
  bad_request: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
  auth: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  rate_limit: 'bg-gray-500/15 text-gray-300 border-gray-600/40',
  transient: 'bg-gray-500/15 text-gray-300 border-gray-600/40',
  unknown: 'bg-gray-500/15 text-gray-400 border-gray-600/40',
};
function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${CATEGORY_STYLE[category] ?? CATEGORY_STYLE.unknown}`}>
      {category}
    </span>
  );
}

export default function ScheduledRunsFeed({ focusRunId }: { focusRunId?: number | null }) {
  const { data: waves = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['scheduled-waves'],
    queryFn: () => api.getScheduledWaves(30),
    refetchInterval: 30_000,
  });

  const [selectedWaveId, setSelectedWaveId] = useState<string | null>(null);
  const [expandedPieces, setExpandedPieces] = useState<Set<string>>(new Set());
  const [expandedRun, setExpandedRun] = useState<number | null>(null);

  // Deep-link (?run=<id> from the Health tab): resolve the run's wave, select it, and expand
  // the run's piece + the run itself. One-time so the user can navigate freely afterward.
  const didFocus = useRef(false);
  useEffect(() => {
    if (focusRunId == null || didFocus.current) return;
    didFocus.current = true;
    api.getPlanRun(focusRunId).then((run: any) => {
      if (run?.wave_id) setSelectedWaveId(run.wave_id);
      if (run?.piece_name) setExpandedPieces(new Set([run.piece_name]));
      setExpandedRun(focusRunId);
    }).catch(() => { /* run gone — fall back to the latest sweep */ });
  }, [focusRunId]);

  // Default: select the most recent sweep once loaded (focus, if any, wins via the effect above).
  useEffect(() => {
    if (selectedWaveId == null && waves.length > 0) setSelectedWaveId(waves[0].wave_id);
  }, [waves, selectedWaveId]);

  if (isLoading) return <p className="text-sm text-gray-400">Loading runs…</p>;

  if (waves.length === 0) {
    return (
      <p className="text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-lg p-4">
        No runs yet — enroll pieces in{' '}
        <Link to="/schedules" className="text-primary-400 hover:underline">Coverage</Link> to start.
      </p>
    );
  }

  const togglePiece = (name: string) =>
    setExpandedPieces(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-gray-500 max-w-2xl">
          Each <span className="text-gray-300">run</span> tests your <span className="text-gray-300">covered</span> pieces
          on a cadence. Pick one to see what it did — failures first, grouped by piece. For{' '}
          <span className="text-gray-300">all</span> runs (including manual tests) see{' '}
          <Link to="/history" className="text-primary-400 hover:underline">Test Logs</Link>.
        </p>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-400 shrink-0"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 items-start">
        {/* Sweep rail */}
        <div className="space-y-1.5">
          {waves.map(w => (
            <WaveRailItem key={w.wave_id} w={w} selected={w.wave_id === selectedWaveId}
              onSelect={() => setSelectedWaveId(w.wave_id)} />
          ))}
        </div>

        {/* Selected sweep detail */}
        <div>
          {selectedWaveId
            ? <WaveDetailView
                waveId={selectedWaveId}
                expandedPieces={expandedPieces}
                onTogglePiece={togglePiece}
                expandedRun={expandedRun}
                onToggleRun={id => setExpandedRun(expandedRun === id ? null : id)}
              />
            : <p className="text-sm text-gray-500">Select a run.</p>}
        </div>
      </div>
    </div>
  );
}

function WaveRailItem({ w, selected, onSelect }: { w: WaveSummary; selected: boolean; onSelect: () => void }) {
  const icon = w.running > 0 ? <Loader2 size={13} className="text-blue-400 animate-spin" />
    : w.failed > 0 ? <XCircle size={13} className="text-red-400" />
    : <CheckCircle size={13} className="text-green-400" />;
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
        selected ? 'border-primary-500/50 bg-primary-500/10' : 'border-gray-800 bg-gray-900 hover:bg-gray-800/50'
      }`}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium text-gray-200">{formatDateTime(w.started_at)}</span>
        {w.schedule_label && (
          <span className="flex items-center gap-1 text-[10px] text-purple-300 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded ml-auto">
            <CalendarClock size={9} /> {w.schedule_label}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1 text-[11px]">
        <span className={w.failed > 0 ? 'text-gray-400' : 'text-green-400'}>{w.passed}/{w.total} passed</span>
        {w.failed > 0 && <span className="text-red-400 font-medium">{w.failed} failed</span>}
        {w.running > 0 && <span className="text-blue-400">{w.running} running</span>}
      </div>
    </button>
  );
}

function WaveDetailView({
  waveId, expandedPieces, onTogglePiece, expandedRun, onToggleRun,
}: {
  waveId: string;
  expandedPieces: Set<string>;
  onTogglePiece: (name: string) => void;
  expandedRun: number | null;
  onToggleRun: (id: number) => void;
}) {
  const { data: detail, isLoading } = useQuery<WaveDetail>({
    queryKey: ['wave-detail', waveId],
    queryFn: () => api.getWaveDetail(waveId),
    refetchInterval: 30_000,
  });
  const [showPassing, setShowPassing] = useState(false);

  if (isLoading || !detail) return <p className="text-sm text-gray-400">Loading run…</p>;

  const failingPieces = detail.pieces.filter(p => p.failed > 0);
  const runningPieces = detail.pieces.filter(p => p.failed === 0 && p.running > 0);
  const passingPieces = detail.pieces.filter(p => p.failed === 0 && p.running === 0);

  return (
    <div className="space-y-3">
      {/* Summary line */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-200">{formatDateTime(detail.started_at)}</span>
          {detail.schedule_label && (
            <span className="flex items-center gap-1 text-[10px] text-purple-300 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded">
              <CalendarClock size={9} /> {detail.schedule_label}
            </span>
          )}
          <span className="text-xs text-gray-500">
            · {detail.pieces.length}{detail.covered_total > 0 ? ` of ${detail.covered_total} covered` : ' pieces'} tested
          </span>
        </div>
        <div className="flex items-center gap-4 mt-1.5 text-sm">
          <span className="text-green-400">{detail.passed} passed</span>
          <span className={detail.failed > 0 ? 'text-red-400 font-medium' : 'text-gray-500'}>
            {detail.failed} {detail.failed === 1 ? 'check' : 'checks'} failing
          </span>
          {detail.running > 0 && <span className="text-blue-400">{detail.running} running</span>}
        </div>
        {detail.covered_untested > 0 && (
          <p className="text-xs text-amber-300/80 mt-1.5">
            {detail.covered_untested} covered but untested (no plans) —{' '}
            <Link to="/schedules" className="text-primary-400 hover:underline">fix in Coverage</Link>
          </p>
        )}
      </div>

      {/* Failures first */}
      {failingPieces.length > 0 && (
        <div className="space-y-1.5">
          {failingPieces.map(p => (
            <PieceGroup key={p.piece_name} piece={p} lane="failing" open={expandedPieces.has(p.piece_name)}
              onToggle={() => onTogglePiece(p.piece_name)} expandedRun={expandedRun} onToggleRun={onToggleRun} />
          ))}
        </div>
      )}

      {/* In progress */}
      {runningPieces.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 px-1 pt-1 text-xs text-blue-300">
            <Loader2 size={12} className="animate-spin" />
            <span>In progress</span>
          </div>
          {runningPieces.map(p => (
            <PieceGroup key={p.piece_name} piece={p} lane="running" open={expandedPieces.has(p.piece_name)}
              onToggle={() => onTogglePiece(p.piece_name)} expandedRun={expandedRun} onToggleRun={onToggleRun} />
          ))}
        </div>
      )}

      {/* All-clear only when nothing is failing AND nothing is still running */}
      {failingPieces.length === 0 && runningPieces.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-400 flex items-center gap-2">
          <CheckCircle size={15} className="text-green-400" /> Every check in this run passed. 🎉
        </div>
      )}

      {/* Passing pieces folded away — now expandable to their targets → steps */}
      {passingPieces.length > 0 && (
        <div>
          <button onClick={() => setShowPassing(v => !v)}
            className="w-full flex items-center gap-2 px-1 py-1.5 text-left text-xs text-gray-500 hover:text-gray-300">
            {showPassing ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{passingPieces.length} passing piece{passingPieces.length === 1 ? '' : 's'} hidden</span>
          </button>
          {showPassing && (
            <div className="space-y-1.5 pb-1">
              {passingPieces.map(p => (
                <PieceGroup key={p.piece_name} piece={p} lane="passing" open={expandedPieces.has(p.piece_name)}
                  onToggle={() => onTogglePiece(p.piece_name)} expandedRun={expandedRun} onToggleRun={onToggleRun} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const LANE_STYLE = {
  failing: { border: 'border-red-500/20', dot: 'bg-red-500' },
  running: { border: 'border-blue-500/20', dot: 'bg-blue-500' },
  passing: { border: 'border-gray-800', dot: 'bg-green-500' },
} as const;

function PieceCounts({ piece }: { piece: WavePiece }) {
  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="text-gray-400">{piece.passed} passed</span>
      {piece.running > 0 && <span className="text-blue-400">· {piece.running} running</span>}
      {piece.failed > 0 && (
        <span className="text-red-400 font-medium">· {piece.failed} failed</span>
      )}
    </span>
  );
}

function PieceGroup({ piece, lane, open, onToggle, expandedRun, onToggleRun }: {
  piece: WavePiece;
  lane: 'failing' | 'running' | 'passing';
  open: boolean;
  onToggle: () => void;
  expandedRun: number | null;
  onToggleRun: (id: number) => void;
}) {
  const s = LANE_STYLE[lane];
  return (
    <div className={`border ${s.border} rounded-lg bg-gray-900 overflow-hidden`}>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/40 transition-colors">
        {open ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />}
        {lane === 'running'
          ? <Loader2 size={13} className="text-blue-400 animate-spin shrink-0" />
          : <span className={`w-2 h-2 rounded-full ${s.dot} shrink-0`} />}
        <span className="text-sm font-medium text-gray-200 truncate">{clean(piece.piece_name)}</span>
        <div className="ml-auto flex items-center gap-2">
          <PieceCounts piece={piece} />
          {lane === 'failing' && <CategoryBadge category={piece.worst_category} />}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-800/50 px-2 py-2 space-y-1.5 bg-gray-950/30">
          {piece.runs.map(r => (
            <TargetRow key={r.run_id} r={r} expanded={expandedRun === r.run_id}
              onToggle={() => onToggleRun(r.run_id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TargetRow({ r, expanded, onToggle }: { r: WaveRun; expanded: boolean; onToggle: () => void }) {
  const dur = fmtDur(r.duration_ms);
  const icon = r.status === 'completed' ? <CheckCircle size={13} className="text-green-400 shrink-0" />
    : r.status === 'failed' ? <XCircle size={13} className="text-red-400 shrink-0" />
    : r.status === 'running' ? <Loader2 size={13} className="text-blue-400 animate-spin shrink-0" />
    : <Clock size={13} className="text-gray-500 shrink-0" />;
  return (
    <div id={`wave-run-${r.run_id}`} className="border border-gray-800 rounded-lg bg-gray-900 overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/50 transition-colors">
        {expanded ? <ChevronDown size={13} className="text-gray-500 shrink-0" /> : <ChevronRight size={13} className="text-gray-500 shrink-0" />}
        {icon}
        <span className="text-sm text-gray-200">{r.target_action}</span>
        {r.target_type === 'trigger' && (
          <span className="flex items-center gap-0.5 text-[10px] text-purple-300"><Zap size={9} /> trigger</span>
        )}
        {r.status === 'failed' && <CategoryBadge category={r.category} />}
        {r.status === 'failed' && r.error && (
          <span className="text-[11px] text-red-400/70 truncate min-w-0 flex-1">— {r.error}</span>
        )}
        <span className="text-[10px] text-gray-500 shrink-0 ml-auto">#{r.run_id}{dur ? ` · ${dur}` : ''}</span>
      </button>
      {expanded && <RunSteps runId={r.run_id} />}
    </div>
  );
}

// Lazy step-level detail — the ONLY place step_results are fetched, and only for one run.
function RunSteps({ runId }: { runId: number }) {
  const { data: run, isLoading } = useQuery({ queryKey: ['plan-run', runId], queryFn: () => api.getPlanRun(runId) });
  if (isLoading) return (
    <div className="px-3 py-2 text-xs text-gray-500 flex items-center gap-2 border-t border-gray-800/50">
      <Loader2 size={12} className="animate-spin" /> Loading steps…
    </div>
  );
  const steps: StepResult[] = Array.isArray(run?.step_results)
    ? run.step_results
    : (typeof run?.step_results === 'string' ? safeParse(run.step_results) : []);
  if (steps.length === 0) return <div className="px-3 py-2 text-xs text-gray-500 border-t border-gray-800/50">No step detail.</div>;
  return (
    <div className="border-t border-gray-800/50 px-3 py-2 space-y-1 bg-gray-950/40">
      {steps.map((s, i) => <StepRow key={s.stepId ?? i} s={s} n={i + 1} />)}
    </div>
  );
}

function StepRow({ s, n }: { s: StepResult; n: number }) {
  const icon = s.status === 'completed' ? <CheckCircle size={12} className="text-green-400" />
    : s.status === 'failed' ? <XCircle size={12} className="text-red-400" />
    : s.status === 'assert_failed' ? <XCircle size={12} className="text-orange-400" />
    : s.status === 'running' ? <Loader2 size={12} className="text-blue-400 animate-spin" />
    : s.status === 'skipped' ? <SkipForward size={12} className="text-gray-500" />
    : <Clock size={12} className="text-gray-500" />;
  const dur = fmtDur(s.duration_ms);
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <span className="text-gray-600">{n}</span>
        {icon}
        <span className="text-gray-300">{s.label ?? s.stepId}</span>
        {dur && <span className="text-[10px] text-gray-600 ml-auto">{dur}</span>}
      </div>
      {s.error && <p className="text-[11px] text-red-400/70 ml-6 mt-0.5 break-words">{s.error}</p>}
    </div>
  );
}

function safeParse(s: string): StepResult[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

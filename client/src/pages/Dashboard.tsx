import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, type PieceHealthRow } from '../lib/api';
import NeedsAttention from '../components/NeedsAttention';
import ErrorPlaybook from '../components/ErrorPlaybook';
import {
  Search, RefreshCw, CalendarClock, BarChart3, ChevronRight, ChevronDown,
  AlertTriangle, CheckCircle2, HelpCircle,
} from 'lucide-react';

// Treat naive-UTC timestamps ("2026-06-22 08:48:37") as UTC; ISO strings pass through.
function parseTs(s?: string | null): number {
  if (!s) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

function formatRelative(s?: string | null): string {
  const t = parseTs(s);
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function cleanPiece(name: string): string {
  return name.replace('@activepieces/piece-', '');
}

export default function Dashboard() {
  const { data: health, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['piece-health'],
    queryFn: api.getPieceHealth,
    refetchInterval: 30_000,
  });

  const [search, setSearch] = useState('');
  const [showHealthy, setShowHealthy] = useState(false);

  const rows = health ?? [];
  const stats = useMemo(() => {
    const failing = rows.filter(r => r.status === 'failing').length;
    const healthy = rows.filter(r => r.status === 'healthy').length;
    const unknown = rows.filter(r => r.status === 'unknown').length;
    const lastSweep = rows.reduce<string | null>((max, r) =>
      r.last_run_at && (!max || r.last_run_at > max) ? r.last_run_at : max, null);
    return { tracked: rows.length, failing, healthy, unknown, lastSweep };
  }, [rows]);

  const q = search.trim().toLowerCase();
  const filtered = rows.filter(r => {
    if (q) return cleanPiece(r.piece_name).toLowerCase().includes(q) ||
      r.failing_actions.some(f => f.action.toLowerCase().includes(q));
    // No search: hide healthy unless toggled on (failing + unknown always shown).
    return showHealthy || r.status !== 'healthy';
  });
  const hiddenHealthy = q ? 0 : (showHealthy ? 0 : stats.healthy);

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-2xl font-bold">Piece Health</h2>
          <div className="flex items-center gap-2 shrink-0">
            <Link to="/schedules" className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300">
              <CalendarClock size={15} /> Schedules
            </Link>
            <Link to="/reports" className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300">
              <BarChart3 size={15} /> Reports
            </Link>
          </div>
        </div>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          Current status of every tracked piece — the latest scheduled outcome of each of its actions.
        </p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard label="Pieces tracked" value={stats.tracked} tone="neutral" />
        <StatCard label="Failing now" value={stats.failing} tone={stats.failing > 0 ? 'bad' : 'good'} />
        <StatCard label="Healthy" value={stats.healthy} tone="good" />
        <StatCard label="Last sweep" value={formatRelative(stats.lastSweep)} tone="neutral" small />
      </div>

      {/* Needs Attention inbox — the actionable triage lane, above the full grid */}
      <NeedsAttention />

      {/* Full piece grid */}
      <h3 className="text-lg font-semibold mb-1">All pieces</h3>
      <p className="text-xs text-gray-500 mb-3">Every tracked piece and its current status.</p>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search pieces or actions…"
            className="w-full pl-9 pr-3 py-1.5 bg-gray-900 border border-gray-800 rounded text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
          <input type="checkbox" checked={showHealthy} onChange={e => setShowHealthy(e.target.checked)} className="accent-primary-500" />
          Show healthy
        </label>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-gray-800 text-gray-400 hover:text-gray-200"
        >
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Board */}
      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading piece health…</p>
      ) : stats.tracked === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-sm text-gray-400">
          No scheduled runs yet. Create a schedule on the{' '}
          <Link to="/schedules" className="text-primary-400 hover:underline">Schedules</Link> page — once it fires,
          each piece's health shows up here.
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(r => <HealthRow key={r.piece_name} row={r} />)}
          {filtered.length === 0 && (
            <p className="text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-lg p-4">
              {q ? 'No pieces match your search.' : 'All tracked pieces are healthy. 🎉'}
            </p>
          )}
          {hiddenHealthy > 0 && (
            <button
              onClick={() => setShowHealthy(true)}
              className="w-full text-left text-xs text-gray-500 hover:text-gray-300 px-4 py-2"
            >
              … {hiddenHealthy} healthy piece{hiddenHealthy === 1 ? '' : 's'} hidden — show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function HealthRow({ row }: { row: PieceHealthRow }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const canExpand = row.failing_actions.length > 0;

  const dot = row.status === 'failing' ? 'bg-red-500'
    : row.status === 'blocked' ? 'bg-amber-500'
    : row.status === 'healthy' ? 'bg-green-500'
    : 'bg-gray-600';
  const border = row.status === 'failing' ? 'border-red-500/20'
    : row.status === 'blocked' ? 'border-amber-500/20'
    : 'border-gray-800';

  const firstFail = row.failing_actions[0];
  const extraFails = row.failing_actions.length - 1;
  // Currently passing but failed somewhere in recent history → surface a "recovered" hint
  // so a green status with a red-tinged sparkline reads clearly.
  const recovered = row.status === 'healthy' && row.recent.some(s => s === 'failed');
  const failHint = firstFail
    ? `${firstFail.action}${extraFails > 0 ? ` +${extraFails} more` : ''}${firstFail.error ? ` — ${firstFail.error}` : ''}`
    : undefined;

  return (
    <div className={`border rounded-lg ${border} bg-gray-900 overflow-hidden`}>
      <button
        onClick={() => canExpand && setOpen(o => !o)}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${canExpand ? 'hover:bg-gray-800/40' : 'cursor-default'} transition-colors`}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        <span className="text-sm font-medium text-gray-200 w-40 truncate">{cleanPiece(row.piece_name)}</span>

        <span className={`text-xs shrink-0 ${row.actions_failing > 0 ? 'text-gray-400' : 'text-green-400'}`}>
          {row.actions_passing}/{row.actions_total} ✓
        </span>

        {/* Failing action hint (full text on hover), or a "recovered" chip */}
        <span className="flex-1 min-w-0 text-xs truncate" title={row.blocked_reason ?? failHint}>
          {row.status === 'blocked' ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
                {row.backlinks ? 'Connection needs fixing' : 'Plan needs regenerating'}
              </span>
              {row.blocked_reason && <span className="text-amber-400/60">{row.blocked_reason}</span>}
              {row.backlinks && (
                <>
                  <a href={row.backlinks.activepieces} target="_blank" rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="text-primary-400 hover:underline">Fix in Activepieces ↗</a>
                  <Link to={row.backlinks.reimport} onClick={e => e.stopPropagation()}
                    className="text-primary-400 hover:underline">Re-import here</Link>
                </>
              )}
            </span>
          ) : firstFail ? (
            <span className="text-red-400/90">✗ {firstFail.action}{extraFails > 0 ? ` +${extraFails}` : ''}
              {firstFail.error ? <span className="text-red-400/50"> — {firstFail.error}</span> : null}
            </span>
          ) : recovered ? (
            <span className="text-[10px] text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5"
              title="Currently passing, but failed recently — see the sparkline">
              recovered
            </span>
          ) : null}
        </span>

        <Sparkline recent={row.recent} />
        <span className="text-[10px] text-gray-500 w-16 text-right shrink-0">{formatRelative(row.last_run_at)}</span>
        {canExpand
          ? (open ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />)
          : <span className="w-[14px] shrink-0" />}
      </button>

      {open && canExpand && (
        <div className="border-t border-gray-800/50 px-4 py-2.5 space-y-3 bg-gray-950/40">
          {row.failing_actions.map(f => (
            <div key={f.action}>
              <div className="text-xs">
                <span className="text-gray-300 font-medium">✗ {f.action}</span>
                {f.error && <span className="text-red-400/70"> — {f.error}</span>}
              </div>
              <ErrorPlaybook
                pieceName={row.piece_name}
                actionName={f.action}
                category={f.category}
                planId={f.plan_id}
                lastRunId={f.run_id}
              />
            </div>
          ))}
          <div className="flex items-center gap-4 mt-1">
            <button
              onClick={() => navigate(`/history?piece=${encodeURIComponent(cleanPiece(row.piece_name))}`)}
              className="text-[11px] text-primary-400 hover:underline"
            >
              View this piece's runs →
            </button>
            <button
              onClick={() => navigate('/reports')}
              className="text-[11px] text-gray-500 hover:text-gray-300 hover:underline"
              title="Reliability over time in Reports → Piece Trends"
            >
              See trends →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Tiny bar sparkline of recent run outcomes (oldest → newest, left → right).
function Sparkline({ recent }: { recent: string[] }) {
  if (!recent || recent.length === 0) return <span className="w-[60px] shrink-0" />;
  return (
    <span className="flex items-end gap-0.5 w-[60px] justify-end shrink-0" title="Recent run outcomes (old → new)">
      {recent.slice(-12).map((s, i) => {
        const color = s === 'completed' ? 'bg-green-500/80'
          : s === 'failed' ? 'bg-red-500/80'
          : s === 'running' ? 'bg-blue-500/80'
          : 'bg-gray-600/80';
        return <span key={i} className={`w-1 h-3 rounded-sm ${color}`} />;
      })}
    </span>
  );
}

function StatCard({ label, value, tone, small }: {
  label: string;
  value: string | number;
  tone: 'good' | 'bad' | 'neutral';
  small?: boolean;
}) {
  const color = tone === 'bad' ? 'text-red-400' : tone === 'good' ? 'text-green-400' : 'text-gray-200';
  const Icon = tone === 'bad' ? AlertTriangle : tone === 'good' ? CheckCircle2 : HelpCircle;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={15} className={color} />
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <p className={`font-bold ${small ? 'text-base' : 'text-2xl'} ${color}`}>{value}</p>
    </div>
  );
}

import { useState, useMemo, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, CoverageRow, CadencePayload } from '../lib/api';
import {
  Search, RefreshCw, Loader2, Link2, CalendarClock, Brain,
  CheckCircle, XCircle, AlertTriangle, Clock, Circle, Plus,
} from 'lucide-react';
import {
  CadenceModal, ScheduleConfig, DEFAULT_CADENCE, DEFAULT_CADENCE_LABEL,
} from './CadenceEditor';

type Filter = 'all' | 'not_connected' | 'connected' | 'not_covered' | 'covered' | 'needs_plans' | 'failing';

const shortName = (p: string) => p.replace(/^@[^/]+\/piece-/, '');

interface ModalState {
  mode: 'enroll' | 'cadence';
  pieces: string[];
  initialConfig?: ScheduleConfig;
  initialTimezone?: string;
}

export default function CoverageCockpit() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: rows = [], isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['coverage'],
    queryFn: api.getCoverage,
  });

  const { data: activeJobs = {} } = useQuery({
    queryKey: ['coverageActiveJobs'],
    queryFn: api.getActiveJobCounts,
    refetchInterval: 3000,
  });

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);

  // ── Derived counts ──
  const counts = useMemo(() => {
    const covered = rows.filter(r => r.covered).length;
    const needConnecting = rows.filter(r => !r.connected).length;
    const needPlans = rows.filter(r => r.covered && !r.has_plans).length;
    const failing = rows.filter(r => r.health === 'failing').length;
    return { total: rows.length, covered, needConnecting, needPlans, failing };
  }, [rows]);

  // ── Filtered rows ──
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (q && !r.display_name.toLowerCase().includes(q) && !r.piece_name.toLowerCase().includes(q)) return false;
      switch (filter) {
        case 'not_connected': return !r.connected;
        case 'connected':     return r.connected;
        case 'not_covered':   return !r.covered;
        case 'covered':       return r.covered;
        case 'needs_plans':   return r.covered && !r.has_plans;
        case 'failing':       return r.health === 'failing';
        default:              return true;
      }
    });
  }, [rows, search, filter]);

  // ── Mutations ──
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setNote(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['coverage'] });
      setSelected(new Set());
      setModal(null);
      setNote(ok);
      setTimeout(() => setNote(null), 4000);
    } catch (e: any) {
      setNote(e?.message ? `Error: ${e.message}` : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const enroll = (pieces: string[], cadence: CadencePayload) =>
    run(() => api.enrollPieces(pieces, cadence), `Enrolled ${pieces.length} piece(s).`);
  const changeCadence = (pieces: string[], cadence: CadencePayload) =>
    run(() => api.setPiecesCadence(pieces, cadence), `Updated cadence for ${pieces.length} piece(s).`);
  const unenroll = (pieces: string[]) =>
    run(() => api.unenrollPieces(pieces), `Removed ${pieces.length} piece(s).`);
  async function genPlans(pieces: string[]) {
    setBusy(true); setNote(null);
    try {
      await api.startBatchSetup(pieces);
      navigate('/batch-setup');
    } catch (e: any) {
      setNote(e?.message ? `Error: ${e.message}` : 'Could not start plan generation.');
      setBusy(false);
    }
  }

  // ── Selection helpers ──
  const toggle = (name: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });
  const allVisibleSelected = visible.length > 0 && visible.every(r => selected.has(r.piece_name));
  const toggleAllVisible = () => setSelected(prev => {
    const next = new Set(prev);
    if (allVisibleSelected) visible.forEach(r => next.delete(r.piece_name));
    else visible.forEach(r => next.add(r.piece_name));
    return next;
  });

  const selectedNames = [...selected];

  if (isError) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-300">
        Couldn't load coverage: {(error as any)?.message ?? 'unknown error'}.
        Check your API key/connection in Settings.
        <button onClick={() => refetch()} className="ml-3 underline">Retry</button>
      </div>
    );
  }

  const pct = counts.total ? Math.round((counts.covered / counts.total) * 100) : 0;

  return (
    <div>
      {/* ── Coverage summary ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="text-2xl font-bold whitespace-nowrap">
            {counts.covered} <span className="text-gray-500 font-normal">/ {counts.total} covered</span>
          </div>
          <div className="flex-1 min-w-[160px] h-2.5 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-green-400 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-xs text-gray-400 flex items-center gap-3 whitespace-nowrap">
            <span>{counts.needConnecting} need connecting</span>
            <span className="text-gray-600">·</span>
            <span>{counts.needPlans} need plans</span>
            <span className="text-gray-600">·</span>
            <span className={counts.failing ? 'text-red-400' : ''}>{counts.failing} failing</span>
          </div>
        </div>
      </div>

      {/* ── Controls ── */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search pieces…"
            className="w-full bg-gray-800 border border-gray-700 rounded pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:border-primary-500"
          />
        </div>
        {([
          ['all', 'All'],
          ['not_connected', 'Not connected'], ['connected', 'Connected'],
          ['not_covered', 'Not covered'], ['covered', 'Covered'],
          ['needs_plans', 'Needs plans'], ['failing', 'Failing'],
        ] as [Filter, string][]).map(([f, label]) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
              filter === f
                ? 'bg-primary-600 border-primary-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          title="Refresh"
          className="p-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 disabled:opacity-50"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* ── Bulk action bar ── */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 mb-3 bg-primary-600/10 border border-primary-600/30 rounded-lg px-3 py-2 flex-wrap">
          <span className="text-sm text-gray-300">{selected.size} selected</span>
          <button
            onClick={() => enroll(selectedNames, DEFAULT_CADENCE)}
            disabled={busy}
            className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 rounded text-xs font-medium disabled:opacity-50"
          >
            Enroll ({DEFAULT_CADENCE_LABEL})
          </button>
          <button
            onClick={() => setModal({ mode: 'cadence', pieces: selectedNames })}
            disabled={busy}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium disabled:opacity-50"
          >
            Change cadence…
          </button>
          <button
            onClick={() => genPlans(selectedNames)}
            disabled={busy}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium disabled:opacity-50"
          >
            Generate plans
          </button>
          <button
            onClick={() => unenroll(selectedNames)}
            disabled={busy}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium text-red-300 disabled:opacity-50"
          >
            Unenroll
          </button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-gray-500 hover:text-gray-300">
            Clear
          </button>
        </div>
      )}

      {note && <p className="text-xs mb-3 text-gray-400">{note}</p>}

      {/* ── Table ── */}
      {isLoading ? (
        <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading catalog…</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          {/* header */}
          <div className="grid grid-cols-[28px_1.25fr_0.85fr_0.95fr_0.7fr_0.8fr_92px] gap-2 px-3 py-2 border-b border-gray-800 text-[11px] uppercase tracking-wide text-gray-500">
            <div className="flex items-center">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} className="accent-primary-500 cursor-pointer" />
            </div>
            <div>Piece</div>
            <div>Coverage</div>
            <div>Readiness</div>
            <div>Plans</div>
            <div>Cadence</div>
            <div>Next</div>
          </div>

          {visible.length === 0 ? (
            <p className="text-sm text-gray-500 p-4">No pieces match.</p>
          ) : (
            <div className="max-h-[62vh] overflow-y-auto">
              {visible.map(r => (
                <Row
                  key={r.piece_name}
                  r={r}
                  checked={selected.has(r.piece_name)}
                  onToggle={() => toggle(r.piece_name)}
                  onConnect={() => navigate(`/pieces/${encodeURIComponent(r.piece_name)}`)}
                  onEnroll={() => enroll([r.piece_name], DEFAULT_CADENCE)}
                  onGenPlans={() => genPlans([r.piece_name])}
                  onOpenPlans={() => navigate(`/pieces/${encodeURIComponent(r.piece_name)}`)}
                  onOpenRuns={() => navigate(`/schedules?tab=logs&run=${r.last_run_id}`)}
                  onEdit={() => setModal({
                    mode: 'cadence',
                    pieces: [r.piece_name],
                    initialConfig: validConfig(r.cadence?.config),
                    initialTimezone: r.cadence?.timezone,
                  })}
                  busy={busy}
                  generating={activeJobs[r.piece_name] ?? 0}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Cadence modal ── */}
      {modal && (
        <CadenceModal
          title={modal.mode === 'enroll' ? 'Enroll on a schedule' : 'Change cadence'}
          subtitle={`${modal.pieces.length} piece${modal.pieces.length !== 1 ? 's' : ''}`}
          confirmLabel={modal.mode === 'enroll' ? 'Enroll' : 'Save cadence'}
          busy={busy}
          initialConfig={modal.initialConfig}
          initialTimezone={modal.initialTimezone}
          onConfirm={(cadence) =>
            modal.mode === 'enroll' ? enroll(modal.pieces, cadence) : changeCadence(modal.pieces, cadence)
          }
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// Only pass a config to the editor if it looks like a real ScheduleConfig.
function validConfig(c: any): ScheduleConfig | undefined {
  return c && typeof c === 'object' && typeof c.frequency === 'string' ? c as ScheduleConfig : undefined;
}

// ── Row ──────────────────────────────────────────────────────────────────────

function Row({
  r, checked, onToggle, onConnect, onEnroll, onGenPlans, onOpenPlans, onOpenRuns, onEdit, busy, generating,
}: {
  r: CoverageRow;
  checked: boolean;
  onToggle: () => void;
  onConnect: () => void;
  onEnroll: () => void;
  onGenPlans: () => void;
  onOpenPlans: () => void;
  onOpenRuns: () => void;
  onEdit: () => void;
  busy: boolean;
  generating: number;
}) {
  return (
    <div className="grid grid-cols-[28px_1.25fr_0.85fr_0.95fr_0.7fr_0.8fr_92px] gap-2 px-3 py-2 border-b border-gray-800/60 last:border-b-0 items-center hover:bg-gray-800/30 text-sm">
      <div className="flex items-center">
        <input type="checkbox" checked={checked} onChange={onToggle} className="accent-primary-500 cursor-pointer" />
      </div>

      {/* Piece */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {r.logo_url && <img src={r.logo_url} alt="" className="w-4 h-4 rounded-sm flex-shrink-0" />}
          {r.last_run_id ? (
            <button
              onClick={onOpenRuns}
              title="Go to this piece's latest run"
              className="truncate font-medium text-left hover:text-primary-300 hover:underline"
            >
              {r.display_name}
            </button>
          ) : (
            <span className="truncate font-medium">{r.display_name}</span>
          )}
        </div>
        <div className="text-[11px] text-gray-600 truncate">{shortName(r.piece_name)}</div>
        {generating > 0 && (
          <Pill className="mt-0.5 bg-purple-500/20 text-purple-300">
            <Loader2 size={9} className="animate-spin" /> {generating} generating
          </Pill>
        )}
      </div>

      {/* Coverage */}
      <div><CoverageBadge r={r} /></div>

      {/* Readiness */}
      <div><ReadinessBadge r={r} /></div>

      {/* Plans (of actions + triggers) */}
      <div><PlansCell r={r} onOpen={onOpenPlans} /></div>

      {/* Cadence */}
      <div className="text-xs text-gray-400 truncate">
        {r.covered && r.cadence ? cadenceShort(r.cadence) : '—'}
      </div>

      {/* Next action */}
      <div>
        <NextButton r={r} busy={busy} onConnect={onConnect} onEnroll={onEnroll} onGenPlans={onGenPlans} onEdit={onEdit} />
      </div>
    </div>
  );
}

function CoverageBadge({ r }: { r: CoverageRow }) {
  if (!r.covered) return <Pill className="bg-gray-700/40 text-gray-400"><Circle size={9} /> Not covered</Pill>;
  if (!r.has_plans) return <Pill className="bg-amber-500/15 text-amber-300"><CalendarClock size={11} /> Covered</Pill>;
  return <Pill className="bg-green-500/15 text-green-300"><CalendarClock size={11} /> Covered</Pill>;
}

function ReadinessBadge({ r }: { r: CoverageRow }) {
  if (!r.connected) return <Pill className="bg-gray-700/40 text-gray-400"><Circle size={9} /> not connected</Pill>;
  if (!r.covered)   return <Pill className="bg-sky-500/15 text-sky-300"><Link2 size={11} /> connected</Pill>;
  if (!r.has_plans) return <Pill className="bg-amber-500/15 text-amber-300"><AlertTriangle size={11} /> no plans yet</Pill>;
  if (r.health === 'failing') return <Pill className="bg-red-500/15 text-red-300"><XCircle size={11} /> {r.actions_failing || ''} failing</Pill>;
  if (r.health === 'healthy') return <Pill className="bg-green-500/15 text-green-300"><CheckCircle size={11} /> healthy</Pill>;
  return <Pill className="bg-gray-700/40 text-gray-400"><Clock size={10} /> awaiting run</Pill>;
}

// N/M of the piece's actions+triggers that have a plan. Amber + "add" when
// incomplete; click jumps to Piece Detail to make the missing plans.
function PlansCell({ r, onOpen }: { r: CoverageRow; onOpen: () => void }) {
  if (!r.total_targets) return <span className="text-xs text-gray-600">—</span>;
  const complete = r.planned_targets >= r.total_targets;
  return (
    <button
      onClick={onOpen}
      title={`${r.planned_targets} of ${r.total_targets} actions & triggers have a plan — click to make plans`}
      className={`inline-flex items-center gap-1 text-xs font-medium hover:underline ${complete ? 'text-green-300' : 'text-amber-300'}`}
    >
      {r.planned_targets}/{r.total_targets}
      {!complete && <Plus size={11} />}
    </button>
  );
}

function NextButton({
  r, busy, onConnect, onEnroll, onGenPlans, onEdit,
}: {
  r: CoverageRow; busy: boolean;
  onConnect: () => void; onEnroll: () => void; onGenPlans: () => void; onEdit: () => void;
}) {
  const base = 'w-full px-2 py-1 rounded text-xs font-medium disabled:opacity-50';
  if (!r.connected) return <button onClick={onConnect} className={`${base} bg-gray-800 hover:bg-gray-700 border border-gray-700`}>Connect</button>;
  if (!r.covered)   return <button onClick={onEnroll} disabled={busy} className={`${base} bg-primary-600 hover:bg-primary-700`}>Enroll</button>;
  if (!r.has_plans) return <button onClick={onGenPlans} disabled={busy} className={`${base} bg-purple-600/80 hover:bg-purple-600 flex items-center justify-center gap-1`}><Brain size={11} /> Gen plans</button>;
  return <button onClick={onEdit} disabled={busy} className={`${base} bg-gray-800 hover:bg-gray-700 border border-gray-700`}>Edit</button>;
}

function Pill({ children, className }: { children: ReactNode; className: string }) {
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] ${className}`}>{children}</span>;
}

function cadenceShort(c: { label: string; config: any }): string {
  const cfg = c.config;
  if (cfg && typeof cfg === 'object' && typeof cfg.frequency === 'string') {
    const pad = (n: number) => String(n).padStart(2, '0');
    const t = `${pad(cfg.hour ?? 0)}:${pad(cfg.minute ?? 0)}`;
    switch (cfg.frequency) {
      case 'hourly':  return `Hourly :${pad(cfg.minute ?? 0)}`;
      case 'daily':   return `Daily ${t}`;
      case 'weekly':  return `Weekly ${t}`;
      case 'monthly': return `Monthly ${t}`;
    }
  }
  return c.label || 'Scheduled';
}

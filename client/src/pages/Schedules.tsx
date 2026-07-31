import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, PlanRunRecord, StepResult } from '../lib/api';
import TestResultBadge from '../components/TestResultBadge';
import {
  Plus, Trash2, Pencil, Clock, CheckCircle, XCircle,
  Power, PowerOff, CalendarClock, ScrollText, RefreshCw,
  ChevronDown, ChevronRight, Loader2, SkipForward, MessageSquare,
  Calendar, Play, Filter, Archive,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly';
type Tab = 'schedules' | 'logs';

interface ScheduleConfig {
  frequency: Frequency;
  minute: number;       // 0-59
  hour: number;         // 0-23
  dayOfWeek: number;    // 0=Sun … 6=Sat  (used when frequency === 'weekly')
  dayOfMonth: number;   // 1-28            (used when frequency === 'monthly')
}

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TIMEZONES = [
  'UTC',
  'Asia/Amman',           // Jordan
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

// ── Helpers ────────────────────────────────────────────────────────────────

function configToCron(cfg: ScheduleConfig): string {
  const m = cfg.minute;
  const h = cfg.hour;
  switch (cfg.frequency) {
    case 'hourly':  return `${m} * * * *`;
    case 'daily':   return `${m} ${h} * * *`;
    case 'weekly':  return `${m} ${h} * * ${cfg.dayOfWeek}`;
    case 'monthly': return `${m} ${h} ${cfg.dayOfMonth} * *`;
  }
}

function describeConfig(cfg: ScheduleConfig, tz: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(cfg.hour)}:${pad(cfg.minute)} ${tz}`;
  switch (cfg.frequency) {
    case 'hourly':  return `Every hour at minute :${pad(cfg.minute)} (${tz})`;
    case 'daily':   return `Every day at ${time}`;
    case 'weekly':  return `Every ${DAYS_OF_WEEK[cfg.dayOfWeek]} at ${time}`;
    case 'monthly': return `Day ${cfg.dayOfMonth} of every month at ${time}`;
  }
}

function defaultConfig(): ScheduleConfig {
  return { frequency: 'daily', minute: 0, hour: 6, dayOfWeek: 1, dayOfMonth: 1 };
}

function parseConfig(raw: string): ScheduleConfig {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.frequency) return parsed as ScheduleConfig;
  } catch { /* fall through */ }
  return defaultConfig();
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return iso; }
}

// Treat the naive-UTC `started_at` ("2026-06-22 08:48:37") as UTC so durations
// aren't skewed by the local offset; `completed_at` is already ISO-UTC ("...Z").
function parseTs(s?: string | null): number {
  if (!s) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

function runDurationSec(run: PlanRunRecord): number | null {
  if (!run.completed_at) return null;
  const d = Math.round((parseTs(run.completed_at) - parseTs(run.started_at)) / 1000);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

function safeParseSteps(s: string): StepResult[] {
  try { return JSON.parse(s) as StepResult[]; } catch { return []; }
}

/** Collapse a (often huge JSON) error into a one-line readable snippet. */
function shortError(err: string): string {
  let msg = err;
  try { const o = JSON.parse(err); if (o && typeof o.message === 'string') msg = o.message; } catch { /* not JSON */ }
  msg = msg.split('\n')[0].trim();
  return msg.length > 130 ? msg.slice(0, 130) + '…' : msg;
}

function firstFailedStepError(run: PlanRunRecord): string | null {
  const steps: StepResult[] = Array.isArray(run.step_results)
    ? run.step_results
    : (typeof run.step_results === 'string' ? safeParseSteps(run.step_results as any) : []);
  const s = steps.find(x => x.status === 'failed');
  return s?.error ? shortError(s.error) : null;
}

interface Wave {
  key: string;
  startTs: string;
  scheduleId: number | null;   // which schedule fired this wave (null if unknown/legacy)
  grouping: 'wave' | 'time';   // 'wave' = exact wave_id; 'time' = legacy gap heuristic
  runs: PlanRunRecord[];
}

// A scheduled cron fire produces many runs at once — a "wave". Runs stamped with a
// wave_id (fired after wave tracking landed) group EXACTLY by that id, so a wave maps
// 1:1 to a real cron fire and can be linked back to its schedule. Older runs with no
// wave_id fall back to the original heuristic: a new wave starts on a >10min idle gap.
function clusterWaves(runs: PlanRunRecord[]): Wave[] {
  const sorted = [...runs].sort((a, b) => parseTs(b.started_at) - parseTs(a.started_at));
  const GAP_MS = 10 * 60 * 1000;
  const waves: Wave[] = [];
  const byWaveId = new Map<string, Wave>();
  let legacyCur: Wave | null = null;

  for (const r of sorted) {
    if (r.wave_id) {
      let w = byWaveId.get(r.wave_id);
      if (!w) {
        w = { key: r.wave_id, startTs: r.started_at, scheduleId: r.schedule_id ?? null, grouping: 'wave', runs: [] };
        byWaveId.set(r.wave_id, w);
        waves.push(w);
      }
      w.runs.push(r);
      w.startTs = r.started_at;   // sorted desc → oldest-so-far = the fire time
      legacyCur = null;           // a stamped run is a hard boundary for legacy grouping
    } else {
      const fits = legacyCur && (parseTs(legacyCur.startTs) - parseTs(r.started_at)) <= GAP_MS;
      if (!fits) { legacyCur = { key: `t-${r.id}`, startTs: r.started_at, scheduleId: null, grouping: 'time', runs: [] }; waves.push(legacyCur); }
      legacyCur!.runs.push(r);
      legacyCur!.startTs = r.started_at;
    }
  }

  // Order waves newest-fire-first (map insertion order isn't guaranteed chronological).
  waves.sort((a, b) => parseTs(b.startTs) - parseTs(a.startTs));
  return waves;
}

// ── Target type ────────────────────────────────────────────────────────────

interface ScheduleTarget {
  piece_name: string;
  action_name?: string; // undefined = all actions for this piece
}

// ── Schedule form ──────────────────────────────────────────────────────────

interface FormState {
  label: string;
  targets: ScheduleTarget[]; // empty = all pieces, all actions
  frequency: Frequency;
  minute: number;
  hour: number;
  dayOfWeek: number;
  dayOfMonth: number;
  timezone: string;
}

function emptyForm(): FormState {
  return {
    label: '', targets: [],
    frequency: 'daily', minute: 0, hour: 6,
    dayOfWeek: 1, dayOfMonth: 1,
    timezone: 'UTC',
  };
}

function formToPayload(f: FormState) {
  const cfg: ScheduleConfig = {
    frequency: f.frequency, minute: f.minute, hour: f.hour,
    dayOfWeek: f.dayOfWeek, dayOfMonth: f.dayOfMonth,
  };
  return {
    cron_expression: configToCron(cfg),
    label: f.label,
    timezone: f.timezone,
    schedule_config: JSON.stringify(cfg),
    targets: f.targets,
  };
}

function parseTargets(raw: string): ScheduleTarget[] {
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
  catch { return []; }
}

// ── Main component ─────────────────────────────────────────────────────────

export default function Schedules() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  // Deep-link: /schedules?tab=logs&run=<id> opens the Scheduled Runs feed on a specific run
  // (e.g. from the Health tab's "View run details").
  const [tab, setTab] = useState<Tab>(searchParams.get('tab') === 'logs' ? 'logs' : 'schedules');
  const focusRunId = searchParams.get('run') ? Number(searchParams.get('run')) : null;

  // If the deep-link params change while already on the page, follow them.
  useEffect(() => {
    if (searchParams.get('tab') === 'logs') setTab('logs');
  }, [searchParams]);

  // ── Schedules data ──
  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['schedules'],
    queryFn: api.listSchedules,
  });
  const { data: rawConnections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: api.listConnections,
  });
  // Deduplicate by piece_name (active first) so TargetPicker shows each piece once
  const connections = (rawConnections as any[]).reduce((acc: any[], c: any) => {
    if (!acc.some((x: any) => x.piece_name === c.piece_name)) acc.push(c);
    return acc;
  }, []);

  // ── Log data: classic test runs (trigger_type=scheduled) ──
  const { data: allHistory = [], refetch: refetchHistory, isFetching: fetchingHistory } = useQuery({
    queryKey: ['history-all-logs'],
    queryFn: () => api.listHistory(100, 0),
    enabled: tab === 'logs',
  });

  // ── Log data: plan runs (trigger_type=scheduled) ──
  const { data: allPlanRuns = [], refetch: refetchPlanRuns, isFetching: fetchingPlanRuns } = useQuery({
    queryKey: ['plan-runs-all-logs'],
    queryFn: () => api.listAllPlanRuns({ limit: 100 }),
    enabled: tab === 'logs',
  });

  const scheduledHistory = (allHistory as any[]).filter(r => r.trigger_type === 'scheduled');
  const scheduledPlanRuns = (allPlanRuns as PlanRunRecord[]).filter(r => r.trigger_type === 'scheduled');

  // schedule_id → human label, so each wave can name the schedule that fired it.
  const scheduleLabels: Record<number, string> = {};
  for (const s of schedules as any[]) scheduleLabels[s.id] = s.label || `Schedule #${s.id}`;

  // ── Form state ──
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['schedules'] });

  function openCreate() {
    setEditId(null);
    setForm(emptyForm());
    setSaveMsg(null);
    setShowForm(true);
  }

  function openEdit(s: any) {
    const cfg = parseConfig(s.schedule_config);
    setEditId(s.id);
    setForm({
      label: s.label || '',
      targets: parseTargets(s.targets || '[]'),
      frequency: cfg.frequency,
      minute: cfg.minute,
      hour: cfg.hour,
      dayOfWeek: cfg.dayOfWeek,
      dayOfMonth: cfg.dayOfMonth,
      timezone: s.timezone || 'UTC',
    });
    setSaveMsg(null);
    setShowForm(true);
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const payload = formToPayload(form);
      if (editId !== null) {
        await api.updateSchedule(editId, payload);
      } else {
        await api.createSchedule(payload);
      }
      await refresh();
      setShowForm(false);
      setEditId(null);
    } catch (err: any) {
      setSaveMsg({ ok: false, text: err.message });
    }
    setSaving(false);
  }

  async function handleToggle(s: any) {
    await api.updateSchedule(s.id, { enabled: s.enabled ? 0 : 1 });
    refresh();
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this schedule?')) return;
    await api.deleteSchedule(id);
    refresh();
  }

  function setF<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: val }));
  }

  const previewCron = configToCron({
    frequency: form.frequency, minute: form.minute, hour: form.hour,
    dayOfWeek: form.dayOfWeek, dayOfMonth: form.dayOfMonth,
  });
  const previewDesc = describeConfig({
    frequency: form.frequency, minute: form.minute, hour: form.hour,
    dayOfWeek: form.dayOfWeek, dayOfMonth: form.dayOfMonth,
  }, form.timezone);

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Schedules</h2>
          <p className="text-sm text-gray-500 mt-0.5">Automatically run tests on a recurring schedule.</p>
        </div>
        {tab === 'schedules' && (
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium"
          >
            <Plus size={16} /> New Schedule
          </button>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="flex border-b border-gray-800 mb-6">
        {([
          { id: 'schedules', label: 'Schedules', icon: CalendarClock },
          { id: 'logs',      label: 'Scheduled Runs',  icon: ScrollText },
        ] as { id: Tab; label: string; icon: any }[]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === id
                ? 'border-primary-500 text-primary-400'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {/* ══════════════ TAB: SCHEDULES ══════════════ */}
      {tab === 'schedules' && (
        <>
          {isLoading ? (
            <p className="text-gray-500 text-sm">Loading…</p>
          ) : schedules.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center text-gray-500">
              <Clock size={32} className="mx-auto mb-3 opacity-40" />
              <p>No schedules yet. Create one to run tests automatically.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {(schedules as any[]).map((s) => {
                const cfg = parseConfig(s.schedule_config);
                const desc = s.schedule_config !== '{}'
                  ? describeConfig(cfg, s.timezone || 'UTC')
                  : s.cron_expression;
                const lastRun = s.last_run_at
                  ? formatDateTime(s.last_run_at)
                  : 'Never';
                return (
                  <div
                    key={s.id}
                    className={`bg-gray-900 border rounded-lg p-4 flex items-center gap-4 ${
                      s.enabled ? 'border-gray-700' : 'border-gray-800 opacity-60'
                    }`}
                  >
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${s.enabled ? 'bg-green-400' : 'bg-gray-600'}`} />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">
                          {s.label || `Schedule #${s.id}`}
                        </span>
                        {(() => {
                          const tgts = parseTargets(s.targets || '[]');
                          if (tgts.length === 0) return (
                            <span className="text-xs bg-blue-900/30 border border-blue-800/40 px-2 py-0.5 rounded text-blue-400">All pieces</span>
                          );
                          // Group by piece name, count actions per piece
                          const byPiece: Record<string, number> = {};
                          for (const t of tgts) {
                            if (!byPiece[t.piece_name]) byPiece[t.piece_name] = 0;
                            if (t.action_name) byPiece[t.piece_name]++;
                          }
                          const pieceEntries = Object.entries(byPiece);
                          const shortName = (p: string) => p.replace(/^@[^/]+\/piece-/, '');
                          return pieceEntries.slice(0, 4).map(([p, actionCount], i) => (
                            <span key={i} className="text-xs bg-gray-800 border border-gray-700 px-2 py-0.5 rounded text-gray-300">
                              {shortName(p)}
                              {actionCount > 0 && <span className="text-gray-500 ml-1">({actionCount})</span>}
                            </span>
                          )).concat(pieceEntries.length > 4 ? [
                            <span key="more" className="text-xs text-gray-500">+{pieceEntries.length - 4} more</span>
                          ] : []);
                        })()}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
                      <p className="text-xs text-gray-600 mt-0.5">
                        Last run: {lastRun}
                        {' · '}
                        <code className="text-gray-600">{s.cron_expression}</code>
                      </p>
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleToggle(s)}
                        title={s.enabled ? 'Disable' : 'Enable'}
                        className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200"
                      >
                        {s.enabled ? <Power size={15} /> : <PowerOff size={15} />}
                      </button>
                      <button
                        onClick={() => openEdit(s)}
                        title="Edit"
                        className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => handleDelete(s.id)}
                        title="Delete"
                        className="p-1.5 rounded hover:bg-gray-800 text-red-500 hover:text-red-400"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ══════════════ TAB: RUN LOGS ══════════════ */}
      {tab === 'logs' && (
        <div className="space-y-8">
          {/* What this tab is, vs the global Test Logs page */}
          <div className="flex items-start justify-between gap-4">
            <p className="text-xs text-gray-500 max-w-2xl">
              Runs your <span className="text-gray-300">schedules</span> fired, grouped into
              {' '}<span className="text-gray-300">waves</span> — one wave = one schedule fire, named by the
              schedule that triggered it. For <span className="text-gray-300">all</span> test runs —
              including manual tests you start from a piece — see{' '}
              <Link to="/history" className="text-primary-400 hover:underline">Test Logs</Link>.
            </p>
            <button
              onClick={() => { refetchHistory(); refetchPlanRuns(); }}
              disabled={fetchingHistory || fetchingPlanRuns}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-400 disabled:opacity-50 shrink-0"
            >
              <RefreshCw size={14} className={fetchingHistory || fetchingPlanRuns ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>

              {/* ── Plan Runs (scheduled) ── */}
          <section>
            <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
              <CalendarClock size={16} className="text-primary-400" />
              Plan Runs
              <span className="text-xs font-normal text-gray-500 ml-1">({scheduledPlanRuns.length})</span>
            </h3>
            <ExpandablePlanRuns runs={scheduledPlanRuns} scheduleLabels={scheduleLabels} focusRunId={focusRunId} />
          </section>

          {/* ── Archived legacy runs (scheduled) ── */}
          <section>
            <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
              <Archive size={16} className="text-blue-400" />
              Archived Runs (v1)
              <span className="text-xs font-normal text-gray-500 ml-1">({scheduledHistory.length})</span>
            </h3>
            <ExpandableLegacyRuns runs={scheduledHistory} />
          </section>
        </div>
      )}

      {/* ══════════════ CREATE / EDIT MODAL ══════════════ */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h3 className="text-lg font-bold mb-5">
                {editId !== null ? 'Edit Schedule' : 'New Schedule'}
              </h3>

              <div className="space-y-4">
                {/* Label */}
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Label</label>
                  <input
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                    value={form.label}
                    onChange={e => setF('label', e.target.value)}
                    placeholder="e.g. Nightly regression"
                  />
                </div>

                {/* Target picker */}
                <TargetPicker
                  connections={connections as any[]}
                  targets={form.targets}
                  onChange={t => setF('targets', t)}
                />

                {/* Frequency */}
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Frequency</label>
                  <div className="grid grid-cols-4 gap-2">
                    {(['hourly', 'daily', 'weekly', 'monthly'] as Frequency[]).map(f => (
                      <button
                        key={f}
                        onClick={() => setF('frequency', f)}
                        className={`py-2 rounded text-sm font-medium border transition-colors ${
                          form.frequency === f
                            ? 'bg-primary-600 border-primary-500 text-white'
                            : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                        }`}
                      >
                        {f.charAt(0).toUpperCase() + f.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Day of week (weekly only) */}
                {form.frequency === 'weekly' && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Day of week</label>
                    <div className="grid grid-cols-7 gap-1">
                      {DAYS_OF_WEEK.map((d, i) => (
                        <button
                          key={i}
                          onClick={() => setF('dayOfWeek', i)}
                          className={`py-1.5 rounded text-xs font-medium border transition-colors ${
                            form.dayOfWeek === i
                              ? 'bg-primary-600 border-primary-500 text-white'
                              : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                          }`}
                        >
                          {d.slice(0, 3)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Day of month (monthly only) */}
                {form.frequency === 'monthly' && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Day of month</label>
                    <div className="flex flex-wrap gap-1">
                      {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                        <button
                          key={d}
                          onClick={() => setF('dayOfMonth', d)}
                          className={`w-9 h-9 rounded text-xs font-medium border transition-colors ${
                            form.dayOfMonth === d
                              ? 'bg-primary-600 border-primary-500 text-white'
                              : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Hour + Minute */}
                <div className="grid grid-cols-2 gap-4">
                  {form.frequency !== 'hourly' && (
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">Hour (0–23)</label>
                      <input
                        type="number" min={0} max={23}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                        value={form.hour}
                        onChange={e => setF('hour', Math.min(23, Math.max(0, parseInt(e.target.value) || 0)))}
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Minute (0–59)</label>
                    <input
                      type="number" min={0} max={59}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                      value={form.minute}
                      onChange={e => setF('minute', Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
                    />
                  </div>
                </div>

                {/* Timezone */}
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Timezone</label>
                  <select
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                    value={form.timezone}
                    onChange={e => setF('timezone', e.target.value)}
                  >
                    {TIMEZONES.map(tz => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </div>

                {/* Preview */}
                <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 space-y-1">
                  <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Preview</p>
                  <p className="text-sm text-white">{previewDesc}</p>
                  <p className="text-xs text-gray-500 font-mono">{previewCron}</p>
                </div>
              </div>

              {saveMsg && (
                <div className={`flex items-center gap-2 mt-4 text-sm ${saveMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
                  {saveMsg.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                  {saveMsg.text}
                </div>
              )}

              <div className="flex gap-3 mt-6">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium disabled:opacity-50"
                >
                  {saving ? 'Saving…' : editId !== null ? 'Save Changes' : 'Create Schedule'}
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Target picker component
// ══════════════════════════════════════════════════════════════

function TargetPicker({
  connections,
  targets,
  onChange,
}: {
  connections: any[];
  targets: ScheduleTarget[];
  onChange: (targets: ScheduleTarget[]) => void;
}) {
  // Load all test plans once
  const { data: allPlans = [] } = useQuery({
    queryKey: ['test-plans-all'],
    queryFn: () => api.listTestPlans(),
  });

  const [expandedPieces, setExpandedPieces] = useState<Set<string>>(new Set());
  const allPiecesSelected = targets.length === 0;

  // group plans by piece (target names), and track which targets are triggers
  const plansByPiece: Record<string, string[]> = {};
  const targetTypeByPiece: Record<string, Record<string, 'action' | 'trigger'>> = {};
  for (const plan of allPlans as any[]) {
    if (!plansByPiece[plan.piece_name]) { plansByPiece[plan.piece_name] = []; targetTypeByPiece[plan.piece_name] = {}; }
    plansByPiece[plan.piece_name].push(plan.target_action);
    targetTypeByPiece[plan.piece_name][plan.target_action] = plan.target_type === 'trigger' ? 'trigger' : 'action';
  }
  const isTriggerTarget = (pieceName: string, name: string) => targetTypeByPiece[pieceName]?.[name] === 'trigger';
  /** Human label like "2 actions · 3 triggers" for a piece's plans. */
  function planCountLabel(pieceName: string): string {
    const names = plansByPiece[pieceName] ?? [];
    const triggers = names.filter(n => isTriggerTarget(pieceName, n)).length;
    const actions = names.length - triggers;
    const parts: string[] = [];
    if (actions > 0) parts.push(`${actions} action${actions !== 1 ? 's' : ''}`);
    if (triggers > 0) parts.push(`${triggers} trigger${triggers !== 1 ? 's' : ''}`);
    return parts.join(' · ') || '0 plans';
  }

  function toggleAllPieces() {
    onChange([]); // empty = all
  }

  function isPieceSelected(pieceName: string): boolean {
    if (allPiecesSelected) return false; // show as unchecked so user can see it's an "all" override
    return targets.some(t => t.piece_name === pieceName && !t.action_name) ||
      (plansByPiece[pieceName]?.length > 0 &&
        plansByPiece[pieceName].every(a => targets.some(t => t.piece_name === pieceName && t.action_name === a)));
  }

  function isActionSelected(pieceName: string, actionName: string): boolean {
    if (allPiecesSelected) return false;
    return targets.some(t => t.piece_name === pieceName && (!t.action_name || t.action_name === actionName));
  }

  function togglePiece(pieceName: string) {
    if (allPiecesSelected) {
      // "All" was selected — clicking a piece selects ONLY that piece
      onChange([{ piece_name: pieceName }]);
      return;
    }
    const hasPiece = targets.some(t => t.piece_name === pieceName);
    if (hasPiece) {
      const next = targets.filter(t => t.piece_name !== pieceName);
      onChange(next); // 0 items → stays as specific selection (empty = would mean all, so keep empty list)
    } else {
      onChange([...targets, { piece_name: pieceName }]);
    }
  }

  function toggleAction(pieceName: string, actionName: string) {
    if (allPiecesSelected) {
      // "All" was selected — clicking one action selects ONLY that action
      onChange([{ piece_name: pieceName, action_name: actionName }]);
      return;
    }

    const hasAction = targets.some(t => t.piece_name === pieceName && t.action_name === actionName);
    const hasPieceWild = targets.some(t => t.piece_name === pieceName && !t.action_name);

    if (hasPieceWild) {
      // Expand wildcard into individual actions, removing this one
      const actions = plansByPiece[pieceName] ?? [];
      const expanded = actions
        .filter(a => a !== actionName)
        .map(a => ({ piece_name: pieceName, action_name: a }));
      const rest = targets.filter(t => t.piece_name !== pieceName);
      onChange([...rest, ...expanded]);
    } else if (hasAction) {
      onChange(targets.filter(t => !(t.piece_name === pieceName && t.action_name === actionName)));
    } else {
      onChange([...targets, { piece_name: pieceName, action_name: actionName }]);
    }
  }

  function toggleExpand(pieceName: string) {
    setExpandedPieces(prev => {
      const next = new Set(prev);
      if (next.has(pieceName)) next.delete(pieceName); else next.add(pieceName);
      return next;
    });
  }

  const selectedPieceCount = new Set(targets.map(t => t.piece_name)).size;
  const selectedActionCount = targets.reduce((sum, t) => {
    if (t.action_name) return sum + 1;
    return sum + (plansByPiece[t.piece_name]?.length || 1);
  }, 0);
  const scopeDesc = allPiecesSelected
    ? 'Runs all pieces'
    : targets.length === 0
      ? 'Nothing selected'
      : `${selectedPieceCount} piece${selectedPieceCount !== 1 ? 's' : ''}, ${selectedActionCount} test${selectedActionCount !== 1 ? 's' : ''}`;

  return (
    <div>
      <label className="block text-sm text-gray-400 mb-2">Test scope</label>
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        {/* "All pieces" row */}
        <label className="flex items-center gap-3 px-3 py-2.5 bg-gray-800/60 hover:bg-gray-800 cursor-pointer border-b border-gray-700/50">
          <input
            type="checkbox"
            checked={allPiecesSelected}
            onChange={toggleAllPieces}
            className="accent-primary-500"
          />
          <span className="text-sm text-gray-300 font-medium">All pieces (actions &amp; triggers)</span>
          <span className="ml-auto text-xs text-gray-500">{scopeDesc}</span>
        </label>

        {/* Per-piece rows */}
        {connections.map((conn: any) => {
          const actions = plansByPiece[conn.piece_name] ?? [];
          const pieceChecked = isPieceSelected(conn.piece_name);
          const expanded = expandedPieces.has(conn.piece_name);

          return (
            <div key={conn.piece_name} className="border-b border-gray-700/30 last:border-b-0">
              <div className="flex items-center gap-2 px-3 py-2 hover:bg-gray-800/40">
                <input
                  type="checkbox"
                  checked={pieceChecked}
                  onChange={() => togglePiece(conn.piece_name)}
                  className="accent-primary-500 cursor-pointer"
                />
                <span
                  className="flex-1 text-sm text-gray-300 cursor-pointer select-none"
                  onClick={() => togglePiece(conn.piece_name)}
                >
                  {conn.display_name}
                </span>
                {actions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleExpand(conn.piece_name)}
                    className="text-xs text-gray-500 hover:text-gray-200 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-gray-700"
                  >
                    <ChevronRight size={12} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
                    {planCountLabel(conn.piece_name)}
                  </button>
                )}
                {actions.length === 0 && (
                  <span className="text-xs text-gray-600">no test plans</span>
                )}
              </div>

              {/* Target rows (actions + triggers) */}
              {expanded && actions.map(actionName => {
                const isTrig = isTriggerTarget(conn.piece_name, actionName);
                return (
                  <label
                    key={actionName}
                    className="flex items-center gap-2 pl-8 pr-3 py-1.5 hover:bg-gray-800/30 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={isActionSelected(conn.piece_name, actionName)}
                      onChange={() => toggleAction(conn.piece_name, actionName)}
                      className="accent-primary-500 cursor-pointer"
                    />
                    <span className="text-xs font-mono text-gray-400">
                      {actionName}
                    </span>
                    {isTrig ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 uppercase tracking-wide">trigger</span>
                    )
                    : (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 uppercase tracking-wide">action</span>
                    )
                  }
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Expandable plan-run cards (reused from History page style)
// ══════════════════════════════════════════════════════════════

function ExpandablePlanRuns({ runs, scheduleLabels, focusRunId }: { runs: PlanRunRecord[]; scheduleLabels: Record<number, string>; focusRunId?: number | null }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [expandedWave, setExpandedWave] = useState<string | null>(null); // null = default(first open), '__none__' = all closed
  const [expandedRun, setExpandedRun] = useState<number | null>(null);

  // Deep-link focus: once the target run has loaded, open its wave, expand it, and scroll to it.
  // Guarded so it only auto-focuses once (the user can freely collapse it afterward).
  const didFocusRef = useRef(false);
  useEffect(() => {
    if (didFocusRef.current || focusRunId == null || runs.length === 0) return;
    const wave = clusterWaves(runs).find(w => w.runs.some(r => r.id === focusRunId));
    if (!wave) return; // run not in the loaded set (older than the fetch window)
    didFocusRef.current = true;
    setExpandedRun(focusRunId);
    setExpandedWave(wave.key);
    requestAnimationFrame(() =>
      document.getElementById(`plan-run-${focusRunId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }, [focusRunId, runs]);

  if (runs.length === 0) {
    return (
      <p className="text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-lg p-4">
        No scheduled plan runs yet. Runs will appear here after your schedules fire.
      </p>
    );
  }

  const total = runs.length;
  const passed = runs.filter(r => r.status === 'completed').length;
  const failed = runs.filter(r => r.status === 'failed').length;
  const running = runs.filter(r => r.status === 'running').length;

  const view = failedOnly ? runs.filter(r => r.status === 'failed') : runs;
  const waves = clusterWaves(view);

  // Most recent wave is open by default; '__none__' means the user closed it.
  const openKey = expandedWave === null ? (waves[0]?.key ?? null)
    : expandedWave === '__none__' ? null
    : expandedWave;
  const toggleWave = (key: string) => setExpandedWave(openKey === key ? '__none__' : key);

  return (
    <div className="space-y-3">
      {/* Summary + filter */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="text-gray-400">{total} runs</span>
        <span className="text-green-400">{passed} passed</span>
        <span className="text-red-400">{failed} failed</span>
        {running > 0 && <span className="text-blue-400">{running} running</span>}
        <button
          onClick={() => setFailedOnly(v => !v)}
          className={`ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded border transition-colors ${
            failedOnly ? 'border-red-500/50 text-red-400 bg-red-500/10' : 'border-gray-700 text-gray-400 hover:text-gray-200'
          }`}
        >
          <Filter size={11} /> Failed only
        </button>
      </div>

      {waves.length === 0 ? (
        <p className="text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-lg p-4">
          {failedOnly ? 'No failed runs in this view. 🎉' : 'No runs to show.'}
        </p>
      ) : (
        <div className="space-y-2">
          {waves.map(wave => (
            <WaveGroup
              key={wave.key}
              wave={wave}
              scheduleLabels={scheduleLabels}
              open={openKey === wave.key}
              onToggle={() => toggleWave(wave.key)}
              expandedRun={expandedRun}
              onToggleRun={(id) => setExpandedRun(expandedRun === id ? null : id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One collapsible group per schedule fire ("wave"): summary on the header,
// the individual runs inside.
function WaveGroup({ wave, scheduleLabels, open, onToggle, expandedRun, onToggleRun }: {
  wave: Wave;
  scheduleLabels: Record<number, string>;
  open: boolean;
  onToggle: () => void;
  expandedRun: number | null;
  onToggleRun: (id: number) => void;
}) {
  const total = wave.runs.length;
  const passed = wave.runs.filter(r => r.status === 'completed').length;
  const failed = wave.runs.filter(r => r.status === 'failed').length;
  const running = wave.runs.filter(r => r.status === 'running').length;

  const icon = running > 0 ? <Loader2 size={14} className="text-blue-400 animate-spin" />
    : failed > 0 ? <XCircle size={14} className="text-red-400" />
    : <CheckCircle size={14} className="text-green-400" />;
  const border = failed > 0 ? 'border-red-500/20' : running > 0 ? 'border-blue-500/20' : 'border-gray-800';

  // Name the schedule that fired this wave. Falls back to a generic "scheduled" badge
  // when the schedule was deleted, or a muted "grouped by time" note for legacy runs
  // that predate wave tracking (grouped by the 10-min heuristic, not a real fire).
  const schedName = wave.scheduleId != null ? scheduleLabels[wave.scheduleId] : undefined;

  return (
    <div className={`border rounded-lg ${border} bg-gray-900/60 overflow-hidden`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/40 transition-colors"
      >
        {open ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
        {icon}
        <span className="text-sm font-medium text-gray-200">{formatDateTime(wave.startTs)}</span>
        {schedName ? (
          <span className="flex items-center gap-1 text-[10px] text-purple-300 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded" title="Fired by this schedule">
            <CalendarClock size={10} className="text-purple-400" /> {schedName}
          </span>
        ) : wave.grouping === 'time' ? (
          <span className="flex items-center gap-1 text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded" title="Legacy run grouped by time — predates wave tracking">
            <Calendar size={10} className="text-gray-500" /> grouped by time
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">
            <Calendar size={10} className="text-purple-400" /> scheduled
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-xs">
          <span className={failed > 0 ? 'text-gray-400' : 'text-green-400'}>{passed}/{total} passed</span>
          {failed > 0 && <span className="text-red-400 font-medium">{failed} failed</span>}
          {running > 0 && <span className="text-blue-400">{running} running</span>}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-800/50 px-2 py-2 space-y-1.5 bg-gray-950/30">
          {wave.runs.map(run => (
            <PlanRunCard
              key={run.id}
              run={run}
              expanded={expandedRun === run.id}
              onToggle={() => onToggleRun(run.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanRunCard({ run, expanded, onToggle }: { run: PlanRunRecord; expanded: boolean; onToggle: () => void }) {
  const stepResults: StepResult[] = Array.isArray(run.step_results)
    ? run.step_results
    : (typeof run.step_results === 'string' ? JSON.parse(run.step_results as any) : []);

  const stepsCompleted = stepResults.filter(s => s.status === 'completed').length;
  const stepsFailed    = stepResults.filter(s => s.status === 'failed').length;
  const totalSteps     = stepResults.length;
  const duration = runDurationSec(run);

  const statusBorder = run.status === 'completed' ? 'border-green-500/20'
    : run.status === 'failed' ? 'border-red-500/20'
    : 'border-gray-800';

  const statusIcon = run.status === 'completed' ? <CheckCircle size={14} className="text-green-400" />
    : run.status === 'failed' ? <XCircle size={14} className="text-red-400" />
    : run.status === 'running' ? <Loader2 size={14} className="text-blue-400 animate-spin" />
    : <Clock size={14} className="text-gray-500" />;

  return (
    <div id={`plan-run-${run.id}`} className={`border rounded-lg ${statusBorder} bg-gray-900 overflow-hidden`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/50 transition-colors"
      >
        {statusIcon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-200">{run.target_action}</span>
            <span className="text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{run.piece_name}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="flex items-center gap-1 text-[10px] text-gray-500">
              <Calendar size={10} className="text-purple-400" /> scheduled
            </span>
            <span className="text-[10px] text-gray-600">#{run.id}</span>
          </div>
        </div>

        {/* Step mini-dots */}
        <div className="flex items-center gap-0.5">
          {stepResults.map((sr, i) => {
            const color = sr.status === 'completed' ? 'bg-green-500'
              : sr.status === 'failed' ? 'bg-red-500'
              : sr.status === 'running' ? 'bg-blue-500 animate-pulse'
              : sr.status === 'waiting' ? 'bg-yellow-500'
              : sr.status === 'skipped' ? 'bg-gray-600' : 'bg-gray-700';
            return <div key={i} className={`w-2.5 h-1.5 rounded-sm ${color}`} />;
          })}
        </div>

        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span>{stepsCompleted}/{totalSteps} steps</span>
          {stepsFailed > 0 && <span className="text-red-400">{stepsFailed} failed</span>}
          {duration != null && <span>{duration}s</span>}
          <span>{formatDateTime(run.started_at)}</span>
        </div>

        {expanded ? <ChevronDown size={14} className="text-gray-500 flex-shrink-0" /> : <ChevronRight size={14} className="text-gray-500 flex-shrink-0" />}
      </button>

      {run.status === 'failed' && !expanded && (() => {
        const reason = firstFailedStepError(run);
        return reason ? (
          <div className="px-4 pb-2.5 -mt-1 ml-7 flex items-start gap-1.5 text-[11px] text-red-300/80">
            <span className="text-red-500 shrink-0">└</span>
            <span className="font-mono break-all">{reason}</span>
          </div>
        ) : null;
      })()}

      {expanded && (
        <div className="border-t border-gray-800/50 px-4 py-3 space-y-1">
          {stepResults.length === 0 && <p className="text-xs text-gray-500">No step results recorded.</p>}
          {stepResults.map((sr, idx) => (
            <StepResultRow key={sr.stepId || String(idx)} sr={sr} idx={idx} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepResultRow({ sr, idx }: { sr: StepResult; idx: number }) {
  const [showOutput, setShowOutput] = useState(false);

  const icon = sr.status === 'completed' ? <CheckCircle size={12} className="text-green-400" />
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
        {icon}
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
        <div className="ml-8 mt-1 text-[10px] text-green-400/60 bg-green-500/5 rounded p-1.5 font-mono max-h-40 overflow-y-auto whitespace-pre-wrap">
          {typeof sr.output === 'string' ? sr.output : JSON.stringify(sr.output, null, 2)}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Expandable legacy test-run rows
// ══════════════════════════════════════════════════════════════

function ExpandableLegacyRuns({ runs }: { runs: any[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<any>(null);

  async function toggle(id: number) {
    if (expandedId === id) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(id);
    setDetail(null);
    const data = await api.getHistoryRun(id);
    setDetail(data);
  }

  if (runs.length === 0) {
    return (
      <p className="text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-lg p-4">
        No scheduled test runs yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((r: any) => (
        <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <button
            onClick={() => toggle(r.id)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors text-left"
          >
            <div className="flex items-center gap-3">
              {expandedId === r.id ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
              <span className="text-sm font-medium">Run #{r.id}</span>
              <TestResultBadge status={r.status} />
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">scheduled</span>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span className="text-green-400">{r.passed ?? 0} passed</span>
              <span className="text-red-400">{(r.failed ?? 0) + (r.errors ?? 0)} failed</span>
              <span className="text-gray-500">{r.total_tests ?? 0} total</span>
              <span>{formatDateTime(r.started_at)}</span>
            </div>
          </button>

          {expandedId === r.id && (
            <div className="border-t border-gray-800 px-4 py-3 space-y-2">
              {!detail && <p className="text-xs text-gray-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading details…</p>}
              {detail && detail.results?.length === 0 && <p className="text-xs text-gray-500">No individual results recorded.</p>}
              {detail?.results?.map((res: any, i: number) => (
                <div key={i} className="flex items-center justify-between py-1.5 px-3 bg-gray-800/50 rounded text-sm">
                  <div className="flex items-center gap-3">
                    <TestResultBadge status={res.status} />
                    <span className="text-gray-300">{res.piece_name}</span>
                    <span className="text-gray-500 text-xs">{res.action_name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {res.duration_ms > 0 && <span>{(res.duration_ms / 1000).toFixed(1)}s</span>}
                    {res.error_message && (
                      <span className="text-red-400 max-w-xs truncate" title={res.error_message}>
                        {res.error_message}
                      </span>
                    )}
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

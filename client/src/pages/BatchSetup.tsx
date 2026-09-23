import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type AgentLogEntry, type BatchStatus, type BatchQueueItemStatus, type ScheduleConfigInput, type SetupRunItem, type BatchSelection } from '../lib/api';
import { ScheduleStep } from '../components/ScheduleStep';
import { SetupRunHistory } from '../components/SetupRunHistory';
import {
  pieceCoverage, matchesFilter, filterCounts, gapSelection,
  type CoverageFilter, type PieceCoverage,
} from '../lib/batchCoverage';
import {
  Play, Loader2, Search, CheckCircle, XCircle, SkipForward,
  ChevronDown, ChevronRight, StopCircle, Brain, Puzzle,
  Clock, AlertTriangle, ListChecks, RefreshCw, Plug, Calendar,
  ArrowRight, X, History, Zap,
} from 'lucide-react';

type ItemStatus = BatchQueueItemStatus['status'];
type Step = 'connections' | 'generate' | 'done';

const STEPS: { key: Step; label: string; icon: JSX.Element }[] = [
  { key: 'connections', label: 'Connections', icon: <Plug size={14} /> },
  { key: 'generate', label: 'Generate', icon: <Brain size={14} /> },
  { key: 'done', label: 'Done', icon: <CheckCircle size={14} /> },
];

const CADENCE_LABELS: Record<ScheduleConfigInput['cadence'], string> = {
  monthly: 'Monthly (staggered per piece)',
  '6h': 'Every 6 hours',
  daily: 'Daily',
  weekly: 'Weekly',
  custom: 'Custom cron',
  none: 'No schedule',
};

const STATUS_BADGE: Record<ItemStatus, { icon: JSX.Element; label: string; cls: string }> = {
  pending:  { icon: <Clock size={12} />,        label: 'Pending',  cls: 'text-gray-400 bg-gray-800' },
  running:  { icon: <Loader2 size={12} className="animate-spin" />, label: 'Running',  cls: 'text-blue-300 bg-blue-500/20' },
  done:     { icon: <CheckCircle size={12} />,   label: 'Done',     cls: 'text-green-300 bg-green-500/20' },
  error:    { icon: <XCircle size={12} />,       label: 'Error',    cls: 'text-red-300 bg-red-500/20' },
  skipped:  { icon: <SkipForward size={12} />,   label: 'Skipped',  cls: 'text-yellow-300 bg-yellow-500/20' },
};

/** Ordered targets (actions then triggers) from full piece metadata. */
function pieceTargetList(meta: any): { type: 'action' | 'trigger'; name: string; displayName: string; key: string }[] {
  if (!meta) return [];
  const out: { type: 'action' | 'trigger'; name: string; displayName: string; key: string }[] = [];
  for (const [name, m] of Object.entries(meta.actions || {})) {
    out.push({ type: 'action', name, displayName: (m as any)?.displayName || name, key: `action:${name}` });
  }
  for (const [name, m] of Object.entries(meta.triggers || {})) {
    out.push({ type: 'trigger', name, displayName: (m as any)?.displayName || name, key: `trigger:${name}` });
  }
  return out;
}

export default function BatchSetup() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: pieces, isLoading: loadingPieces } = useQuery({ queryKey: ['pieces'], queryFn: api.listPieces });
  const { data: connections } = useQuery({ queryKey: ['connections'], queryFn: api.listConnections });
  const { data: allPlans } = useQuery({ queryKey: ['testPlans'], queryFn: () => api.listTestPlans() });
  const { data: setupRuns, refetch: refetchRuns } = useQuery({ queryKey: ['setupRuns'], queryFn: api.getSetupRuns });

  const sweepMut = useMutation({
    mutationFn: () => api.sweepConnections(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); qc.invalidateQueries({ queryKey: ['pieces'] }); },
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Per-piece EXCLUDED target keys ('action:<name>' / 'trigger:<name>'). Absent/empty = all targets included.
  const [deselectedTargets, setDeselectedTargets] = useState<Record<string, Set<string>>>({});
  // Per-piece FULL target key list, recorded when a piece is expanded. Source of truth at Start
  // (the ['piece', name] query cache can be evicted, so never build the payload from it).
  const [pieceTargetKeys, setPieceTargetKeys] = useState<Record<string, string[]>>({});
  const [expandedSelect, setExpandedSelect] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>('needs');

  // Wizard state
  const [step, setStep] = useState<Step>('connections');
  const [wizardActive, setWizardActive] = useState(false);
  const [schedule, setSchedule] = useState<ScheduleConfigInput>({ enabled: true, cadence: 'monthly' });
  const [openRunId, setOpenRunId] = useState<number | null>(null);
  const [schedulesCreated, setSchedulesCreated] = useState<number | null>(null);
  const [scheduleExpanded, setScheduleExpanded] = useState(false);

  // Batch state
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [batchItems, setBatchItems] = useState<(BatchQueueItemStatus & { index: number })[]>([]);
  const [batchLogs, setBatchLogs] = useState<Record<number, AgentLogEntry[]>>({});
  const [expandedPiece, setExpandedPiece] = useState<string | null>(null);
  const [expandedItemLog, setExpandedItemLog] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skippedNotice, setSkippedNotice] = useState<string | null>(null);
  const subControllerRef = useRef<AbortController | null>(null);

  // Running batches for the dashboard — polled while on the landing view.
  const { data: activeBatches } = useQuery({
    queryKey: ['activeBatches'], queryFn: api.listActiveBatches, refetchInterval: 3000,
  });

  const connectedPieces = new Set(connections?.map((c: any) => c.piece_name) ?? []);

  const subscribeToExistingBatch = useCallback((id: string) => {
    subControllerRef.current?.abort();
    const controller = api.subscribeBatchSetup(id, {
      onItemUpdate: (data) => {
        setBatchItems(prev => {
          const next = [...prev];
          if (next[data.index]) {
            next[data.index] = { ...next[data.index], ...data };
          }
          return next;
        });
      },
      onLog: (data) => {
        setBatchLogs(prev => ({
          ...prev,
          [data.index]: [...(prev[data.index] || []), data.log],
        }));
      },
      onPlanCreated: (data) => {
        setBatchLogs(prev => ({
          ...prev,
          [data.index]: [
            ...(prev[data.index] || []),
            { timestamp: Date.now(), type: 'done', message: `Plan created (${data.steps.length} steps)` },
          ],
        }));
      },
      onPlanApproved: (data) => {
        setBatchLogs(prev => ({
          ...prev,
          [data.index]: [
            ...(prev[data.index] || []),
            { timestamp: Date.now(), type: 'done', message: 'Auto-test passed, plan approved!' },
          ],
        }));
      },
      onBatchDone: (data) => {
        setBatchStatus(prev => prev ? { ...prev, status: data.status as any, completedAt: Date.now() } : prev);
        if (typeof data.schedulesCreated === 'number') setSchedulesCreated(data.schedulesCreated);
        if (data.status === 'done' || data.status === 'cancelled') setStep('done');
        refreshStatus(id);
        refetchRuns();
        qc.invalidateQueries({ queryKey: ['activeBatches'] });
      },
      onError: (msg) => setError(msg),
    });
    subControllerRef.current = controller;
  }, [refetchRuns, qc]);

  useEffect(() => {
    return () => { subControllerRef.current?.abort(); };
  }, []);

  async function refreshStatus(id: string) {
    try {
      const status = await api.getBatchStatus(id);
      if (status) {
        setBatchStatus(status);
        setBatchItems(status.items.map((it, i) => ({ ...it, index: i })));
      }
    } catch {}
  }

  function clearDeselected(pieceName: string) {
    setDeselectedTargets(prev => {
      if (!prev[pieceName]) return prev;
      const next = { ...prev };
      delete next[pieceName];
      return next;
    });
  }

  function togglePiece(pieceName: string) {
    const isOn = selected.has(pieceName);
    setSelected(prev => {
      const next = new Set(prev);
      if (isOn) next.delete(pieceName);
      else next.add(pieceName);
      return next;
    });
    if (isOn) {
      clearDeselected(pieceName);
      return;
    }
    // Selecting → default to gaps only by deselecting already-planned targets.
    const planned = coverageByName.get(pieceName)?.plannedKeys;
    setDeselectedTargets(prev => {
      const next = { ...prev };
      if (planned && planned.size > 0) next[pieceName] = new Set(planned);
      else delete next[pieceName];
      return next;
    });
  }

  /** Toggle a single target key ('action:<name>' / 'trigger:<name>') for a piece. */
  function toggleTarget(pieceName: string, key: string, allKeys: string[]) {
    // Record the full target list now — it must survive query-cache eviction to build the Start payload.
    setPieceTargetKeys(prev => ({ ...prev, [pieceName]: allKeys }));
    setDeselectedTargets(prev => {
      const cur = new Set(prev[pieceName] ?? []);
      if (cur.has(key)) cur.delete(key);
      else cur.add(key);

      const allDeselected = allKeys.length > 0 && allKeys.every(k => cur.has(k));
      setSelected(sel => {
        const nextSel = new Set(sel);
        if (allDeselected) nextSel.delete(pieceName);
        else nextSel.add(pieceName);
        return nextSel;
      });

      const next = { ...prev };
      if (cur.size === 0) delete next[pieceName];
      else next[pieceName] = cur;
      return next;
    });
  }

  function selectAll() {
    // Only the currently-visible (filtered) pieces, gaps only.
    const { selected: names, deselected } = gapSelection(filtered, allPlans);
    setSelected(new Set(names));
    setDeselectedTargets(
      Object.fromEntries(Object.entries(deselected).map(([k, v]) => [k, new Set(v)])),
    );
  }

  function selectNone() {
    setSelected(new Set());
    setDeselectedTargets({});
  }

  function getConnectedPieces() {
    return (pieces || []).filter((p: any) => connectedPieces.has(p.name));
  }

  async function openBatch(id: string) {
    setError(null);
    setSkippedNotice(null);
    setBatchLogs({});
    setSchedulesCreated(null);
    setActiveBatchId(id);
    setWizardActive(true);
    try {
      const status = await api.getBatchStatus(id);
      if (status) {
        setBatchStatus(status);
        setBatchItems(status.items.map((it, i) => ({ ...it, index: i })));
        setStep(status.status === 'running' ? 'generate' : 'done');
        if (status.status === 'running') subscribeToExistingBatch(id);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleStart() {
    if (selected.size === 0) return;
    setStarting(true);
    setError(null);
    setSkippedNotice(null);
    setBatchLogs({});
    setSchedulesCreated(null);
    try {
      const keyToTarget = (key: string) => {
        const idx = key.indexOf(':');
        return { type: key.slice(0, idx) as 'action' | 'trigger', name: key.slice(idx + 1) };
      };
      const selections: BatchSelection[] = Array.from(selected).map(pieceName => {
        const deselected = deselectedTargets[pieceName];
        if (!deselected || deselected.size === 0) return { pieceName };
        // Build from the recorded full key list — NOT the query cache, which may be evicted.
        const keys = pieceTargetKeys[pieceName];
        // Defensive: a deselected set with no recorded keys should not happen; send all rather than none.
        if (!keys) return { pieceName };
        const targets = keys.filter(k => !deselected.has(k)).map(keyToTarget);
        return { pieceName, targets };
      });
      const res = await api.startBatchSetup(selections, schedule);
      setActiveBatchId(res.id);
      if (res.skippedPieces?.length) {
        setSkippedNotice(`${res.skippedPieces.length} piece(s) skipped — already in an active batch`);
      }
      const status = await api.getBatchStatus(res.id);
      if (status) {
        setBatchStatus(status);
        setBatchItems(status.items.map((it, i) => ({ ...it, index: i })));
      }
      subscribeToExistingBatch(res.id);
      qc.invalidateQueries({ queryKey: ['activeBatches'] });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel() {
    if (!activeBatchId) return;
    try {
      await api.cancelBatchSetup(activeBatchId);
      setTimeout(() => refreshStatus(activeBatchId), 1000);
    } catch (err: any) {
      setError(err.message);
    }
  }

  function startNewRun() {
    subControllerRef.current?.abort();
    setActiveBatchId(null);
    setBatchStatus(null);
    setBatchItems([]);
    setBatchLogs({});
    setSelected(new Set());
    setError(null);
    setSkippedNotice(null);
    setSchedulesCreated(null);
    setStep('connections');
    setWizardActive(true);
  }

  function backToLanding() {
    subControllerRef.current?.abort();
    setActiveBatchId(null);
    setBatchStatus(null);
    setBatchItems([]);
    setBatchLogs({});
    setError(null);
    setSkippedNotice(null);
    setWizardActive(false);
    setStep('connections');
    refetchRuns();
    qc.invalidateQueries({ queryKey: ['activeBatches'] });
  }

  const isRunning = batchStatus?.status === 'running';
  const runningBatches = (activeBatches ?? []).filter((b: any) => b?.status === 'running');

  // Group items by piece for display
  const groupedItems = batchItems.reduce<Record<string, (BatchQueueItemStatus & { index: number })[]>>((acc, item) => {
    if (!acc[item.pieceName]) acc[item.pieceName] = [];
    acc[item.pieceName].push(item);
    return acc;
  }, {});

  const connectedList = getConnectedPieces();
  const coverageByName = new Map<string, PieceCoverage>(
    connectedList.map((p: any) => [p.name, pieceCoverage(p, allPlans)]),
  );
  const searchFiltered = connectedList.filter((p: any) =>
    p.displayName.toLowerCase().includes(search.toLowerCase()) ||
    p.name.toLowerCase().includes(search.toLowerCase())
  );
  const chipCounts = filterCounts(searchFiltered.map((p: any) => coverageByName.get(p.name)!.state));
  const filtered = searchFiltered.filter((p: any) =>
    matchesFilter(coverageByName.get(p.name)!.state, coverageFilter),
  );

  // Stats
  const stats = batchItems.reduce(
    (a, it) => { a[it.status] = (a[it.status] || 0) + 1; return a; },
    {} as Record<string, number>,
  );

  if (loadingPieces) return <div className="text-gray-400">Loading pieces...</div>;

  // ─── Landing (no active wizard) ───
  if (!wizardActive) {
    return (
      <div>
        {openRunId != null && <RunDetailDrawer runId={openRunId} onClose={() => setOpenRunId(null)} navigate={navigate} />}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <ListChecks size={24} /> Batch Setup
            </h2>
            <p className="text-gray-400 text-sm mt-1">
              Generate AI test plans for a set of pieces (actions and triggers), then auto-schedule them.
            </p>
          </div>
          <button onClick={startNewRun} className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg text-sm font-medium transition-colors">
            <Play size={16} /> New Setup Run
          </button>
        </div>

        {runningBatches.length > 0 && (
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-3 text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin text-blue-400" /> Running batches
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
              {runningBatches.map((b: any) => {
                const pieceNames = Array.from(new Set((b.items ?? []).map((it: any) => it.pieceDisplayName || it.pieceName)));
                const done = b.stats?.done ?? 0;
                return (
                  <div key={b.id} className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">
                        {pieceNames.slice(0, 4).join(', ')}
                        {pieceNames.length > 4 && ` +${pieceNames.length - 4} more`}
                      </div>
                      <div className="text-xs text-gray-500">{done} of {b.totalItems} targets done</div>
                    </div>
                    <button onClick={() => openBatch(b.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors shrink-0">
                      Open <ArrowRight size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 mb-3 text-sm text-gray-400">
          <History size={16} /> Recent Setup Runs
        </div>
        <SetupRunHistory runs={setupRuns ?? []} onOpen={setOpenRunId} />
      </div>
    );
  }

  // ─── Wizard ───
  return (
    <div>
      {openRunId != null && <RunDetailDrawer runId={openRunId} onClose={() => setOpenRunId(null)} navigate={navigate} />}

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <ListChecks size={24} /> Batch Setup
        </h2>
        <button onClick={backToLanding} className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors">
          <X size={14} /> Close
        </button>
      </div>

      {/* Stepper header */}
      <div className="flex items-center gap-2 mb-6">
        {STEPS.map((s, i) => {
          const active = s.key === step;
          const doneStep = STEPS.findIndex(x => x.key === step) > i;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${active ? 'bg-primary-600 text-white' : doneStep ? 'text-green-300 bg-green-500/10' : 'text-gray-400 bg-gray-800'}`}>
                {s.icon} {s.label}
              </span>
              {i < STEPS.length - 1 && <ChevronRight size={14} className="text-gray-600" />}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 text-sm text-red-300 flex items-center gap-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {skippedNotice && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 mb-4 text-sm text-yellow-300 flex items-center gap-2">
          <SkipForward size={14} /> {skippedNotice}
        </div>
      )}

      {/* ── Step: Connections ── */}
      {step === 'connections' && (
        <div>
          <p className="text-gray-400 text-sm mb-4">
            Only pieces with an active connection can be set up. Import the connections already
            configured in Activepieces for each piece.
          </p>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6 flex items-center justify-between">
            <div>
              <div className="text-lg font-medium">{connectedList.length} connected piece{connectedList.length !== 1 ? 's' : ''}</div>
              <div className="text-sm text-gray-500">Ready to generate plans for.</div>
            </div>
            <button onClick={() => sweepMut.mutate()} disabled={sweepMut.isPending}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 rounded-lg font-medium disabled:opacity-50">
              {sweepMut.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
              {sweepMut.isPending ? 'Importing…' : 'Import connections'}
            </button>
          </div>
          {sweepMut.error && <p className="text-sm text-red-400 mb-4">{(sweepMut.error as Error).message}</p>}

          <div className="flex justify-end">
            <button
              onClick={() => setStep('generate')}
              disabled={connectedList.length === 0}
              className="flex items-center gap-2 px-6 py-2.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
            >
              Next <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step: Generate ── */}
      {step === 'generate' && (
        <div>
          {!batchStatus ? (
            <>
              <p className="text-gray-400 text-sm mb-4">
                Generate AI test plans for pieces that still have gaps. Filter to focus on what needs plans, expand a
                piece to pick individual targets. Plans are created one at a time; already-planned targets are skipped.
              </p>

              <div className="flex items-center gap-3 mb-3">
                <div className="relative flex-1 max-w-md">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input
                    className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-10 pr-3 py-2 text-sm focus:outline-none focus:border-primary-600"
                    placeholder="Search pieces..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </div>
                <button onClick={selectAll} className="px-3 py-2 text-sm text-primary-400 hover:text-primary-300 hover:bg-gray-800 rounded-lg transition-colors">
                  Select All
                </button>
                <button onClick={selectNone} className="px-3 py-2 text-sm text-gray-400 hover:text-gray-300 hover:bg-gray-800 rounded-lg transition-colors">
                  Clear
                </button>
              </div>

              <div className="flex items-center gap-1.5 mb-4">
                {([
                  { key: 'all', label: 'All', count: chipCounts.all },
                  { key: 'needs', label: 'Needs plans', count: chipCounts.needs },
                  { key: 'partial', label: 'Partial', count: chipCounts.partial },
                  { key: 'done', label: 'Done', count: chipCounts.done },
                ] as const).map(chip => {
                  const active = coverageFilter === chip.key;
                  return (
                    <button
                      key={chip.key}
                      onClick={() => setCoverageFilter(chip.key)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${active ? 'bg-primary-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
                    >
                      {chip.label} <span className={active ? 'text-primary-200' : 'text-gray-500'}>{chip.count}</span>
                    </button>
                  );
                })}
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800 mb-6 max-h-[440px] overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-gray-500">
                    {coverageFilter === 'needs'
                      ? 'All connected pieces are fully set up 🎉 — switch to All to review.'
                      : coverageFilter === 'partial'
                      ? 'No pieces are partially set up.'
                      : 'No pieces match.'}
                  </div>
                ) : filtered.map((piece: any) => (
                  <SelectPieceRow
                    key={piece.name}
                    piece={piece}
                    selected={selected.has(piece.name)}
                    deselected={deselectedTargets[piece.name]}
                    expanded={expandedSelect.has(piece.name)}
                    coverage={coverageByName.get(piece.name)!}
                    onToggleExpand={() => setExpandedSelect(prev => {
                      const next = new Set(prev);
                      if (next.has(piece.name)) next.delete(piece.name);
                      else next.add(piece.name);
                      return next;
                    })}
                    onTogglePiece={() => togglePiece(piece.name)}
                    onToggleTarget={(key, allKeys) => toggleTarget(piece.name, key, allKeys)}
                  />
                ))}
              </div>

              {/* Collapsed schedule config — cadence is sent at Start */}
              <div className="bg-gray-900 border border-gray-800 rounded-lg mb-6">
                <button
                  onClick={() => setScheduleExpanded(v => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar size={16} className="text-primary-400" />
                    Schedule after setup: <span className="text-gray-400">{schedule.enabled ? CADENCE_LABELS[schedule.cadence] : 'off'}</span>
                  </div>
                  {scheduleExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                {scheduleExpanded && (
                  <div className="border-t border-gray-800 p-4">
                    <ScheduleStep value={schedule} onChange={setSchedule} />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-400">
                  {selected.size} piece{selected.size !== 1 ? 's' : ''} selected
                </div>
                <button
                  onClick={handleStart}
                  disabled={selected.size === 0 || starting}
                  className="flex items-center gap-2 px-6 py-2.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
                >
                  {starting ? <Loader2 size={16} className="animate-spin" /> : <Brain size={16} />}
                  Start
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4">
                <p className="text-gray-400 text-sm">
                  {isRunning ? 'Creating plans…' : `Batch ${batchStatus.status}`} — {batchItems.length} targets total
                </p>
                {isRunning && (
                  <button onClick={handleCancel} className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition-colors">
                    <StopCircle size={16} /> Cancel
                  </button>
                )}
              </div>

              <BatchProgress
                batchStatus={batchStatus}
                batchItems={batchItems}
                batchLogs={batchLogs}
                stats={stats}
                groupedItems={groupedItems}
                expandedPiece={expandedPiece}
                setExpandedPiece={setExpandedPiece}
                expandedItemLog={expandedItemLog}
                setExpandedItemLog={setExpandedItemLog}
                navigate={navigate}
              />

              <div className="flex justify-end mt-6">
                <button
                  onClick={() => setStep('done')}
                  disabled={isRunning}
                  className="flex items-center gap-2 px-6 py-2.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
                >
                  Next <ArrowRight size={16} />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Step: Done ── */}
      {step === 'done' && (
        <div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6 text-center">
            <CheckCircle size={40} className={`mx-auto mb-3 ${batchStatus?.status === 'cancelled' ? 'text-yellow-400' : 'text-green-400'}`} />
            <div className="text-lg font-medium mb-1">
              {batchStatus?.status === 'cancelled' ? 'Setup cancelled' : 'Setup complete'}
            </div>
            <div className="flex items-center justify-center gap-4 text-sm mt-4">
              <span className="text-green-400">{stats.done || 0} plans</span>
              <span className="text-yellow-400">{stats.skipped || 0} skipped</span>
              <span className="text-red-400">{stats.error || 0} errors</span>
            </div>
            <div className="text-sm text-gray-400 mt-2">
              Scheduling: {schedule.enabled ? CADENCE_LABELS[schedule.cadence] : 'skipped'}
              {schedulesCreated != null && ` — ${schedulesCreated} schedule${schedulesCreated !== 1 ? 's' : ''} created`}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={startNewRun} className="flex items-center gap-2 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm font-medium transition-colors">
              <RefreshCw size={16} /> New Setup Run
            </button>
            <button onClick={backToLanding} className="flex items-center gap-2 px-6 py-2.5 bg-primary-600 hover:bg-primary-700 rounded-lg text-sm font-medium transition-colors">
              <History size={16} /> View history
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── One selectable piece row (Generate step) with expandable per-target checkboxes ───
function SelectPieceRow({
  piece, selected, deselected, expanded, coverage,
  onToggleExpand, onTogglePiece, onToggleTarget,
}: {
  piece: any;
  selected: boolean;
  deselected: Set<string> | undefined;
  expanded: boolean;
  coverage: PieceCoverage;
  onToggleExpand: () => void;
  onTogglePiece: () => void;
  onToggleTarget: (key: string, allKeys: string[]) => void;
}) {
  const { data: meta } = useQuery({ queryKey: ['piece', piece.name], queryFn: () => api.getPiece(piece.name), enabled: expanded });
  const checkboxRef = useRef<HTMLInputElement>(null);

  const targets = pieceTargetList(meta);
  const allKeys = targets.map(t => t.key);
  const deselectedCount = deselected?.size ?? 0;
  const fullyChecked = selected && deselectedCount === 0;
  const indeterminate = selected && deselectedCount > 0;

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const metaTotal = targets.length;
  const includedCount = metaTotal - deselectedCount;
  const { plannedKeys, plannedCount, totalTargets, state } = coverage;
  const pct = totalTargets > 0 ? Math.round((plannedCount / totalTargets) * 100) : 0;
  const barColor = state === 'done' ? 'bg-green-500' : state === 'partial' ? 'bg-amber-500' : 'bg-gray-600';

  return (
    <div className={selected ? 'bg-primary-600/10' : ''}>
      <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-800/50 transition-colors">
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={fullyChecked}
          onChange={onTogglePiece}
          className="w-4 h-4 rounded border-gray-600 text-primary-500 focus:ring-primary-500/30"
        />
        {piece.logoUrl ? (
          <img src={piece.logoUrl} alt="" className="w-8 h-8 rounded" />
        ) : (
          <div className="w-8 h-8 bg-gray-700 rounded flex items-center justify-center">
            <Puzzle size={14} className="text-gray-400" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{piece.displayName}</div>
          <div className="text-xs text-gray-500">
            {meta
              ? `${includedCount} of ${metaTotal} selected`
              : state === 'done' ? 'Fully set up' : `${totalTargets - plannedCount} to plan`}
          </div>
        </div>
        <div className="w-28 shrink-0">
          <div className="text-[11px] text-right text-gray-400 mb-1">{plannedCount} of {totalTargets} planned</div>
          <div className="w-full bg-gray-800 rounded-full h-1.5">
            <div className={`h-1.5 rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <button
          onClick={onToggleExpand}
          className="p-1 text-gray-500 hover:text-gray-300 rounded"
          title={expanded ? 'Collapse targets' : 'Select individual targets'}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-gray-800 bg-gray-950/50 px-4 py-2">
          {!meta ? (
            <div className="text-xs text-gray-500 py-1 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading targets…</div>
          ) : targets.length === 0 ? (
            <div className="text-xs text-gray-500 py-1">No actions or triggers.</div>
          ) : (
            targets.map(t => {
              const isPlanned = plannedKeys.has(t.key);
              return (
                <label key={t.key} className={`flex items-center gap-2.5 py-1 pl-7 cursor-pointer text-sm ${isPlanned ? 'opacity-60' : ''}`}>
                  <input
                    type="checkbox"
                    checked={!(deselected?.has(t.key))}
                    onChange={() => onToggleTarget(t.key, allKeys)}
                    className="w-3.5 h-3.5 rounded border-gray-600 text-primary-500 focus:ring-primary-500/30"
                  />
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${t.type === 'trigger' ? 'text-purple-300 bg-purple-500/15' : 'text-sky-300 bg-sky-500/15'}`}>
                    {t.type === 'trigger' ? <Zap size={10} /> : <Play size={10} />}
                    {t.type}
                  </span>
                  <span className="truncate">{t.displayName}</span>
                  {isPlanned && (
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-green-400/80 bg-green-500/10 px-1.5 py-0.5 rounded">planned</span>
                  )}
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ─── Grouped-by-piece live progress (reused from the original page) ───
function BatchProgress({
  batchStatus, batchItems, batchLogs, stats, groupedItems,
  expandedPiece, setExpandedPiece, expandedItemLog, setExpandedItemLog, navigate,
}: {
  batchStatus: BatchStatus;
  batchItems: (BatchQueueItemStatus & { index: number })[];
  batchLogs: Record<number, AgentLogEntry[]>;
  stats: Record<string, number>;
  groupedItems: Record<string, (BatchQueueItemStatus & { index: number })[]>;
  expandedPiece: string | null;
  setExpandedPiece: (v: string | null) => void;
  expandedItemLog: number | null;
  setExpandedItemLog: (v: number | null) => void;
  navigate: (path: string) => void;
}) {
  return (
    <div>
      {/* Progress bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex gap-4 text-sm">
            <span className="text-green-400">{stats.done || 0} done</span>
            <span className="text-blue-400">{stats.running || 0} running</span>
            <span className="text-gray-400">{stats.pending || 0} pending</span>
            <span className="text-red-400">{stats.error || 0} errors</span>
            <span className="text-yellow-400">{stats.skipped || 0} skipped</span>
          </div>
          {batchStatus.startedAt && (
            <span className="text-xs text-gray-500">
              Started {new Date(batchStatus.startedAt).toLocaleTimeString()}
              {batchStatus.completedAt && ` — Finished ${new Date(batchStatus.completedAt).toLocaleTimeString()}`}
            </span>
          )}
        </div>
        <div className="w-full bg-gray-800 rounded-full h-2.5">
          {(() => {
            const completed = (stats.done || 0) + (stats.error || 0) + (stats.skipped || 0);
            const pct = batchItems.length > 0 ? (completed / batchItems.length) * 100 : 0;
            return <div className="bg-primary-500 h-2.5 rounded-full transition-all" style={{ width: `${pct}%` }} />;
          })()}
        </div>
      </div>

      {/* Grouped items by piece */}
      <div className="space-y-3">
        {Object.entries(groupedItems).map(([pieceName, items]) => {
          const isExpanded = expandedPiece === pieceName;
          const displayName = items[0]?.pieceDisplayName || pieceName;
          const pieceDone = items.filter(i => i.status === 'done').length;
          const pieceTotal = items.length;
          const pieceSkipped = items.filter(i => i.status === 'skipped').length;
          const pieceErr = items.filter(i => i.status === 'error').length;
          const pieceRunning = items.some(i => i.status === 'running');

          return (
            <div key={pieceName} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <button
                onClick={() => setExpandedPiece(isExpanded ? null : pieceName)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <Puzzle size={16} className="text-primary-400" />
                  <span className="font-medium">{displayName}</span>
                  {pieceRunning && <Loader2 size={14} className="animate-spin text-blue-400" />}
                </div>
                <div className="flex items-center gap-3 text-xs">
                  {pieceDone > 0 && <span className="text-green-400">{pieceDone} done</span>}
                  {pieceErr > 0 && <span className="text-red-400">{pieceErr} error</span>}
                  {pieceSkipped > 0 && <span className="text-yellow-400">{pieceSkipped} skipped</span>}
                  <span className="text-gray-500">{pieceTotal} targets</span>
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-gray-800">
                  {items.map((item) => {
                    const badge = STATUS_BADGE[item.status];
                    const logs = batchLogs[item.index] || [];
                    const isLogExpanded = expandedItemLog === item.index;
                    const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;

                    return (
                      <div key={`${item.targetType}:${item.actionName}`} className="border-b border-gray-800/50 last:border-0">
                        <div
                          className="flex items-center justify-between px-6 py-2.5 hover:bg-gray-800/30 cursor-pointer"
                          onClick={() => setExpandedItemLog(isLogExpanded ? null : item.index)}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${badge.cls}`}>
                              {badge.icon} {badge.label}
                            </span>
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${item.targetType === 'trigger' ? 'text-purple-300 bg-purple-500/15' : 'text-sky-300 bg-sky-500/15'}`}>
                              {item.targetType === 'trigger' ? <Zap size={10} /> : <Play size={10} />}
                              {item.targetType}
                            </span>
                            <span className="text-sm truncate">{item.actionDisplayName}</span>
                            {lastLog && item.status === 'running' && (
                              <span className="text-xs text-gray-500 truncate max-w-xs">{lastLog.message}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            {logs.length > 0 && <span>{logs.length} logs</span>}
                            {item.status === 'done' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); navigate(`/pieces/${encodeURIComponent(pieceName)}`); }}
                                className="text-primary-400 hover:text-primary-300"
                              >
                                View
                              </button>
                            )}
                          </div>
                        </div>

                        {isLogExpanded && logs.length > 0 && (
                          <div className="px-6 pb-3">
                            <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 max-h-48 overflow-y-auto text-xs font-mono space-y-1">
                              {logs.map((log, j) => (
                                <div key={j} className={`${log.type === 'error' ? 'text-red-400' : log.type === 'done' ? 'text-green-400' : 'text-gray-400'}`}>
                                  <span className="text-gray-600">{new Date(log.timestamp).toLocaleTimeString()}</span>{' '}
                                  <span className="text-gray-500">[{log.type}]</span>{' '}
                                  {log.message}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Run-detail drawer ───
function RunDetailDrawer({ runId, onClose, navigate }: { runId: number; onClose: () => void; navigate: (path: string) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['setupRunDetail', runId], queryFn: () => api.getSetupRunDetail(runId) });

  const grouped = (data?.items ?? []).reduce<Record<string, SetupRunItem[]>>((acc, it) => {
    if (!acc[it.piece_name]) acc[it.piece_name] = [];
    acc[it.piece_name].push(it);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-gray-950 border-l border-gray-800 h-full overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <History size={18} /> Setup Run #{runId}
          </h3>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg">
            <X size={18} />
          </button>
        </div>

        {isLoading && <div className="text-gray-400 text-sm">Loading…</div>}

        {data && (
          <>
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4 text-sm flex flex-wrap gap-x-4 gap-y-1">
              <span className={data.run.status === 'done' ? 'text-green-400' : data.run.status === 'running' ? 'text-blue-400' : 'text-yellow-400'}>{data.run.status}</span>
              <span className="text-gray-400">Cadence: {data.run.cadence}</span>
              <span className="text-green-400">{data.run.plans_created} plans</span>
              <span className="text-yellow-400">{data.run.plans_skipped} skipped</span>
              <span className="text-red-400">{data.run.plans_errored} errors</span>
              <span className="text-primary-300">{data.run.schedules_created} schedules</span>
            </div>

            <div className="space-y-3">
              {Object.entries(grouped).map(([pieceName, items]) => {
                const displayName = items[0]?.piece_display_name || pieceName;
                return (
                  <div key={pieceName} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800">
                      <Puzzle size={14} className="text-primary-400" />
                      <span className="font-medium text-sm">{displayName}</span>
                      <span className="text-xs text-gray-500 ml-auto">{items.length} target{items.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="divide-y divide-gray-800/50">
                      {items.map((it) => {
                        const badge = STATUS_BADGE[it.status];
                        return (
                          <div key={it.id} className="flex items-center justify-between px-4 py-2 text-sm">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${badge.cls}`}>
                                {badge.icon} {badge.label}
                              </span>
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${it.target_type === 'trigger' ? 'text-purple-300 bg-purple-500/15' : 'text-sky-300 bg-sky-500/15'}`}>
                                {it.target_type === 'trigger' ? <Zap size={10} /> : <Play size={10} />}
                                {it.target_type}
                              </span>
                              <span className="truncate">{it.target_display_name || it.target_name}</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs shrink-0">
                              {it.error && <span className="text-red-400 truncate max-w-[160px]" title={it.error}>{it.error}</span>}
                              {it.plan_id != null && (
                                <button
                                  onClick={() => navigate(`/pieces/${encodeURIComponent(pieceName)}`)}
                                  className="text-primary-400 hover:text-primary-300"
                                >
                                  View plan
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

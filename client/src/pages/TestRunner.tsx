// client/src/pages/TestRunner.tsx
import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { buildPieceGroups, type PieceGroup } from '../lib/test-runner-selection';
import { runDurationSeconds } from '../lib/time';
import {
  Play, Loader2, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle, XCircle, MinusCircle, MessageSquare,
} from 'lucide-react';

interface RunMeta { piece: string; target: string; }

export default function TestRunner() {
  const { data: coverage } = useQuery({ queryKey: ['coverage'], queryFn: api.getCoverage });
  const { data: plans } = useQuery({ queryKey: ['testPlans'], queryFn: () => api.listTestPlans() });

  const groups = useMemo<PieceGroup[]>(
    () => (coverage && plans ? buildPieceGroups(coverage, plans) : []),
    [coverage, plans],
  );

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<{ plan_id: number; run_id: number }[]>([]);
  const [runData, setRunData] = useState<Record<number, any>>({});
  const metaRef = useRef<Record<number, RunMeta>>({});
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function runnablePlanIds(g: PieceGroup): number[] {
    return g.targets.filter((t) => t.runnable).map((t) => t.planId);
  }

  function togglePiece(g: PieceGroup) {
    const ids = runnablePlanIds(g);
    const next = new Set(selected);
    const allOn = ids.length > 0 && ids.every((id) => next.has(id));
    for (const id of ids) { if (allOn) next.delete(id); else next.add(id); }
    setSelected(next);
  }

  function toggleTarget(planId: number) {
    const next = new Set(selected);
    if (next.has(planId)) next.delete(planId); else next.add(planId);
    setSelected(next);
  }

  function toggleExpand(piece: string) {
    const next = new Set(expanded);
    if (next.has(piece)) next.delete(piece); else next.add(piece);
    setExpanded(next);
  }

  function selectAll() {
    const next = new Set<number>();
    for (const g of groups) for (const id of runnablePlanIds(g)) next.add(id);
    setSelected(next);
  }

  async function handleRun() {
    if (selected.size === 0) return;
    setRunning(true);
    setRunData({});
    // Remember piece/target for each plan so results can be labelled.
    metaRef.current = {};
    for (const g of groups) for (const t of g.targets) {
      if (selected.has(t.planId)) metaRef.current[t.planId] = { piece: g.displayName, target: t.targetAction };
    }
    try {
      const pairs = await api.runBatch([...selected], 'manual');
      setRuns(pairs);
      startPolling(pairs);
    } catch {
      setRunning(false);
    }
  }

  function startPolling(pairs: { plan_id: number; run_id: number }[]) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const updates: Record<number, any> = {};
      await Promise.all(pairs.map(async (p) => {
        try { updates[p.run_id] = await api.getPlanRun(p.run_id); } catch { /* keep polling */ }
      }));
      setRunData((prev) => ({ ...prev, ...updates }));
      const anyRunning = pairs.some((p) => (updates[p.run_id]?.status ?? 'running') === 'running');
      if (!anyRunning) { clearInterval(pollRef.current); setRunning(false); }
    }, 1500);
  }

  const totals = runs.reduce(
    (acc, p) => {
      const s = runData[p.run_id]?.status ?? 'running';
      acc.total++;
      if (s === 'completed') acc.passed++;
      else if (s === 'failed') acc.failed++;
      else if (s === 'blocked') acc.blocked++;
      else if (s.startsWith('paused')) acc.needsInput++;
      else if (s === 'running') acc.running++;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, blocked: 0, running: 0, needsInput: 0 },
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Test Runner</h2>
          <p className="text-sm text-gray-500 mt-1">Run existing approved plans on demand.</p>
        </div>
        {runs.length > 0 && (
          <Link to="/history" className="text-xs text-primary-400 hover:text-primary-300">View in Test Logs →</Link>
        )}
      </div>

      {/* Piece selection */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-gray-400">Select pieces to run:</p>
          <button onClick={selectAll} className="text-xs text-primary-400 hover:text-primary-300">Select All</button>
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-gray-500">
            No approved plans yet. Create them from a piece's <span className="text-gray-300">AI Test</span> or{' '}
            <Link to="/batch-setup" className="text-primary-400 hover:text-primary-300">Batch Setup</Link>.
          </p>
        ) : (
          <div className="space-y-1">
            {groups.map((g) => {
              const ids = runnablePlanIds(g);
              const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
              const someOn = ids.some((id) => selected.has(id));
              const isOpen = expanded.has(g.pieceName);
              return (
                <div key={g.pieceName} className="border border-gray-800 rounded">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button onClick={() => toggleExpand(g.pieceName)} className="text-gray-500 hover:text-gray-300">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <input
                      type="checkbox"
                      disabled={!g.runnable}
                      checked={allOn}
                      ref={(el) => { if (el) el.indeterminate = !allOn && someOn; }}
                      onChange={() => togglePiece(g)}
                    />
                    <span className={`text-sm ${g.runnable ? 'text-gray-200' : 'text-gray-500'}`}>{g.displayName}</span>
                    <span className="text-[10px] text-gray-600">{g.targets.length} target{g.targets.length !== 1 ? 's' : ''}</span>
                    {g.requiresAuth && !g.connected && (
                      <span className="flex items-center gap-1 text-[10px] text-amber-400" title="No active connection — connect first">
                        <AlertTriangle size={11} /> no connection
                      </span>
                    )}
                  </div>
                  {isOpen && (
                    <div className="border-t border-gray-800/60 px-3 py-2 space-y-1">
                      {g.targets.map((t) => (
                        <label
                          key={t.planId}
                          className={`flex items-center gap-2 text-xs ${t.runnable ? 'text-gray-300 cursor-pointer' : 'text-gray-600 cursor-not-allowed'}`}
                          title={t.reason ?? ''}
                        >
                          <input
                            type="checkbox"
                            disabled={!t.runnable}
                            checked={selected.has(t.planId)}
                            onChange={() => toggleTarget(t.planId)}
                          />
                          <span>{t.targetAction}</span>
                          <span className="text-[10px] text-gray-600">{t.targetType}</span>
                          {!t.runnable && t.reason && (
                            <span className="flex items-center gap-1 text-amber-400/80"><AlertTriangle size={10} /> {t.reason}</span>
                          )}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-3 mt-4">
          <button
            onClick={handleRun}
            disabled={running || selected.size === 0}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-sm font-medium disabled:opacity-50"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Run Selected ({selected.size})
          </button>
        </div>
      </div>

      {/* Results */}
      {runs.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex gap-4 mb-4 text-sm">
            <span className="text-gray-400">Total: {totals.total}</span>
            <span className="text-green-400">Passed: {totals.passed}</span>
            <span className="text-red-400">Failed: {totals.failed}</span>
            <span className="text-yellow-400">Blocked: {totals.blocked}</span>
            {totals.needsInput > 0 && <span className="text-yellow-300">Needs input: {totals.needsInput}</span>}
            {totals.running > 0 && <span className="text-blue-400">Running: {totals.running}</span>}
          </div>
          <div className="space-y-2">
            {runs.map((p) => {
              const d = runData[p.run_id];
              const status = d?.status ?? 'running';
              const meta = metaRef.current[p.plan_id];
              const icon = status === 'completed' ? <CheckCircle size={14} className="text-green-400" />
                : status === 'failed' ? <XCircle size={14} className="text-red-400" />
                : status === 'blocked' ? <MinusCircle size={14} className="text-yellow-400" />
                : status.startsWith('paused') ? <MessageSquare size={14} className="text-yellow-300" />
                : <Loader2 size={14} className="text-blue-400 animate-spin" />;
              const dur = d ? runDurationSeconds(d.started_at, d.completed_at) : null;
              return (
                <div key={p.run_id} className="flex items-center justify-between py-2 px-3 bg-gray-800 rounded text-sm">
                  <div className="flex items-center gap-3">
                    {icon}
                    <span className="text-gray-300">{meta?.piece}</span>
                    <span className="text-gray-500">{meta?.target}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {dur != null && <span>{dur}s</span>}
                    <span>#{p.run_id}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

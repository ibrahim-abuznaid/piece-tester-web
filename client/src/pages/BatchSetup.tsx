import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type AgentLogEntry, type BatchStatus, type BatchQueueItemStatus } from '../lib/api';
import {
  Play, Loader2, Search, CheckCircle, XCircle, SkipForward,
  ChevronDown, ChevronRight, StopCircle, Brain, Puzzle,
  Clock, AlertTriangle, ListChecks, RefreshCw,
} from 'lucide-react';

type ItemStatus = BatchQueueItemStatus['status'];

const STATUS_BADGE: Record<ItemStatus, { icon: JSX.Element; label: string; cls: string }> = {
  pending:  { icon: <Clock size={12} />,        label: 'Pending',  cls: 'text-gray-400 bg-gray-800' },
  running:  { icon: <Loader2 size={12} className="animate-spin" />, label: 'Running',  cls: 'text-blue-300 bg-blue-500/20' },
  done:     { icon: <CheckCircle size={12} />,   label: 'Done',     cls: 'text-green-300 bg-green-500/20' },
  error:    { icon: <XCircle size={12} />,       label: 'Error',    cls: 'text-red-300 bg-red-500/20' },
  skipped:  { icon: <SkipForward size={12} />,   label: 'Skipped',  cls: 'text-yellow-300 bg-yellow-500/20' },
};

export default function BatchSetup() {
  const navigate = useNavigate();
  const { data: pieces, isLoading: loadingPieces } = useQuery({ queryKey: ['pieces'], queryFn: api.listPieces });
  const { data: connections } = useQuery({ queryKey: ['connections'], queryFn: api.listConnections });
  const { data: allPlans } = useQuery({ queryKey: ['testPlans'], queryFn: () => api.listTestPlans() });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  // Batch state
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [batchItems, setBatchItems] = useState<(BatchQueueItemStatus & { index: number })[]>([]);
  const [batchLogs, setBatchLogs] = useState<Record<number, AgentLogEntry[]>>({});
  const [expandedPiece, setExpandedPiece] = useState<string | null>(null);
  const [expandedItemLog, setExpandedItemLog] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subControllerRef = useRef<AbortController | null>(null);

  const connectedPieces = new Set(connections?.map((c: any) => c.piece_name) ?? []);
  const plansByAction = new Map<string, boolean>();
  allPlans?.forEach((p: any) => plansByAction.set(`${p.piece_name}/${p.target_action}`, true));

  // Check for existing batch on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await api.getBatchStatus();
        if (cancelled) return;
        if (status) {
          setBatchStatus(status);
          const items = status.items.map((it, i) => ({ ...it, index: i }));
          setBatchItems(items);

          if (status.status === 'running') {
            subscribeToExistingBatch();
          }
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const subscribeToExistingBatch = useCallback(() => {
    subControllerRef.current?.abort();
    const controller = api.subscribeBatchSetup({
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
        refreshStatus();
      },
      onError: (msg) => setError(msg),
    });
    subControllerRef.current = controller;
  }, []);

  useEffect(() => {
    return () => { subControllerRef.current?.abort(); };
  }, []);

  async function refreshStatus() {
    try {
      const status = await api.getBatchStatus();
      if (status) {
        setBatchStatus(status);
        setBatchItems(status.items.map((it, i) => ({ ...it, index: i })));
      }
    } catch {}
  }

  function togglePiece(pieceName: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(pieceName)) next.delete(pieceName);
      else next.add(pieceName);
      return next;
    });
  }

  function selectAll() {
    const available = getConnectedPieces();
    setSelected(new Set(available.map((p: any) => p.name)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  function getConnectedPieces() {
    return (pieces || []).filter((p: any) => connectedPieces.has(p.name));
  }

  async function handleStart() {
    if (selected.size === 0) return;
    setStarting(true);
    setError(null);
    setBatchLogs({});
    try {
      const result = await api.startBatchSetup(Array.from(selected));
      const status = await api.getBatchStatus();
      if (status) {
        setBatchStatus(status);
        setBatchItems(status.items.map((it, i) => ({ ...it, index: i })));
      }
      subscribeToExistingBatch();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel() {
    try {
      await api.cancelBatchSetup();
      setTimeout(refreshStatus, 1000);
    } catch (err: any) {
      setError(err.message);
    }
  }

  function handleNewBatch() {
    setBatchStatus(null);
    setBatchItems([]);
    setBatchLogs({});
    setError(null);
  }

  const isRunning = batchStatus?.status === 'running';

  // Group items by piece for display
  const groupedItems = batchItems.reduce<Record<string, (BatchQueueItemStatus & { index: number })[]>>((acc, item) => {
    if (!acc[item.pieceName]) acc[item.pieceName] = [];
    acc[item.pieceName].push(item);
    return acc;
  }, {});

  const connectedList = getConnectedPieces();
  const filtered = connectedList.filter((p: any) =>
    p.displayName.toLowerCase().includes(search.toLowerCase()) ||
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  // Stats
  const stats = batchItems.reduce(
    (a, it) => { a[it.status] = (a[it.status] || 0) + 1; return a; },
    {} as Record<string, number>,
  );

  if (loadingPieces) return <div className="text-gray-400">Loading pieces...</div>;

  // ─── Active batch view ───
  if (batchStatus) {
    return (
      <div>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <ListChecks size={24} /> Batch Plan Setup
            </h2>
            <p className="text-gray-400 text-sm mt-1">
              {isRunning ? 'Creating plans sequentially...' : `Batch ${batchStatus.status}`}
              {' '}— {batchItems.length} actions total
            </p>
          </div>
          <div className="flex gap-2">
            {isRunning && (
              <button onClick={handleCancel} className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition-colors">
                <StopCircle size={16} /> Cancel
              </button>
            )}
            {!isRunning && (
              <button onClick={handleNewBatch} className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg text-sm font-medium transition-colors">
                <RefreshCw size={16} /> New Batch
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 text-sm text-red-300 flex items-center gap-2">
            <AlertTriangle size={14} /> {error}
          </div>
        )}

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
                    <span className="text-gray-500">{pieceTotal} actions</span>
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
                        <div key={item.actionName} className="border-b border-gray-800/50 last:border-0">
                          <div
                            className="flex items-center justify-between px-6 py-2.5 hover:bg-gray-800/30 cursor-pointer"
                            onClick={() => setExpandedItemLog(isLogExpanded ? null : item.index)}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${badge.cls}`}>
                                {badge.icon} {badge.label}
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

  // ─── Selection view ───
  return (
    <div>
      <h2 className="text-2xl font-bold mb-2 flex items-center gap-2">
        <ListChecks size={24} /> Batch Plan Setup
      </h2>
      <p className="text-gray-400 text-sm mb-6">
        Select pieces to create AI test plans for all their actions. Plans are created one at a time to avoid API limits.
        Only pieces with an active connection are shown.
      </p>

      {connectedList.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
          <Puzzle size={40} className="mx-auto text-gray-600 mb-3" />
          <p className="text-gray-400 mb-2">No connected pieces found.</p>
          <p className="text-gray-500 text-sm">Go to <button onClick={() => navigate('/pieces')} className="text-primary-400 hover:underline">Pieces</button> and connect at least one piece first.</p>
        </div>
      ) : (
        <>
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 text-sm text-red-300 flex items-center gap-2">
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          <div className="flex items-center gap-3 mb-4">
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

          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800 mb-6 max-h-[500px] overflow-y-auto">
            {filtered.map((piece: any) => {
              const isSelected = selected.has(piece.name);
              const actionCount = typeof piece.actions === 'number' ? piece.actions : Object.keys(piece.actions || {}).length;
              const existingPlanCount = allPlans?.filter((p: any) => p.piece_name === piece.name).length || 0;
              const newActions = Math.max(0, actionCount - existingPlanCount);

              return (
                <label
                  key={piece.name}
                  className={`flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-gray-800/50 transition-colors ${isSelected ? 'bg-primary-600/10' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => togglePiece(piece.name)}
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
                    <div className="text-xs text-gray-500">{actionCount} action{actionCount !== 1 ? 's' : ''}</div>
                  </div>
                  <div className="text-xs text-right shrink-0">
                    {existingPlanCount > 0 && (
                      <span className="text-green-400">{existingPlanCount} plans exist</span>
                    )}
                    {newActions > 0 && (
                      <span className={`${existingPlanCount > 0 ? 'ml-2' : ''} text-gray-400`}>{newActions} new</span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>

          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-400">
              {selected.size} piece{selected.size !== 1 ? 's' : ''} selected
              {selected.size > 0 && (() => {
                const totalActions = Array.from(selected).reduce((sum, pName) => {
                  const p = pieces?.find((pp: any) => pp.name === pName);
                  const count = typeof p?.actions === 'number' ? p.actions : Object.keys(p?.actions || {}).length;
                  return sum + count;
                }, 0);
                const existingPlanCount = Array.from(selected).reduce((sum, pName) => {
                  return sum + (allPlans?.filter((p: any) => p.piece_name === pName).length || 0);
                }, 0);
                const newCount = totalActions - existingPlanCount;
                return <span> — {newCount} new plan{newCount !== 1 ? 's' : ''} to create ({existingPlanCount} will be skipped)</span>;
              })()}
            </div>
            <button
              onClick={handleStart}
              disabled={selected.size === 0 || starting}
              className="flex items-center gap-2 px-6 py-2.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
            >
              {starting ? <Loader2 size={16} className="animate-spin" /> : <Brain size={16} />}
              Start Batch Setup
            </button>
          </div>
        </>
      )}
    </div>
  );
}

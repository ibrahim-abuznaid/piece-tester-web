import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import TestResultBadge from '../components/TestResultBadge';
import { Play, Loader2, RotateCcw } from 'lucide-react';

export default function TestRunner() {
  const { data: connections } = useQuery({ queryKey: ['connections'], queryFn: api.listConnections });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runId, setRunId] = useState<number | null>(null);
  const [runData, setRunData] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  function togglePiece(name: string) {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name); else next.add(name);
    setSelected(next);
  }

  function selectAll() {
    if (!connections) return;
    setSelected(new Set(connections.map((c: any) => c.piece_name)));
  }

  async function handleRun(pieceNames?: string[]) {
    setRunning(true);
    setRunData(null);
    try {
      const { runId: id } = await api.runTests(pieceNames);
      setRunId(id);
      startPolling(id);
    } catch (err: any) {
      setRunData({ status: 'failed', error: err.message });
      setRunning(false);
    }
  }

  function startPolling(id: number) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const data = await api.getTestStatus(id);
        setRunData(data);
        if (data.status !== 'running') {
          clearInterval(pollRef.current);
          setRunning(false);
        }
      } catch { /* keep polling */ }
    }, 1500);
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Test Runner</h2>

      {/* Piece selection */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-gray-400">Select pieces to test:</p>
          <button onClick={selectAll} className="text-xs text-primary-400 hover:text-primary-300">Select All</button>
        </div>
        {!connections?.length ? (
          <p className="text-sm text-gray-500">No connections configured. Go to Connections page first.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {connections.map((c: any) => (
              <label key={c.piece_name} className={`flex items-center gap-2 px-3 py-1.5 rounded border text-sm cursor-pointer transition-colors ${selected.has(c.piece_name) ? 'border-primary-500 bg-primary-600/10 text-primary-300' : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'}`}>
                <input type="checkbox" className="hidden" checked={selected.has(c.piece_name)} onChange={() => togglePiece(c.piece_name)} />
                {c.display_name}
              </label>
            ))}
          </div>
        )}

        <div className="flex gap-3 mt-4">
          <button onClick={() => handleRun(selected.size > 0 ? [...selected] : undefined)} disabled={running || !connections?.length}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-sm font-medium disabled:opacity-50">
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            {selected.size > 0 ? `Run Selected (${selected.size})` : 'Run All'}
          </button>
        </div>
      </div>

      {/* Results */}
      {runData && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h3 className="font-semibold">Run #{runId}</h3>
              <TestResultBadge status={runData.status} />
            </div>
            {runData.status === 'running' && <Loader2 size={18} className="animate-spin text-blue-400" />}
          </div>

          {/* Summary */}
          <div className="flex gap-4 mb-4 text-sm">
            <span className="text-gray-400">Total: {runData.total_tests ?? 0}</span>
            <span className="text-green-400">Passed: {runData.passed ?? 0}</span>
            <span className="text-red-400">Failed: {runData.failed ?? 0}</span>
            <span className="text-orange-400">Errors: {runData.errors ?? 0}</span>
          </div>

          {/* Individual results */}
          {runData.results?.length > 0 && (
            <div className="space-y-2">
              {runData.results.map((r: any, i: number) => (
                <div key={i} className="flex items-center justify-between py-2 px-3 bg-gray-800 rounded text-sm">
                  <div className="flex items-center gap-3">
                    <TestResultBadge status={r.status} />
                    <span className="text-gray-300">{r.piece_name}</span>
                    <span className="text-gray-500">{r.action_name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {r.duration_ms > 0 && <span>{(r.duration_ms / 1000).toFixed(1)}s</span>}
                    {r.error_message && <span className="text-red-400 max-w-xs truncate" title={r.error_message}>{r.error_message}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {runData.error && <p className="text-red-400 text-sm mt-2">{runData.error}</p>}
        </div>
      )}
    </div>
  );
}

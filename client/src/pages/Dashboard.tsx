import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useNavigate } from 'react-router-dom';
import TestResultBadge from '../components/TestResultBadge';
import { Puzzle, Link2, Play, TrendingUp } from 'lucide-react';

export default function Dashboard() {
  const navigate = useNavigate();
  const { data: connections } = useQuery({ queryKey: ['connections'], queryFn: api.listConnections });
  const { data: runs } = useQuery({ queryKey: ['history'], queryFn: () => api.listHistory(5) });

  const connCount = connections?.length ?? 0;
  const lastRun = runs?.[0];
  const passRate = lastRun && lastRun.total_tests > 0
    ? Math.round((lastRun.passed / lastRun.total_tests) * 100)
    : null;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard icon={Link2} label="Connected Pieces" value={connCount} color="text-primary-400" />
        <StatCard icon={Play} label="Total Runs" value={runs?.length ?? 0} color="text-blue-400" />
        <StatCard icon={TrendingUp} label="Last Pass Rate" value={passRate !== null ? `${passRate}%` : '-'} color={passRate !== null && passRate >= 80 ? 'text-green-400' : 'text-yellow-400'} />
        <StatCard icon={Puzzle} label="Last Run" value={lastRun ? formatDate(lastRun.started_at) : 'Never'} color="text-gray-400" small />
      </div>

      {/* Quick actions */}
      <div className="flex gap-3 mb-8">
        <button onClick={() => navigate('/test-runner')} className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-sm font-medium">
          <Play size={16} /> Run Tests
        </button>
        <button onClick={() => navigate('/connections')} className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm">
          <Link2 size={16} /> Manage Connections
        </button>
      </div>

      {/* Recent runs */}
      <h3 className="text-lg font-semibold mb-3">Recent Runs</h3>
      {!runs?.length ? (
        <p className="text-gray-500 text-sm">No test runs yet.</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400">
                <th className="text-left px-4 py-2 font-medium">Run</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Type</th>
                <th className="text-right px-4 py-2 font-medium">Passed</th>
                <th className="text-right px-4 py-2 font-medium">Failed</th>
                <th className="text-right px-4 py-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run: any) => (
                <tr key={run.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer" onClick={() => navigate('/history')}>
                  <td className="px-4 py-2.5">#{run.id}</td>
                  <td className="px-4 py-2.5"><TestResultBadge status={run.status} /></td>
                  <td className="px-4 py-2.5 text-gray-400">{run.trigger_type}</td>
                  <td className="px-4 py-2.5 text-right text-green-400">{run.passed}</td>
                  <td className="px-4 py-2.5 text-right text-red-400">{run.failed + run.errors}</td>
                  <td className="px-4 py-2.5 text-right text-gray-500">{formatDate(run.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color, small }: { icon: any; label: string; value: string | number; color: string; small?: boolean }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className={color} />
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <p className={`font-bold ${small ? 'text-sm' : 'text-2xl'} ${color}`}>{value}</p>
    </div>
  );
}

function formatDate(iso: string) {
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}

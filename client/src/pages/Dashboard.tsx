import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import HealthBoard from '../components/HealthBoard';
import { CalendarClock, BarChart3, AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';

// Treat naive-UTC timestamps ("2026-06-22 08:48:37") as UTC; ISO strings pass through.
function parseTs(s?: string | null): number {
  if (!s) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}
function formatRelative(s?: string | null): string {
  const t = parseTs(s);
  if (!Number.isFinite(t)) return '—';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function Dashboard() {
  const { data: health } = useQuery({
    queryKey: ['piece-health'],
    queryFn: api.getPieceHealth,
    refetchInterval: 30_000,
  });

  const rows = health ?? [];
  const stats = useMemo(() => {
    const failing = rows.filter(r => r.status === 'failing').length;
    const healthy = rows.filter(r => r.status === 'healthy').length;
    const lastWave = rows.reduce<string | null>((max, r) =>
      r.last_run_at && (!max || r.last_run_at > max) ? r.last_run_at : max, null);
    return { tracked: rows.length, failing, healthy, lastWave };
  }, [rows]);

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
          Current status of every tracked piece — grouped by what needs to happen next.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard label="Pieces tracked" value={stats.tracked} tone="neutral" />
        <StatCard label="Failing now" value={stats.failing} tone={stats.failing > 0 ? 'bad' : 'good'} />
        <StatCard label="Healthy" value={stats.healthy} tone="good" />
        <StatCard label="Last wave" value={formatRelative(stats.lastWave)} tone="neutral" small />
      </div>

      <HealthBoard />
    </div>
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

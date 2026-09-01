import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  PieChart, Pie, Cell, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { api } from '../lib/api';
import {
  TrendingUp, TrendingDown, Loader2, Calendar,
  Download, Link2, CheckCircle,
} from 'lucide-react';

// ══════════════════════════════════════════════════════════════
//  Shared constants & helpers
// ══════════════════════════════════════════════════════════════

type TimeRange = 'day' | 'week' | 'month' | 'year' | 'custom' | 'all';

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: 'day', label: 'Last 24h' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'year', label: 'Last year' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

const CHANGED_LANES: Record<string, { label: string; color: string }> = {
  newly_broken: { label: 'newly broke', color: 'text-red-400' },
  degrading: { label: 'degrading', color: 'text-orange-400' },
  flaky: { label: 'flaky', color: 'text-yellow-400' },
  recovered: { label: 'recovered', color: 'text-green-400' },
};

const CATEGORY_META: Record<string, { label: string; color: string }> = {
  auth: { label: 'Auth / 401', color: '#f87171' },
  timeout: { label: 'Timeout', color: '#60a5fa' },
  no_trigger: { label: 'No trigger', color: '#fbbf24' },
  rate_limit: { label: 'Rate limit', color: '#a78bfa' },
  not_found: { label: 'Not found', color: '#fb923c' },
  server_error: { label: 'Server 5xx', color: '#f472b6' },
  other: { label: 'Other', color: '#6b7280' },
};

const TOOLTIP_STYLE = { background: '#0e131b', border: '1px solid #2a2f3a', borderRadius: 6, fontSize: 11, color: '#e5e7eb' };
const shortName = (p: string) => (p || '').replace('@activepieces/piece-', '');
const rateColorHex = (r: number) => (r >= 80 ? '#4ade80' : r >= 50 ? '#fbbf24' : '#f87171');

function computeDateBounds(range: TimeRange, customFrom: string, customTo: string): { dateFrom?: string; dateTo?: string } {
  const now = new Date();
  const dateTo = now.toISOString();
  switch (range) {
    case 'day': { const d = new Date(now); d.setDate(d.getDate() - 1); return { dateFrom: d.toISOString(), dateTo }; }
    case 'week': { const d = new Date(now); d.setDate(d.getDate() - 7); return { dateFrom: d.toISOString(), dateTo }; }
    case 'month': { const d = new Date(now); d.setMonth(d.getMonth() - 1); return { dateFrom: d.toISOString(), dateTo }; }
    case 'year': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return { dateFrom: d.toISOString(), dateTo }; }
    case 'custom':
      return {
        dateFrom: customFrom ? new Date(customFrom).toISOString() : undefined,
        dateTo: customTo ? new Date(customTo + 'T23:59:59').toISOString() : undefined,
      };
    default: return {};
  }
}

// ══════════════════════════════════════════════════════════════
//  Page root
// ══════════════════════════════════════════════════════════════

export default function Reports() {
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [copied, setCopied] = useState(false);
  const { dateFrom, dateTo } = computeDateBounds(timeRange, customFrom, customTo);

  const { data: summary, isLoading } = useQuery({ queryKey: ['report-summary', dateFrom, dateTo], queryFn: () => api.getPerformanceSummary(dateFrom, dateTo) });
  const { data: stats } = useQuery({ queryKey: ['report-stats', dateFrom, dateTo], queryFn: () => api.getReportStats(dateFrom, dateTo) });
  const { data: regressions = [] } = useQuery({ queryKey: ['report-regressions'], queryFn: api.getReportRegressions });
  const { data: trends = [] } = useQuery({ queryKey: ['report-trends', dateFrom, dateTo], queryFn: () => api.getReportTrends(dateFrom, dateTo) });
  const { data: breakdown = [] } = useQuery({ queryKey: ['report-failure-breakdown'], queryFn: api.getFailureBreakdown });
  const { data: coverageRows } = useQuery({ queryKey: ['report-coverage'], queryFn: api.getCoverage, staleTime: 5 * 60 * 1000, retry: false });
  const coverage = coverageRows ? { covered: coverageRows.filter((r: any) => r.covered).length, total: coverageRows.length } : null;

  const copyLink = () => navigator.clipboard?.writeText(window.location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });

  return (
    <div>
      <div className="flex items-start justify-between mb-4 gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Piece Performance</h2>
          <p className="text-sm text-gray-500 mt-1">Analytics across scheduled runs — outcomes, trends, latency & failures.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => window.print()} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300"><Download size={13} /> Export PDF</button>
          <button onClick={copyLink} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300"><Link2 size={13} /> {copied ? 'Copied!' : 'Copy link'}</button>
        </div>
      </div>

      <PeriodSelector {...{ timeRange, setTimeRange, customFrom, setCustomFrom, customTo, setCustomTo }} />

      {isLoading || !summary ? (
        <LoadingState message="Loading analytics..." />
      ) : (
        <div className="space-y-4 mt-4">
          <KpiStrip summary={summary} stats={stats} coverage={coverage} />
          <HighlightsStrip regressions={regressions} />
          <ChartGrid {...{ summary, stats, regressions, trends, breakdown, coverage }} />
        </div>
      )}
    </div>
  );
}

function PeriodSelector({ timeRange, setTimeRange, customFrom, setCustomFrom, customTo, setCustomTo }: any) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
        {TIME_RANGE_OPTIONS.map(opt => (
          <button key={opt.value} onClick={() => setTimeRange(opt.value)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${timeRange === opt.value ? 'bg-primary-600/30 text-primary-300' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}>
            {opt.label}
          </button>
        ))}
      </div>
      {timeRange === 'custom' && (
        <div className="flex items-center gap-2">
          <Calendar size={12} className="text-gray-500" />
          <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300" />
          <span className="text-gray-600 text-xs">to</span>
          <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300" />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  KPI strip + highlights
// ══════════════════════════════════════════════════════════════

function KpiStrip({ summary, stats, coverage }: { summary: any; stats: any; coverage: any }) {
  const rate = summary.success_rate as number;
  const delta = summary.delta_pts as number | null;
  const status = rate >= 80 ? 'Healthy' : rate >= 50 ? 'Needs attention' : 'Critical';
  const runs = stats ? stats.passed_plan_runs + stats.failed_plan_runs + (stats.blocked_plan_runs || 0) : summary.tested_pieces;
  return (
    <div className="flex flex-wrap gap-3">
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-extrabold" style={{ color: rateColorHex(rate) }}>{rate}%</span>
          {delta !== null && delta !== 0 && (
            <span className={`text-[11px] flex items-center gap-0.5 ${delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
              {delta > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}{delta > 0 ? '+' : ''}{delta}
            </span>
          )}
        </div>
        <div className="text-[10px] text-gray-500">{status} · pass rate</div>
      </div>
      <Kpi value={runs} label="runs" />
      <Kpi value={summary.tested_pieces} label="pieces tested" />
      {summary.blocked > 0 && <Kpi value={summary.blocked} label="blocked" tone="warn" />}
      <Kpi value={summary.p95_ms > 0 ? `${(summary.p95_ms / 1000).toFixed(1)}s` : '—'} label="p95 latency" />
      <Link to="/schedules"><Kpi value={coverage ? `${coverage.covered} / ${coverage.total}` : '…'} label="coverage →" /></Link>
    </div>
  );
}

function Kpi({ value, label, tone }: { value: any; label: string; tone?: 'warn' }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
      <div className={`text-2xl font-bold ${tone === 'warn' ? 'text-yellow-400' : 'text-gray-200'}`}>{value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}

function HighlightsStrip({ regressions }: { regressions: any[] }) {
  const changed = regressions.filter(r => CHANGED_LANES[r.lane]);
  return (
    <div className="flex items-start gap-2 text-sm bg-gray-900/50 border border-gray-800 rounded-lg px-3 py-2">
      <CheckCircle size={15} className="text-green-400 mt-0.5 shrink-0" />
      {changed.length === 0 ? (
        <span className="text-gray-400">No changes this period — all pieces steady.</span>
      ) : (
        <span className="text-gray-300 flex flex-wrap gap-x-2 gap-y-1">
          <span className="text-gray-500">What changed:</span>
          {changed.map((r, i) => (
            <span key={r.piece_name}>
              <Link to={`/pieces/${encodeURIComponent(r.piece_name)}`} className="hover:underline">
                <span className="font-medium text-gray-200">{shortName(r.piece_name)}</span>{' '}
                <span className={CHANGED_LANES[r.lane].color}>{CHANGED_LANES[r.lane].label}</span>
              </Link>{i < changed.length - 1 ? ' ·' : ''}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Chart grid
// ══════════════════════════════════════════════════════════════

function ChartGrid({ summary, stats, regressions, trends, breakdown, coverage }: any) {
  const outcomes = useMemo(() => [
    { name: 'Passed', value: stats?.passed_plan_runs || 0, fill: '#4ade80' },
    { name: 'Failed', value: stats?.failed_plan_runs || 0, fill: '#f87171' },
    { name: 'Blocked', value: stats?.blocked_plan_runs || 0, fill: '#6b7280' },
  ], [stats]);
  // Pass rate matches the KPI: passed ÷ decided (blocked excluded), not ÷ all runs.
  const decided = (stats?.passed_plan_runs || 0) + (stats?.failed_plan_runs || 0);
  const passRate = decided > 0 ? Math.round(((stats?.passed_plan_runs || 0) / decided) * 100) : 0;

  const health = useMemo(() => {
    const healthy = regressions.filter((r: any) => r.overallRate >= 80).length;
    const needs = regressions.filter((r: any) => r.overallRate >= 50 && r.overallRate < 80).length;
    const critical = regressions.filter((r: any) => r.overallRate < 50).length;
    return [
      { name: 'Healthy', value: healthy, fill: '#4ade80' },
      { name: 'Needs attention', value: needs, fill: '#fbbf24' },
      { name: 'Critical', value: critical, fill: '#f87171' },
    ];
  }, [regressions]);

  const fail = useMemo(() => breakdown.map((b: any) => ({
    name: CATEGORY_META[b.category]?.label || b.category, value: b.count, fill: CATEGORY_META[b.category]?.color || '#6b7280',
  })), [breakdown]);
  const totalFails = fail.reduce((a: number, d: any) => a + d.value, 0);

  const trendData = useMemo(() => trends.map((t: any) => ({
    date: t.date?.slice(5), rate: (t.passed + t.failed) > 0 ? Math.round((t.passed / (t.passed + t.failed)) * 100) : 0,
  })), [trends]);
  const volumeData = useMemo(() => trends.map((t: any) => ({ date: t.date?.slice(5), passed: t.passed, failed: t.failed })), [trends]);

  const topFailures = useMemo(() => [...regressions].filter((r: any) => r.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 8)
    .map((r: any) => ({ name: shortName(r.piece_name), value: r.failed, fill: '#f87171' })), [regressions]);
  const slowest = useMemo(() => [...regressions].filter((r: any) => r.p95Ms > 0).sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 8)
    .map((r: any) => ({ name: shortName(r.piece_name), value: +(r.p95Ms / 1000).toFixed(1), fill: '#60a5fa' })), [regressions]);
  const reliability = useMemo(() => [...regressions].sort((a, b) => b.overallRate - a.overallRate).slice(0, 8)
    .map((r: any) => ({ name: shortName(r.piece_name), value: r.overallRate, fill: rateColorHex(r.overallRate) })), [regressions]);

  const coverageData = coverage ? [
    { name: 'Under test', value: coverage.covered, fill: '#60a5fa' },
    { name: 'Untested', value: Math.max(0, coverage.total - coverage.covered), fill: '#222a37' },
  ] : [];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <ChartCard title="Run outcomes">
        <Donut data={outcomes} center={`${passRate}%`} sub="pass" />
        <Legend data={outcomes} />
      </ChartCard>

      <ChartCard title="Piece health">
        <Donut data={health} center={`${regressions.length}`} sub="pieces" />
        <Legend data={health} />
      </ChartCard>

      <ChartCard title="Why tests fail">
        {totalFails === 0 ? <NoData msg="No failures 🎉" /> : <><Donut data={fail} center={`${totalFails}`} sub="failures" /><Legend data={fail} /></>}
      </ChartCard>

      <ChartCard title="Pass rate over time" wide>
        {trendData.length < 2 ? <NoData msg="Not enough data to trend" /> : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={trendData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#4ade80" stopOpacity={0.4} /><stop offset="100%" stopColor="#4ade80" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} minTickGap={20} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} width={30} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [`${v}%`, 'pass rate']} />
              <Area type="monotone" dataKey="rate" stroke="#4ade80" strokeWidth={2} fill="url(#g)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Runs per day">
        {volumeData.length < 1 ? <NoData msg="No runs" /> : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={volumeData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} minTickGap={20} />
              <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} width={30} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="passed" stackId="a" fill="#4ade80" radius={[0, 0, 0, 0]} />
              <Bar dataKey="failed" stackId="a" fill="#f87171" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Most failures by piece">
        {topFailures.length === 0 ? <NoData msg="No failures 🎉" /> : <RankedBars data={topFailures} />}
      </ChartCard>

      <ChartCard title="Slowest pieces (p95)">
        {slowest.length === 0 ? <NoData msg="No latency data" /> : <RankedBars data={slowest} suffix="s" />}
      </ChartCard>

      <ChartCard title="Reliability by piece">
        {reliability.length === 0 ? <NoData msg="No data" /> : <RankedBars data={reliability} suffix="%" />}
      </ChartCard>

      <ChartCard title="Catalog coverage">
        {!coverage ? <NoData msg="Loading…" /> : <><Donut data={coverageData} center={`${coverage.covered}`} sub={`of ${coverage.total}`} /><Legend data={coverageData} /></>}
      </ChartCard>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Chart primitives
// ══════════════════════════════════════════════════════════════

function ChartCard({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-lg p-4 ${wide ? 'md:col-span-2' : ''}`}>
      <h3 className="text-[11px] uppercase tracking-wider text-gray-500 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Donut({ data, center, sub }: { data: { name: string; value: number; fill: string }[]; center: string; sub?: string }) {
  const shown = data.filter(d => d.value > 0);
  return (
    <div className="relative" style={{ height: 160 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={shown} dataKey="value" nameKey="name" innerRadius={48} outerRadius={68} paddingAngle={2} stroke="none">
            {shown.map((d, i) => <Cell key={i} fill={d.fill} />)}
          </Pie>
          <Tooltip contentStyle={TOOLTIP_STYLE} />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-2xl font-bold text-gray-200">{center}</span>
        {sub && <span className="text-[10px] text-gray-500">{sub}</span>}
      </div>
    </div>
  );
}

function Legend({ data }: { data: { name: string; value: number; fill: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 justify-center">
      {data.map(d => (
        <div key={d.name} className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: d.fill }} />
          {d.name} <span className="text-gray-500 tabular-nums">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function RankedBars({ data, suffix = '' }: { data: { name: string; value: number; fill: string }[]; suffix?: string }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div className="flex flex-col gap-2 py-1">
      {data.map(d => (
        <div key={d.name} className="flex items-center gap-2 text-[11px]">
          <span className="w-20 text-right text-gray-400 font-mono text-[10px] truncate" title={d.name}>{d.name}</span>
          <span className="flex-1 bg-gray-800 rounded h-3 overflow-hidden">
            <span className="block h-full rounded" style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, background: d.fill }} />
          </span>
          <span className="w-11 text-gray-400 tabular-nums text-right">{d.value}{suffix}</span>
        </div>
      ))}
    </div>
  );
}

function NoData({ msg }: { msg: string }) {
  return <div className="flex items-center justify-center text-sm text-gray-600" style={{ height: 160 }}>{msg}</div>;
}

function LoadingState({ message }: { message: string }) {
  return <div className="flex items-center gap-3 text-gray-400 py-8"><Loader2 size={16} className="animate-spin" />{message}</div>;
}

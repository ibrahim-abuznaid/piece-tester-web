import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  BarChart3, TrendingUp, TrendingDown, AlertTriangle, CheckCircle,
  XCircle, Bug, Wrench, Zap, HelpCircle, Brain, Loader2,
  ChevronDown, ChevronRight, Clock, Shield, Activity, Target,
  Calendar, Eye, CircleCheck, Undo2, MessageSquare, Play, RotateCcw,
} from 'lucide-react';

// ══════════════════════════════════════════════════════════════
//  Shared types & constants
// ══════════════════════════════════════════════════════════════

type TabId = 'overview' | 'pieces' | 'failures' | 'ai-analysis';
type TimeRange = 'day' | 'week' | 'month' | 'year' | 'custom' | 'all';

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: 'day', label: 'Last 24h' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'year', label: 'Last year' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

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

function rangeLabel(a: any): string {
  const opt = TIME_RANGE_OPTIONS.find(o => o.value === a.time_range);
  if (a.time_range === 'custom' && a.date_from) {
    const from = new Date(a.date_from).toLocaleDateString();
    const to = a.date_to ? new Date(a.date_to).toLocaleDateString() : 'now';
    return `${from} – ${to}`;
  }
  return opt?.label || a.time_range || 'All time';
}

// ══════════════════════════════════════════════════════════════
//  Page Root
// ══════════════════════════════════════════════════════════════

export default function Reports() {
  const [tab, setTab] = useState<TabId>('overview');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const { dateFrom, dateTo } = computeDateBounds(timeRange, customFrom, customTo);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Reports</h2>
          <p className="text-sm text-gray-500 mt-1">Scheduled run analytics and AI-powered failure analysis</p>
        </div>
      </div>

      {/* Global time range selector */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
          {TIME_RANGE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setTimeRange(opt.value)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                timeRange === opt.value
                  ? 'bg-primary-600/30 text-primary-300'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {timeRange === 'custom' && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Calendar size={12} className="text-gray-500" />
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
              />
            </div>
            <span className="text-gray-600 text-xs">to</span>
            <input
              type="date"
              value={customTo}
              onChange={e => setCustomTo(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
            />
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-gray-800 pb-1">
        {([
          { id: 'overview' as TabId, label: 'Overview', icon: BarChart3 },
          { id: 'pieces' as TabId, label: 'Piece Health', icon: Target },
          { id: 'failures' as TabId, label: 'Failures', icon: XCircle },
          { id: 'ai-analysis' as TabId, label: 'AI Analysis', icon: Brain },
        ]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm rounded-t transition-colors ${
              tab === t.id
                ? 'bg-gray-800 text-white border-b-2 border-primary-400'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
            }`}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'pieces' && <PieceHealthTab dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'failures' && <FailuresTab dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'ai-analysis' && <AiAnalysisTab timeRange={timeRange} customFrom={customFrom} customTo={customTo} dateFrom={dateFrom} dateTo={dateTo} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Overview Tab
// ══════════════════════════════════════════════════════════════

function OverviewTab({ dateFrom, dateTo }: { dateFrom?: string; dateTo?: string }) {
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['report-stats', dateFrom, dateTo],
    queryFn: () => api.getReportStats(dateFrom, dateTo),
  });
  const { data: trends } = useQuery({
    queryKey: ['report-trends', dateFrom, dateTo],
    queryFn: () => api.getReportTrends(dateFrom, dateTo),
  });
  const { data: pieceBreakdown } = useQuery({
    queryKey: ['report-piece-breakdown', dateFrom, dateTo],
    queryFn: () => api.getReportPieceBreakdown(dateFrom, dateTo),
  });

  if (statsLoading) return <LoadingState message="Loading report data..." />;
  if (!stats) return <EmptyState message="No scheduled runs yet. Configure a schedule to start seeing reports." />;

  const totalFinished = stats.total_plan_runs - stats.running_plan_runs;

  return (
    <div className="space-y-6">
      <HealthScoreBanner successRate={stats.success_rate} totalRuns={totalFinished} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={Activity} label="Total Plan Runs" value={stats.total_plan_runs} color="text-primary-400" />
        <StatCard icon={CheckCircle} label="Passed" value={stats.passed_plan_runs} color="text-green-400"
          subtitle={totalFinished > 0 ? `${Math.round((stats.passed_plan_runs / totalFinished) * 100)}%` : undefined} />
        <StatCard icon={XCircle} label="Failed" value={stats.failed_plan_runs} color="text-red-400"
          subtitle={totalFinished > 0 ? `${Math.round((stats.failed_plan_runs / totalFinished) * 100)}%` : undefined} />
        <StatCard icon={Clock} label="Avg Duration"
          value={stats.avg_plan_duration_ms > 0 ? `${(stats.avg_plan_duration_ms / 1000).toFixed(1)}s` : '-'} color="text-yellow-400" />
      </div>

      {trends && trends.length > 1 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Run Trend</h3>
          <TrendChart data={trends} />
        </div>
      )}

      {pieceBreakdown && pieceBreakdown.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Piece Ranking</h3>
          <TopPiecesTable breakdown={pieceBreakdown.slice(0, 10)} />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Piece Health Tab
// ══════════════════════════════════════════════════════════════

function PieceHealthTab({ dateFrom, dateTo }: { dateFrom?: string; dateTo?: string }) {
  const { data: breakdown, isLoading } = useQuery({
    queryKey: ['report-piece-breakdown', dateFrom, dateTo],
    queryFn: () => api.getReportPieceBreakdown(dateFrom, dateTo),
  });
  const [sortBy, setSortBy] = useState<'failed' | 'total_runs' | 'success_rate'>('failed');

  if (isLoading) return <LoadingState message="Loading piece data..." />;
  if (!breakdown?.length) return <EmptyState message="No scheduled runs in this time range." />;

  const sorted = [...breakdown].sort((a, b) => {
    if (sortBy === 'failed') return b.failed - a.failed;
    if (sortBy === 'total_runs') return b.total_runs - a.total_runs;
    const rateA = a.total_runs > 0 ? a.passed / a.total_runs : 0;
    const rateB = b.total_runs > 0 ? b.passed / b.total_runs : 0;
    return rateA - rateB;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">Sort by:</span>
        {(['failed', 'total_runs', 'success_rate'] as const).map(s => (
          <button key={s} onClick={() => setSortBy(s)}
            className={`px-3 py-1 rounded text-xs ${sortBy === s ? 'bg-primary-600/20 text-primary-300' : 'text-gray-500 hover:text-gray-300'}`}>
            {s === 'failed' ? 'Most Failures' : s === 'total_runs' ? 'Most Runs' : 'Lowest Success Rate'}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {sorted.map(piece => <PieceHealthCard key={piece.piece_name} piece={piece} />)}
      </div>
    </div>
  );
}

function PieceHealthCard({ piece }: { piece: any }) {
  const rate = piece.total_runs > 0 ? Math.round((piece.passed / piece.total_runs) * 100) : 0;
  const barColor = rate >= 80 ? 'bg-green-500' : rate >= 50 ? 'bg-yellow-500' : 'bg-red-500';
  const statusColor = rate >= 80 ? 'text-green-400' : rate >= 50 ? 'text-yellow-400' : 'text-red-400';
  const shortName = piece.piece_name.replace('@activepieces/piece-', '');

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-200">{shortName}</span>
          <span className="text-[10px] text-gray-600 font-mono">{piece.piece_name}</span>
        </div>
        <span className={`text-lg font-bold ${statusColor}`}>{rate}%</span>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-2 mb-3">
        <div className={`h-2 rounded-full ${barColor} transition-all`} style={{ width: `${rate}%` }} />
      </div>
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span>{piece.total_runs} runs</span>
        <span className="text-green-400">{piece.passed} passed</span>
        <span className="text-red-400">{piece.failed} failed</span>
        <span>{piece.actions_tested} actions</span>
        {piece.avg_duration_ms > 0 && <span>{(piece.avg_duration_ms / 1000).toFixed(1)}s avg</span>}
        {piece.last_run_at && <span className="ml-auto">{formatRelativeTime(piece.last_run_at)}</span>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Failures Tab
// ══════════════════════════════════════════════════════════════

function FailuresTab({ dateFrom, dateTo }: { dateFrom?: string; dateTo?: string }) {
  const { data: failures, isLoading } = useQuery({
    queryKey: ['report-failures', dateFrom, dateTo],
    queryFn: () => api.getReportFailures(50, dateFrom, dateTo),
  });
  const [expandedRun, setExpandedRun] = useState<number | null>(null);

  if (isLoading) return <LoadingState message="Loading failures..." />;
  if (!failures?.length) return <EmptyState message="No failures from scheduled runs in this time range." />;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">{failures.length} failures</p>
      <div className="space-y-2">
        {failures.map((f: any) => {
          const expanded = expandedRun === f.run_id;
          const stepResults = f.step_results || [];
          const failedSteps = stepResults.filter((s: any) => s.status === 'failed');
          return (
            <div key={f.run_id} className="bg-gray-900 border border-red-500/20 rounded-lg overflow-hidden">
              <button onClick={() => setExpandedRun(expanded ? null : f.run_id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/50 transition-colors">
                <XCircle size={14} className="text-red-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200">{f.target_action}</span>
                    <span className="text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">
                      {f.piece_name.replace('@activepieces/piece-', '')}
                    </span>
                  </div>
                  {failedSteps.length > 0 && (
                    <p className="text-[10px] text-red-400/70 mt-0.5 truncate">
                      {failedSteps[0].error?.slice(0, 120) || 'Unknown error'}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-gray-500">
                  <span>{f.trigger_type}</span>
                  <span>{formatRelativeTime(f.started_at)}</span>
                </div>
                {expanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
              </button>
              {expanded && (
                <div className="border-t border-gray-800/50 px-4 py-3 space-y-1">
                  {stepResults.map((sr: any, idx: number) => {
                    const icon = sr.status === 'completed' ? <CheckCircle size={12} className="text-green-400" />
                      : sr.status === 'failed' ? <XCircle size={12} className="text-red-400" />
                      : <Clock size={12} className="text-gray-500" />;
                    return (
                      <div key={sr.stepId || idx}>
                        <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${sr.status === 'failed' ? 'bg-red-500/5' : ''}`}>
                          <span className="text-[10px] text-gray-600 w-3 text-right">{idx + 1}</span>
                          {icon}
                          <span className="flex-1 truncate text-gray-300">{sr.label || sr.stepId}</span>
                          {sr.duration_ms > 0 && <span className="text-[10px] text-gray-500">{(sr.duration_ms / 1000).toFixed(1)}s</span>}
                        </div>
                        {sr.error && (
                          <div className="ml-8 mt-1 text-[10px] text-red-400 bg-red-500/5 rounded p-1.5 font-mono whitespace-pre-wrap">{sr.error}</div>
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

// ══════════════════════════════════════════════════════════════
//  AI Analysis Tab
// ══════════════════════════════════════════════════════════════

function AiAnalysisTab({ timeRange, customFrom, customTo, dateFrom, dateTo }: {
  timeRange: TimeRange; customFrom: string; customTo: string; dateFrom?: string; dateTo?: string;
}) {
  const queryClient = useQueryClient();
  const [activeAnalysisId, setActiveAnalysisId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: latestCompleted, isLoading: loadingLatest } = useQuery({
    queryKey: ['report-latest-analysis'],
    queryFn: api.getLatestAnalysis,
  });
  const { data: pastAnalyses } = useQuery({
    queryKey: ['report-analyses'],
    queryFn: () => api.getReportAnalyses(20),
  });

  const { data: activeAnalysis } = useQuery({
    queryKey: ['report-analysis-active', activeAnalysisId],
    queryFn: () => activeAnalysisId ? api.getAnalysis(activeAnalysisId) : null,
    enabled: activeAnalysisId !== null,
    refetchInterval: activeAnalysisId ? 2000 : false,
  });

  const { data: serverRunning } = useQuery({
    queryKey: ['report-analysis-running'],
    queryFn: api.getRunningAnalysis,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (serverRunning && serverRunning.status === 'running' && !activeAnalysisId) {
      setActiveAnalysisId(serverRunning.id);
    }
  }, [serverRunning, activeAnalysisId]);

  useEffect(() => {
    if (activeAnalysis && activeAnalysis.status !== 'running') {
      if (activeAnalysis.status === 'failed') setError(activeAnalysis.error_message || 'Analysis failed');
      queryClient.invalidateQueries({ queryKey: ['report-latest-analysis'] });
      queryClient.invalidateQueries({ queryKey: ['report-analyses'] });
      queryClient.invalidateQueries({ queryKey: ['report-analysis-running'] });
    }
  }, [activeAnalysis, queryClient]);

  const isRunning = activeAnalysis?.status === 'running';

  const startAnalysis = useCallback(async () => {
    setError(null);
    try {
      const params: { time_range: string; date_from?: string; date_to?: string } = { time_range: timeRange };
      if (timeRange === 'custom') {
        if (customFrom) params.date_from = new Date(customFrom).toISOString();
        if (customTo) params.date_to = new Date(customTo + 'T23:59:59').toISOString();
      }
      const { id } = await api.startAnalysis(params);
      setActiveAnalysisId(id);
    } catch (err: any) {
      setError(err.message);
    }
  }, [timeRange, customFrom, customTo]);

  const logs = activeAnalysis?.logs || [];
  const displayAnalysis = (activeAnalysis?.status === 'completed' ? activeAnalysis : null) || latestCompleted;

  const completedPastAnalyses = (pastAnalyses || []).filter((a: any) => a.status === 'completed');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Claude analyzes test failures and classifies each as a piece bug, test config issue, or transient error.
        </p>
        <button onClick={startAnalysis}
          disabled={isRunning || (timeRange === 'custom' && !customFrom && !customTo)}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 rounded text-sm font-medium transition-colors shrink-0">
          {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
          {isRunning ? 'Analyzing...' : 'Run AI Analysis'}
        </button>
      </div>

      {isRunning && (
        <div className="bg-gray-900 border border-primary-500/20 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Loader2 size={14} className="animate-spin text-primary-400" />
            <span className="text-sm font-medium text-gray-300">Analysis in progress...</span>
            <span className="text-[10px] text-gray-600 ml-auto">
              {activeAnalysis?.time_range && activeAnalysis.time_range !== 'all'
                ? `Range: ${TIME_RANGE_OPTIONS.find(o => o.value === activeAnalysis.time_range)?.label || activeAnalysis.time_range}`
                : 'All time'}
            </span>
          </div>
          <p className="text-[10px] text-gray-600 mb-3">This runs in the background — you can leave and come back.</p>
          {logs.length > 0 && (
            <div className="space-y-1">
              {logs.map((log: any, i: number) => (
                <div key={i} className="text-xs text-gray-500 flex items-center gap-2">
                  <Brain size={10} className={log.type === 'error' ? 'text-red-400/50' : 'text-primary-400/50'} />
                  <span className={log.type === 'error' ? 'text-red-400' : ''}>{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && !isRunning && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-sm text-red-400">
          <AlertTriangle size={14} className="inline mr-2" />{error}
        </div>
      )}

      {displayAnalysis && !isRunning && <AnalysisResults analysis={displayAnalysis} />}

      {!displayAnalysis && !isRunning && loadingLatest && <LoadingState message="Loading previous analysis..." />}
      {!displayAnalysis && !isRunning && !loadingLatest && (
        <EmptyState message="No analysis yet. Select a time range and click 'Run AI Analysis' to get started." />
      )}

      {/* Past analyses — always visible, expandable */}
      {completedPastAnalyses.length > 0 && !isRunning && (
        <PastAnalysesList analyses={completedPastAnalyses} currentId={displayAnalysis?.id} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Analysis Results
// ══════════════════════════════════════════════════════════════

function AnalysisResults({ analysis, compact }: { analysis: any; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const analysisId: number | undefined = analysis.id;

  const { data: resolvedIssues } = useQuery({
    queryKey: ['resolved-issues', analysisId],
    queryFn: () => analysisId ? api.getResolvedIssues(analysisId) : [],
    enabled: !!analysisId,
  });

  const resolvedSet = useMemo(() => {
    const set = new Set<string>();
    (resolvedIssues || []).forEach((r: any) => set.add(`${r.category}:${r.item_index}`));
    return set;
  }, [resolvedIssues]);

  const resolveMutation = useMutation({
    mutationFn: (params: { category: string; item_index: number; run_id?: number; piece_name?: string; action_name?: string; note?: string }) =>
      api.resolveIssue(analysisId!, params),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['resolved-issues', analysisId] }),
  });

  const unresolveMutation = useMutation({
    mutationFn: (params: { category: string; item_index: number }) =>
      api.unresolveIssue(analysisId!, params),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['resolved-issues', analysisId] }),
  });

  const categories = analysis.categories || {};
  const pieceIssues = categories.piece_issues || analysis.piece_issues || [];
  const testIssues = categories.test_issues || analysis.test_issues || [];
  const transientIssues = categories.transient || analysis.transient_issues || [];
  const unknownIssues = categories.unknown || analysis.unknown_issues || [];
  const recommendations = analysis.recommendations || [];
  const healthScore = analysis.health_score ?? 0;
  const problematicPieces = categories.most_problematic_pieces || analysis.most_problematic_pieces || [];

  const countResolved = (cat: string, items: any[]) => {
    let n = 0;
    items.forEach((_, idx) => { if (resolvedSet.has(`${cat}:${idx}`)) n++; });
    return n;
  };

  const pieceResolved = countResolved('piece', pieceIssues);
  const testResolved = countResolved('test', testIssues);
  const transientResolved = countResolved('transient', transientIssues);
  const unknownResolved = countResolved('unknown', unknownIssues);
  const totalIssues = pieceIssues.length + testIssues.length + transientIssues.length + unknownIssues.length;
  const totalResolved = pieceResolved + testResolved + transientResolved + unknownResolved;

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
        <div className="flex items-start gap-6">
          <HealthScoreRing score={healthScore} />
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-200 mb-2">Analysis Summary</h3>
            <p className="text-sm text-gray-400 leading-relaxed">{analysis.summary}</p>
            <div className="flex items-center gap-3 mt-2">
              {analysis.created_at && <span className="text-[10px] text-gray-600">Generated: {new Date(analysis.created_at).toLocaleString()}</span>}
              {analysis.time_range && (
                <span className="text-[10px] bg-primary-600/10 text-primary-400/70 px-1.5 py-0.5 rounded">{rangeLabel(analysis)}</span>
              )}
            </div>
            {totalIssues > 0 && (
              <div className="mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-gray-500">Resolution Progress</span>
                  <span className="text-xs font-medium text-green-400">{totalResolved}/{totalIssues} fixed</span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-1.5">
                  <div className="h-1.5 rounded-full bg-green-500 transition-all duration-500"
                    style={{ width: `${Math.round((totalResolved / totalIssues) * 100)}%` }} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <CategoryCard icon={Bug} label="Piece Issues" count={pieceIssues.length} resolvedCount={pieceResolved} color="text-red-400"
          bgColor="bg-red-500/10" borderColor="border-red-500/20" description="Bugs in the piece code"
          expanded={expandedCategory === 'piece'} onToggle={() => setExpandedCategory(expandedCategory === 'piece' ? null : 'piece')} />
        <CategoryCard icon={Wrench} label="Test Issues" count={testIssues.length} resolvedCount={testResolved} color="text-yellow-400"
          bgColor="bg-yellow-500/10" borderColor="border-yellow-500/20" description="Test config problems"
          expanded={expandedCategory === 'test'} onToggle={() => setExpandedCategory(expandedCategory === 'test' ? null : 'test')} />
        <CategoryCard icon={Zap} label="Transient" count={transientIssues.length} resolvedCount={transientResolved} color="text-blue-400"
          bgColor="bg-blue-500/10" borderColor="border-blue-500/20" description="Temporary/env issues"
          expanded={expandedCategory === 'transient'} onToggle={() => setExpandedCategory(expandedCategory === 'transient' ? null : 'transient')} />
        <CategoryCard icon={HelpCircle} label="Unknown" count={unknownIssues.length} resolvedCount={unknownResolved} color="text-gray-400"
          bgColor="bg-gray-500/10" borderColor="border-gray-500/20" description="Needs investigation"
          expanded={expandedCategory === 'unknown'} onToggle={() => setExpandedCategory(expandedCategory === 'unknown' ? null : 'unknown')} />
      </div>

      {expandedCategory && (
        <ClassificationList
          items={
            expandedCategory === 'piece' ? pieceIssues : expandedCategory === 'test' ? testIssues :
            expandedCategory === 'transient' ? transientIssues : unknownIssues
          }
          category={expandedCategory}
          resolvedSet={resolvedSet}
          resolvedIssues={resolvedIssues || []}
          onResolve={(idx, item) => resolveMutation.mutate({
            category: expandedCategory, item_index: idx,
            run_id: item.run_id, piece_name: item.piece_name, action_name: item.action,
          })}
          onUnresolve={(idx) => unresolveMutation.mutate({ category: expandedCategory, item_index: idx })}
        />
      )}

      {!compact && problematicPieces.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Most Problematic Pieces</h3>
          <div className="space-y-2">
            {problematicPieces.map((p: any, i: number) => (
              <div key={i} className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                <span className="text-lg font-bold text-gray-600 w-6 text-right">#{i + 1}</span>
                <AlertTriangle size={14} className="text-red-400" />
                <span className="text-sm font-medium text-gray-200 flex-1">{p.piece_name.replace('@activepieces/piece-', '')}</span>
                <span className="text-xs text-gray-500">{p.issue_count} issues</span>
                <CategoryBadge category={p.primary_category} />
              </div>
            ))}
          </div>
        </div>
      )}

      {!compact && recommendations.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Recommendations</h3>
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800/50">
            {recommendations.map((rec: string, i: number) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <Shield size={14} className="text-primary-400 mt-0.5 shrink-0" />
                <p className="text-sm text-gray-300">{rec}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ClassificationList({ items, category, resolvedSet, resolvedIssues, onResolve, onUnresolve }: {
  items: any[];
  category: string;
  resolvedSet: Set<string>;
  resolvedIssues: any[];
  onResolve: (idx: number, item: any) => void;
  onUnresolve: (idx: number) => void;
}) {
  if (items.length === 0) return <p className="text-sm text-gray-500">No items in this category.</p>;

  const categoryColors: Record<string, string> = {
    piece: 'border-red-500/20', test: 'border-yellow-500/20', transient: 'border-blue-500/20', unknown: 'border-gray-500/20',
  };

  const mapped = items.map((item, i) => ({ item, i, resolved: resolvedSet.has(`${category}:${i}`) }));
  const sorted = [...mapped].sort((a, b) => Number(a.resolved) - Number(b.resolved));

  const resolvedCount = mapped.filter(m => m.resolved).length;

  return (
    <div className="space-y-3">
      {resolvedCount > 0 && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <CircleCheck size={12} className="text-green-400" />
          <span>{resolvedCount} of {items.length} issues resolved</span>
        </div>
      )}
      {sorted.map(({ item, i, resolved }) => {
        const resolvedRecord = resolved ? resolvedIssues.find((r: any) => r.category === category && r.item_index === i) : null;
        return (
          <IssueCard key={i} item={item} index={i} category={category}
            resolved={resolved} resolvedRecord={resolvedRecord}
            borderColor={resolved ? 'border-green-500/20' : (categoryColors[category] || 'border-gray-800')}
            onResolve={() => onResolve(i, item)} onUnresolve={() => onUnresolve(i)} />
        );
      })}
    </div>
  );
}

function IssueCard({ item, category, resolved, resolvedRecord, borderColor, onResolve, onUnresolve }: {
  item: any; index: number; category: string; resolved: boolean; resolvedRecord: any;
  borderColor: string; onResolve: () => void; onUnresolve: () => void;
}) {
  const queryClient = useQueryClient();
  const [showNote, setShowNote] = useState(false);
  const [noteText, setNoteText] = useState(resolvedRecord?.note || '');
  const [retestState, setRetestState] = useState<'idle' | 'loading' | 'running' | 'passed' | 'failed'>('idle');
  const [retestRunId, setRetestRunId] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: () => api.updateResolvedNote(resolvedRecord.id, noteText),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['resolved-issues'] }),
  });

  // Poll retest status
  const { data: retestRun } = useQuery({
    queryKey: ['retest-run', retestRunId],
    queryFn: () => retestRunId ? api.getPlanRun(retestRunId) : null,
    enabled: retestRunId !== null && (retestState === 'running' || retestState === 'loading'),
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (retestRun && retestState === 'running') {
      if (retestRun.status === 'completed') { setRetestState('passed'); }
      else if (retestRun.status === 'failed') { setRetestState('failed'); }
    }
    if (retestRun && retestState === 'loading' && retestRun.status === 'running') {
      setRetestState('running');
    }
  }, [retestRun, retestState]);

  const handleRetest = useCallback(async () => {
    if (!item.run_id) return;
    setRetestState('loading');
    try {
      const info = await api.getRunInfo(item.run_id);
      if (!info.plan_id) { setRetestState('idle'); return; }
      const result = await api.runPlanBackground(info.plan_id);
      if (result.run_id) {
        setRetestRunId(result.run_id);
        setRetestState('running');
      } else {
        setRetestState('idle');
      }
    } catch {
      setRetestState('failed');
    }
  }, [item.run_id]);

  const retestStatusEl = retestState === 'running' ? (
    <span className="flex items-center gap-1 text-[10px] text-blue-400">
      <Loader2 size={10} className="animate-spin" /> Retesting...
    </span>
  ) : retestState === 'passed' ? (
    <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium">
      <CheckCircle size={10} /> Retest passed
    </span>
  ) : retestState === 'failed' ? (
    <span className="flex items-center gap-1 text-[10px] text-red-400 font-medium">
      <XCircle size={10} /> Retest failed
    </span>
  ) : null;

  return (
    <div className={`bg-gray-900 border ${borderColor} rounded-lg overflow-hidden transition-all`}>
      {/* Main content */}
      <div className="p-4">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className={`text-sm font-medium ${resolved ? 'text-gray-500' : 'text-gray-200'}`}>{item.action}</span>
          <span className="text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{(item.piece_name || '').replace('@activepieces/piece-', '')}</span>
          <ConfidenceBadge confidence={item.confidence} />
          {item.run_id && <span className="text-[10px] text-gray-600">Run #{item.run_id}</span>}
          {retestStatusEl}
        </div>
        <p className={`text-sm ${resolved ? 'text-gray-600' : 'text-gray-400'}`}>{item.explanation}</p>
        {item.error_snippet && !resolved && (
          <div className="mt-2 text-[10px] text-red-400 bg-red-500/5 rounded p-2 font-mono whitespace-pre-wrap">{item.error_snippet}</div>
        )}
        {resolved && resolvedRecord?.note && !showNote && (
          <p className="mt-2 text-xs text-green-400/60 italic flex items-center gap-1.5">
            <MessageSquare size={10} /> {resolvedRecord.note}
          </p>
        )}
        {showNote && resolved && resolvedRecord && (
          <div className="mt-3 flex items-center gap-2">
            <input type="text" value={noteText} onChange={e => setNoteText(e.target.value)}
              placeholder="What did you fix?" autoFocus
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-300 placeholder:text-gray-600"
              onKeyDown={e => { if (e.key === 'Enter') { saveMutation.mutate(); setShowNote(false); } if (e.key === 'Escape') setShowNote(false); }} />
            <button onClick={() => { saveMutation.mutate(); setShowNote(false); }}
              className="px-2.5 py-1.5 bg-green-600/20 text-green-400 rounded text-xs font-medium hover:bg-green-600/30 transition-colors">
              Save
            </button>
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className={`flex items-center gap-2 px-4 py-2.5 border-t ${resolved ? 'border-green-500/10 bg-green-500/5' : 'border-gray-800/50 bg-gray-800/20'}`}>
        {resolved ? (
          <>
            <CircleCheck size={13} className="text-green-400" />
            <span className="text-xs font-medium text-green-400">Fixed</span>
            {resolvedRecord?.resolved_at && (
              <span className="text-[10px] text-gray-600">{formatRelativeTime(resolvedRecord.resolved_at)}</span>
            )}
            <div className="flex-1" />
            {item.run_id && retestState === 'idle' && (
              <button onClick={handleRetest}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium text-blue-400 hover:bg-blue-500/10 transition-colors">
                <RotateCcw size={11} /> Retest
              </button>
            )}
            <button onClick={() => setShowNote(!showNote)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors">
              <MessageSquare size={11} /> {resolvedRecord?.note ? 'Edit note' : 'Add note'}
            </button>
            <button onClick={onUnresolve}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] text-gray-600 hover:text-yellow-400 hover:bg-yellow-500/10 transition-colors">
              <Undo2 size={11} /> Undo
            </button>
          </>
        ) : (
          <>
            <div className="flex-1" />
            {item.run_id && retestState === 'idle' && (
              <button onClick={handleRetest}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
                <Play size={11} /> Run test
              </button>
            )}
            <button onClick={onResolve}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-green-600/15 text-green-400 hover:bg-green-600/25 border border-green-500/20 transition-colors">
              <CircleCheck size={12} /> Mark as fixed
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Past Analyses List (expandable to show full results)
// ══════════════════════════════════════════════════════════════

function PastAnalysesList({ analyses, currentId }: { analyses: any[]; currentId?: number }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
        Analysis History ({analyses.length})
      </h3>
      <div className="space-y-2">
        {analyses.map((a: any) => {
          const isCurrent = a.id === currentId;
          const isExpanded = expandedId === a.id;

          return (
            <div key={a.id} className={`bg-gray-900 border rounded-lg overflow-hidden ${isCurrent ? 'border-primary-500/30' : 'border-gray-800'}`}>
              <button
                onClick={() => setExpandedId(isExpanded ? null : a.id)}
                className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-gray-800/50 transition-colors"
              >
                <HealthScoreMini score={a.health_score} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-gray-300 truncate">{a.summary}</p>
                    {isCurrent && <span className="text-[9px] bg-primary-600/20 text-primary-400 px-1.5 py-0.5 rounded shrink-0">current</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-600">{new Date(a.created_at).toLocaleString()}</span>
                    <span className="text-[10px] text-gray-700">|</span>
                    <span className="text-[10px] text-primary-400/60">{rangeLabel(a)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[10px] shrink-0">
                  <span className="text-red-400">{a.piece_issues_count} bugs</span>
                  <span className="text-yellow-400">{a.test_issues_count} test</span>
                  <span className="text-blue-400">{a.transient_count} transient</span>
                </div>
                <div className="shrink-0">
                  {isExpanded
                    ? <ChevronDown size={14} className="text-gray-500" />
                    : <Eye size={14} className="text-gray-600" />}
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-gray-800/50 p-4">
                  <AnalysisResults analysis={a} compact />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Shared UI Components
// ══════════════════════════════════════════════════════════════

function HealthScoreBanner({ successRate, totalRuns }: { successRate: number; totalRuns: number }) {
  const color = successRate >= 80 ? 'from-green-500/20 to-green-500/5 border-green-500/30'
    : successRate >= 50 ? 'from-yellow-500/20 to-yellow-500/5 border-yellow-500/30'
    : 'from-red-500/20 to-red-500/5 border-red-500/30';
  const textColor = successRate >= 80 ? 'text-green-400' : successRate >= 50 ? 'text-yellow-400' : 'text-red-400';
  const Icon = successRate >= 80 ? TrendingUp : successRate >= 50 ? Activity : TrendingDown;
  const label = successRate >= 80 ? 'Healthy' : successRate >= 50 ? 'Needs Attention' : 'Critical';

  if (totalRuns === 0) {
    return (
      <div className="bg-gradient-to-r from-gray-500/10 to-gray-500/5 border border-gray-500/20 rounded-lg p-5 flex items-center gap-4">
        <Activity size={28} className="text-gray-500" />
        <div>
          <p className="text-lg font-bold text-gray-400">No Completed Runs</p>
          <p className="text-sm text-gray-500">No scheduled runs yet. Configure a schedule to start tracking health.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-gradient-to-r ${color} border rounded-lg p-5 flex items-center gap-4`}>
      <Icon size={28} className={textColor} />
      <div>
        <div className="flex items-center gap-3">
          <p className={`text-3xl font-bold ${textColor}`}>{successRate}%</p>
          <span className={`text-sm font-medium ${textColor}`}>{label}</span>
        </div>
        <p className="text-sm text-gray-500">Success rate across {totalRuns} completed scheduled runs</p>
      </div>
    </div>
  );
}

function HealthScoreRing({ score }: { score: number }) {
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? '#4ade80' : score >= 50 ? '#facc15' : '#f87171';
  return (
    <div className="relative w-24 h-24 shrink-0">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={radius} fill="none" stroke="#1f2937" strokeWidth="6" />
        <circle cx="40" cy="40" r={radius} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset} className="transition-all duration-1000" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold" style={{ color }}>{score}</span>
        <span className="text-[9px] text-gray-500">/ 100</span>
      </div>
    </div>
  );
}

function HealthScoreMini({ score }: { score: number }) {
  const color = score >= 80 ? 'text-green-400 bg-green-500/10' : score >= 50 ? 'text-yellow-400 bg-yellow-500/10' : 'text-red-400 bg-red-500/10';
  return <span className={`text-sm font-bold px-2 py-1 rounded ${color}`}>{score}</span>;
}

function StatCard({ icon: Icon, label, value, color, subtitle }: { icon: any; label: string; value: string | number; color: string; subtitle?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className={color} />
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <div className="flex items-end gap-2">
        <p className={`font-bold text-2xl ${color}`}>{value}</p>
        {subtitle && <span className="text-xs text-gray-500 mb-1">{subtitle}</span>}
      </div>
    </div>
  );
}

function CategoryCard({ icon: Icon, label, count, resolvedCount, color, bgColor, borderColor, description, expanded, onToggle }: {
  icon: any; label: string; count: number; resolvedCount?: number; color: string; bgColor: string; borderColor: string;
  description: string; expanded: boolean; onToggle: () => void;
}) {
  const allFixed = resolvedCount !== undefined && resolvedCount > 0 && resolvedCount === count;
  return (
    <button onClick={onToggle}
      className={`${allFixed ? 'bg-green-500/5' : bgColor} border ${allFixed ? 'border-green-500/20' : borderColor} rounded-lg p-4 text-left transition-all hover:brightness-110 ${expanded ? 'ring-1 ring-white/10' : ''}`}>
      <div className="flex items-center gap-2 mb-2">
        {allFixed ? <CircleCheck size={16} className="text-green-400" /> : <Icon size={16} className={color} />}
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <p className={`font-bold text-2xl ${allFixed ? 'text-green-400' : color}`}>{count}</p>
      <div className="flex items-center gap-1 mt-1">
        <p className="text-[10px] text-gray-500">{description}</p>
        {resolvedCount !== undefined && resolvedCount > 0 && (
          <span className="text-[10px] text-green-400 ml-auto font-medium">{resolvedCount} fixed</span>
        )}
      </div>
    </button>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const styles: Record<string, string> = {
    piece_issue: 'bg-red-500/10 text-red-400 border-red-500/20', test_issue: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    transient: 'bg-blue-500/10 text-blue-400 border-blue-500/20', unknown: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
  };
  const labels: Record<string, string> = { piece_issue: 'Piece Bug', test_issue: 'Test Issue', transient: 'Transient', unknown: 'Unknown' };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${styles[category] || styles.unknown}`}>{labels[category] || category}</span>;
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const styles: Record<string, string> = { high: 'text-green-400', medium: 'text-yellow-400', low: 'text-gray-500' };
  return <span className={`text-[10px] ${styles[confidence] || 'text-gray-500'}`}>{confidence} confidence</span>;
}

function TrendChart({ data }: { data: any[] }) {
  if (data.length === 0) return null;
  const maxVal = Math.max(...data.map(d => d.total), 1);
  const barWidth = Math.max(8, Math.min(40, Math.floor(700 / data.length) - 4));
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-end gap-1 h-32">
        {data.map((d, i) => {
          const passedH = (d.passed / maxVal) * 100;
          const failedH = (d.failed / maxVal) * 100;
          return (
            <div key={i} className="flex flex-col items-center gap-0.5 group relative" style={{ width: barWidth }}>
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-800 rounded px-2 py-1 text-[9px] text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                {d.date}: {d.passed}P / {d.failed}F
              </div>
              <div className="w-full flex flex-col-reverse">
                {d.passed > 0 && <div className="w-full bg-green-500/60 rounded-t-sm" style={{ height: `${passedH}%`, minHeight: 2 }} />}
                {d.failed > 0 && <div className="w-full bg-red-500/60 rounded-t-sm" style={{ height: `${failedH}%`, minHeight: 2 }} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-2 text-[9px] text-gray-600">
        <span>{data[0]?.date}</span>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500/60" /> Passed</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/60" /> Failed</span>
        </div>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function TopPiecesTable({ breakdown }: { breakdown: any[] }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 text-gray-500">
            <th className="text-left px-4 py-2 font-medium text-xs">#</th>
            <th className="text-left px-4 py-2 font-medium text-xs">Piece</th>
            <th className="text-right px-4 py-2 font-medium text-xs">Runs</th>
            <th className="text-right px-4 py-2 font-medium text-xs">Passed</th>
            <th className="text-right px-4 py-2 font-medium text-xs">Failed</th>
            <th className="text-right px-4 py-2 font-medium text-xs">Rate</th>
            <th className="text-right px-4 py-2 font-medium text-xs">Actions</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((p: any, i: number) => {
            const rate = p.total_runs > 0 ? Math.round((p.passed / p.total_runs) * 100) : 0;
            const rateColor = rate >= 80 ? 'text-green-400' : rate >= 50 ? 'text-yellow-400' : 'text-red-400';
            return (
              <tr key={p.piece_name} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-4 py-2 text-gray-600">{i + 1}</td>
                <td className="px-4 py-2"><span className="text-gray-300">{p.piece_name.replace('@activepieces/piece-', '')}</span></td>
                <td className="px-4 py-2 text-right text-gray-400">{p.total_runs}</td>
                <td className="px-4 py-2 text-right text-green-400">{p.passed}</td>
                <td className="px-4 py-2 text-right text-red-400">{p.failed}</td>
                <td className={`px-4 py-2 text-right font-medium ${rateColor}`}>{rate}%</td>
                <td className="px-4 py-2 text-right text-gray-500">{p.actions_tested}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LoadingState({ message }: { message: string }) {
  return <div className="flex items-center gap-3 text-gray-400 py-8"><Loader2 size={16} className="animate-spin" />{message}</div>;
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-12">
      <BarChart3 size={32} className="mx-auto text-gray-700 mb-3" />
      <p className="text-sm text-gray-500">{message}</p>
    </div>
  );
}

function formatRelativeTime(iso: string) {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch { return iso; }
}

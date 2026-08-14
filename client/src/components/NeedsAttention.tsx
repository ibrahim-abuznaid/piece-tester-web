import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type AttentionItem } from '../lib/api';
import ErrorPlaybook from './ErrorPlaybook';
import {
  ShieldAlert, KeyRound, XCircle, AlertTriangle, Zap, VolumeX, Undo2,
  RotateCcw, Loader2, CheckCircle, ChevronDown, ChevronRight,
} from 'lucide-react';

// Naive-UTC timestamps ("2026-06-22 08:48:37") are treated as UTC; ISO passes through.
function parseTs(s?: string | null): number {
  if (!s) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}
function sinceLabel(s?: string | null): string {
  const t = parseTs(s);
  if (!Number.isFinite(t)) return '—';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
const clean = (n: string) => n.replace('@activepieces/piece-', '');

export default function NeedsAttention() {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['attention'],
    queryFn: api.getAttention,
    refetchInterval: 30_000,
  });

  const [showWatching, setShowWatching] = useState(false);
  const [showNoise, setShowNoise] = useState(false);
  const [showMuted, setShowMuted] = useState(false);

  if (isLoading) return null;

  const active = items.filter(i => !i.muted);
  const muted = items.filter(i => i.muted);
  // Strict default: only these two lanes are shown expanded.
  const primary = active.filter(i => i.bucket === 'likely_broken' || i.bucket === 'reauth');
  const watching = active.filter(i => i.bucket === 'watching');
  const noise = active.filter(i => i.bucket === 'noise');

  const nothingAtAll = items.length === 0;

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <ShieldAlert size={18} className={primary.length > 0 ? 'text-red-400' : 'text-gray-500'} />
        <h3 className="text-lg font-semibold">Needs attention</h3>
        {primary.length > 0 && (
          <span className="text-xs bg-red-500/15 text-red-400 border border-red-500/25 rounded-full px-2 py-0.5 font-medium">
            {primary.length}
          </span>
        )}
      </div>

      {nothingAtAll ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-400 flex items-center gap-2">
          <CheckCircle size={15} className="text-green-400" /> Nothing needs attention — every tracked piece is passing.
        </div>
      ) : primary.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-400 flex items-center gap-2">
          <CheckCircle size={15} className="text-green-400" /> No high-confidence breakages right now.
          {(watching.length + noise.length + muted.length) > 0 && <span className="text-gray-600">See the lanes below.</span>}
        </div>
      ) : (
        <div className="space-y-1.5">
          {primary.map(it => <AttentionRow key={it.plan_id} item={it} />)}
        </div>
      )}

      <div className="mt-2 space-y-1">
        {watching.length > 0 && (
          <CollapsibleLane open={showWatching} onToggle={() => setShowWatching(v => !v)}
            label={`Watching (${watching.length})`} hint="single failures or flaky — not yet confirmed">
            {watching.map(it => <AttentionRow key={it.plan_id} item={it} />)}
          </CollapsibleLane>
        )}
        {noise.length > 0 && (
          <CollapsibleLane open={showNoise} onToggle={() => setShowNoise(v => !v)}
            label={`Transient / rate-limit (${noise.length})`} hint="likely environment — hidden by default">
            {noise.map(it => <AttentionRow key={it.plan_id} item={it} />)}
          </CollapsibleLane>
        )}
        {muted.length > 0 && (
          <CollapsibleLane open={showMuted} onToggle={() => setShowMuted(v => !v)}
            label={`Muted (${muted.length})`} hint="quarantined — excluded from the inbox">
            {muted.map(it => <AttentionRow key={it.plan_id} item={it} />)}
          </CollapsibleLane>
        )}
      </div>
    </section>
  );
}

function CollapsibleLane({ open, onToggle, label, hint, children }: {
  open: boolean; onToggle: () => void; label: string; hint: string; children: ReactNode;
}) {
  return (
    <div>
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-1 py-1.5 text-left text-xs text-gray-500 hover:text-gray-300">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="font-medium">{label}</span>
        <span className="text-gray-600">— {hint}</span>
      </button>
      {open && <div className="space-y-1.5 pb-1">{children}</div>}
    </div>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [retest, setRetest] = useState<'idle' | 'running' | 'passed' | 'failed' | 'blocked'>('idle');
  const [retestRunId, setRetestRunId] = useState<number | null>(null);

  // Poll the retest run until terminal.
  useQuery({
    queryKey: ['attn-retest', retestRunId],
    queryFn: async () => {
      if (!retestRunId) return null;
      const r = await api.getPlanRun(retestRunId);
      if (r?.status === 'completed') { setRetest('passed'); qc.invalidateQueries({ queryKey: ['attention'] }); }
      else if (r?.status === 'failed') setRetest('failed');
      else if (r?.status === 'blocked') { setRetest('blocked'); qc.invalidateQueries({ queryKey: ['attention'] }); }
      return r;
    },
    enabled: retestRunId !== null && retest === 'running',
    refetchInterval: 3000,
  });

  const muteMutation = useMutation({
    mutationFn: () => (item.muted && item.mute_id)
      ? api.unquarantineItem(item.mute_id)
      : api.quarantineItem({ piece_name: item.piece_name, action_name: item.action_name, reason: 'Muted from inbox' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attention'] }),
  });

  async function handleRetest() {
    setRetest('running');
    try {
      const res = await api.runPlanBackground(item.plan_id);
      if (res.run_id) setRetestRunId(res.run_id);
      else setRetest('idle');
    } catch { setRetest('failed'); }
  }

  const laneIcon = item.bucket === 'reauth' ? <KeyRound size={14} className="text-amber-400" />
    : item.bucket === 'likely_broken' ? <XCircle size={14} className="text-red-400" />
    : item.bucket === 'watching' ? <AlertTriangle size={14} className="text-yellow-400" />
    : <Zap size={14} className="text-blue-400" />;
  const border = item.bucket === 'likely_broken' ? 'border-red-500/20'
    : item.bucket === 'reauth' ? 'border-amber-500/20' : 'border-gray-800';

  const retestEl = retest === 'running' ? (
    <span className="flex items-center gap-1 text-[10px] text-blue-400"><Loader2 size={10} className="animate-spin" /> Retesting…</span>
  ) : retest === 'passed' ? (
    <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium"><CheckCircle size={10} /> Passed</span>
  ) : retest === 'failed' ? (
    <span className="flex items-center gap-1 text-[10px] text-red-400 font-medium"><XCircle size={10} /> Failed</span>
  ) : retest === 'blocked' ? (
    <span className="flex items-center gap-1 text-[10px] text-amber-400 font-medium"><KeyRound size={10} /> Connection issue</span>
  ) : null;

  return (
    <div className={`border rounded-lg ${border} bg-gray-900 px-4 py-2.5`}>
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen(o => !o)} title={open ? 'Hide guidance' : 'What can I do about this?'}
          className="text-gray-500 hover:text-gray-300 shrink-0">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {laneIcon}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-200 truncate">{clean(item.piece_name)}</span>
            <span className="text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{item.action_name}</span>
            <span className="text-[10px] text-gray-500">· {item.reason}</span>
          </div>
          {item.error && <p className="text-[11px] text-red-400/70 truncate mt-0.5">{item.error}</p>}
        </div>

        <span className="text-[10px] text-gray-500 shrink-0 hidden sm:block" title={`failing since ${item.failing_since ?? ''}`}>
          since {sinceLabel(item.failing_since)}
        </span>

        <div className="flex items-center gap-1 shrink-0">
          {item.backlinks && (
            <>
              <a href={item.backlinks.activepieces} target="_blank" rel="noreferrer"
                title="Recreate/repair this connection in Activepieces"
                className="px-2 py-1 rounded text-[11px] text-gray-500 hover:text-amber-400 hover:bg-amber-500/10">
                Fix in AP ↗
              </a>
              <button onClick={() => navigate(item.backlinks!.reimport)}
                title="Re-import this connection here"
                className="px-2 py-1 rounded text-[11px] text-gray-500 hover:text-primary-400 hover:bg-primary-500/10">
                Re-import
              </button>
            </>
          )}
          {retestEl ?? (
            <button onClick={handleRetest} title="Re-run this plan now"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-gray-500 hover:text-blue-400 hover:bg-blue-500/10">
              <RotateCcw size={11} /> Retest
            </button>
          )}
          <button onClick={() => navigate(`/history?piece=${encodeURIComponent(clean(item.piece_name))}`)} title="View this piece's runs"
            className="px-2 py-1 rounded text-[11px] text-gray-500 hover:text-gray-200 hover:bg-gray-800">
            Runs
          </button>
          <button onClick={() => muteMutation.mutate()} disabled={muteMutation.isPending}
            title={item.muted ? 'Unmute' : 'Mute (quarantine)'}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] ${
              item.muted ? 'text-gray-400 hover:text-green-400 hover:bg-green-500/10' : 'text-gray-500 hover:text-amber-400 hover:bg-amber-500/10'
            }`}>
            {item.muted ? <><Undo2 size={11} /> Unmute</> : <><VolumeX size={11} /> Mute</>}
          </button>
        </div>
      </div>

      {open && (
        <ErrorPlaybook
          pieceName={item.piece_name}
          actionName={item.action_name}
          category={item.category}
          planId={item.plan_id}
          lastRunId={item.last_run_id}
          failStreak={item.fail_streak}
          flaky={item.flaky}
          muted={item.muted}
          muteId={item.mute_id}
          showRunActions={false}
        />
      )}
    </div>
  );
}

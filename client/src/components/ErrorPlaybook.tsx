import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import {
  Lightbulb, KeyRound, CalendarClock, Wand2, ListChecks, ExternalLink,
  Pencil, ScrollText, RotateCcw, Loader2, CheckCircle, XCircle,
  VolumeX, Undo2, Info, Send, type LucideIcon,
} from 'lucide-react';
import ReportToPiecesModal from './ReportToPiecesModal';

const clean = (n: string) => n.replace('@activepieces/piece-', '');

/**
 * Deterministic "what you can do" playbook for a failing (piece, action).
 *
 * Keyed off the deterministic error category (see plan-executor.classifyError +
 * queries.analyzeFailedRun) — NOT an LLM. Each category maps to a plain-language
 * diagnosis, who's likely at fault, and concrete next actions wired to pages that
 * already exist in this app. Rendered in both the Needs Attention inbox and the
 * Piece Health board so both surfaces give the same guidance.
 */
export interface ErrorPlaybookProps {
  pieceName: string;
  actionName: string;
  /** errorCategory | 'assert_failed' | 'unknown' */
  category: string;
  /** Enables the Retest action + a precise plan link. */
  planId?: number;
  /** The specific failed run — lets "View run details" jump to it in the Scheduled Runs feed. */
  lastRunId?: number;
  /** Consecutive failures — drives the confidence note. */
  failStreak?: number;
  /** Recently mixed pass/fail — drives the confidence note. */
  flaky?: boolean;
  /** Whether this item is currently quarantined. */
  quarantined?: boolean;
  quarantineId?: number | null;
  /**
   * Whether to render the Retest / Quarantine run-actions inside the panel.
   * Off in Needs Attention (the row header already carries them); on elsewhere.
   */
  showRunActions?: boolean;
  /** Show the "Report to Pieces team" action (genuine piece faults only). */
  reportable?: boolean;
}

type Blame = 'connection' | 'piece' | 'test' | 'environment' | 'unknown';

interface NavAction {
  label: string;
  to: string;
  icon: LucideIcon;
  primary?: boolean;
}

interface Playbook {
  blame: Blame;
  diagnosis: string;
  nav: NavAction[];
}

const BLAME_CHIP: Record<Blame, { label: string; cls: string }> = {
  connection: { label: 'connection', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  piece: { label: 'likely piece bug', cls: 'bg-red-500/15 text-red-300 border-red-500/25' },
  test: { label: 'likely test config', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/25' },
  environment: { label: 'environment', cls: 'bg-gray-500/15 text-gray-300 border-gray-600/40' },
  unknown: { label: 'needs a look', cls: 'bg-gray-500/15 text-gray-400 border-gray-600/40' },
};

function buildPlaybook(category: string, targets: {
  connections: string; pieceHub: string; runs: string; schedules: string;
}): Playbook {
  const { connections, pieceHub, runs, schedules } = targets;
  switch (category) {
    case 'auth':
      return {
        blame: 'connection',
        diagnosis: 'Looks like a connection / auth problem (401/403) — the piece code is probably fine, the credential just needs refreshing.',
        nav: [
          { label: 'Re-authenticate connection', to: connections, icon: KeyRound, primary: true },
          { label: 'View runs', to: runs, icon: ScrollText },
        ],
      };
    case 'rate_limit':
      return {
        blame: 'environment',
        diagnosis: 'Hit a rate limit (429) — almost always environmental, not a piece bug. It usually clears on its own.',
        nav: [
          { label: 'Space out the schedule', to: schedules, icon: CalendarClock, primary: true },
          { label: 'View runs', to: runs, icon: ScrollText },
        ],
      };
    case 'transient':
      return {
        blame: 'environment',
        diagnosis: 'Temporary network / upstream error (timeout or 5xx) — likely the environment or a brief outage rather than the piece.',
        nav: [
          { label: 'View run details', to: runs, icon: ScrollText, primary: true },
        ],
      };
    case 'bad_request':
      return {
        blame: 'test',
        diagnosis: 'The request was rejected (400/422) — usually a stale or invalid test input, not the piece itself.',
        nav: [
          { label: 'Edit test inputs', to: pieceHub, icon: Pencil, primary: true },
          { label: 'Re-run AI planner', to: pieceHub, icon: Wand2 },
          { label: 'View run details', to: runs, icon: ScrollText },
        ],
      };
    case 'not_found':
      return {
        blame: 'test',
        diagnosis: 'A referenced resource was not found (404) — the test may point at data that no longer exists, or the endpoint moved.',
        nav: [
          { label: 'Edit test inputs', to: pieceHub, icon: Pencil, primary: true },
          { label: 'Re-run AI planner', to: pieceHub, icon: Wand2 },
          { label: 'View run details', to: runs, icon: ScrollText },
        ],
      };
    case 'assert_failed':
      return {
        blame: 'unknown',
        diagnosis: 'The step ran but its output failed an assertion — either the API contract changed (a piece issue) or the assertion is stale (a test issue). Compare the expected vs. actual output to tell which.',
        nav: [
          { label: 'Review / edit assertions', to: pieceHub, icon: ListChecks, primary: true },
          { label: 'View actual output', to: runs, icon: ScrollText },
          { label: 'Run AI fixer', to: pieceHub, icon: Wand2 },
        ],
      };
    case 'piece_error':
      return {
        blame: 'piece',
        diagnosis: 'The piece itself errored — this is the case that usually means the piece needs a fix (a code bug or an unhandled API change).',
        nav: [
          { label: 'Run the AI fixer', to: pieceHub, icon: Wand2, primary: true },
          { label: 'Open piece / view source', to: pieceHub, icon: ExternalLink },
          { label: 'View run details', to: runs, icon: ScrollText },
        ],
      };
    default:
      return {
        blame: 'unknown',
        diagnosis: 'Could not classify this automatically — open the run to see which step failed and why.',
        nav: [
          { label: 'View run details', to: runs, icon: ScrollText, primary: true },
          { label: 'Open piece', to: pieceHub, icon: ExternalLink },
        ],
      };
  }
}

function confidenceNote(p: ErrorPlaybookProps): string | null {
  if (p.flaky) return 'Recently passed and failed — may be intermittent. Retest a couple of times before treating it as broken.';
  if (typeof p.failStreak === 'number' && p.failStreak >= 2) return `Failed ${p.failStreak}× in a row — consistent, so this is likely a real issue rather than a fluke.`;
  if (p.failStreak === 1) return 'First failure — retest to confirm it reproduces before acting.';
  return null;
}

export default function ErrorPlaybook(props: ErrorPlaybookProps) {
  const { pieceName, actionName, category, planId, lastRunId, quarantined, quarantineId, showRunActions = true } = props;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showReport, setShowReport] = useState(false);
  const { data: reported } = useQuery({ queryKey: ['reported'], queryFn: api.getReported, staleTime: 15000 });
  const existingReport = reported?.find(r => r.piece_name === pieceName);

  const targets = {
    connections: '/connections',
    pieceHub: `/pieces/${encodeURIComponent(pieceName)}`,
    // "View run details" jumps straight to THIS failed run in the wave-grouped Scheduled
    // Runs feed (it's a scheduled run); fall back to the piece-filtered Test Logs otherwise.
    runs: lastRunId != null
      ? `/schedules?tab=logs&run=${lastRunId}`
      : `/history?piece=${encodeURIComponent(clean(pieceName))}`,
    schedules: '/schedules',
  };
  const play = buildPlaybook(category, targets);
  const chip = BLAME_CHIP[play.blame];
  const note = confidenceNote(props);

  // ── Self-contained Retest (fire + poll until terminal) ──
  const [retest, setRetest] = useState<'idle' | 'running' | 'passed' | 'failed'>('idle');
  const [retestRunId, setRetestRunId] = useState<number | null>(null);
  useQuery({
    queryKey: ['playbook-retest', retestRunId],
    queryFn: async () => {
      if (!retestRunId) return null;
      const r = await api.getPlanRun(retestRunId);
      if (r?.status === 'completed') {
        setRetest('passed');
        qc.invalidateQueries({ queryKey: ['attention'] });
        qc.invalidateQueries({ queryKey: ['piece-health'] });
      } else if (r?.status === 'failed') setRetest('failed');
      return r;
    },
    enabled: retestRunId !== null && retest === 'running',
    refetchInterval: 3000,
  });
  async function handleRetest() {
    if (!planId) return;
    setRetest('running');
    try {
      const res = await api.runPlanBackground(planId);
      if (res.run_id) setRetestRunId(res.run_id);
      else setRetest('idle');
    } catch { setRetest('failed'); }
  }

  // ── Self-contained Quarantine / Unquarantine ──
  const quarantineMutation = useMutation({
    mutationFn: () => (quarantined && quarantineId)
      ? api.unquarantineItem(quarantineId)
      : api.quarantineItem({ piece_name: pieceName, action_name: actionName, reason: 'Quarantined from playbook' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attention'] });
      qc.invalidateQueries({ queryKey: ['piece-health'] });
    },
  });

  const btnBase = 'flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border transition-colors';

  return (
    <div className="mt-2 rounded-md border border-gray-800 bg-gray-950/60 p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Lightbulb size={13} className="text-amber-300/80 shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">What you can do</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${chip.cls}`}>{chip.label}</span>
      </div>

      <p className="text-[12px] text-gray-300 leading-snug">{play.diagnosis}</p>

      {note && (
        <p className="text-[11px] text-gray-500 mt-1 flex items-start gap-1">
          <Info size={11} className="mt-0.5 shrink-0" /> <span>{note}</span>
        </p>
      )}

      <div className="flex flex-wrap gap-1.5 mt-2.5">
        {play.nav.map((a, i) => (
          <button
            key={`${a.label}-${i}`}
            onClick={() => navigate(a.to)}
            className={`${btnBase} ${a.primary
              ? 'border-primary-500/40 text-primary-300 hover:bg-primary-500/10'
              : 'border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}
          >
            <a.icon size={12} /> {a.label}
          </button>
        ))}

        {showRunActions && planId && (
          retest === 'running' ? (
            <span className={`${btnBase} border-blue-500/30 text-blue-400`}>
              <Loader2 size={12} className="animate-spin" /> Retesting…
            </span>
          ) : retest === 'passed' ? (
            <span className={`${btnBase} border-green-500/30 text-green-400`}>
              <CheckCircle size={12} /> Passed
            </span>
          ) : retest === 'failed' ? (
            <span className={`${btnBase} border-red-500/30 text-red-400`}>
              <XCircle size={12} /> Failed again
            </span>
          ) : (
            <button onClick={handleRetest} title="Re-run this plan now"
              className={`${btnBase} border-gray-700 text-gray-400 hover:text-blue-300 hover:bg-blue-500/10`}>
              <RotateCcw size={12} /> Retest
            </button>
          )
        )}

        {showRunActions && (
          <button onClick={() => quarantineMutation.mutate()} disabled={quarantineMutation.isPending}
            title={quarantined ? 'Unquarantine (return to the inbox)' : 'Quarantine — not a bug, hide from the inbox'}
            className={`${btnBase} ${quarantined
              ? 'border-gray-700 text-gray-400 hover:text-green-300 hover:bg-green-500/10'
              : 'border-gray-700 text-gray-400 hover:text-amber-300 hover:bg-amber-500/10'}`}>
            {quarantined ? <><Undo2 size={12} /> Unquarantine</> : <><VolumeX size={12} /> Quarantine</>}
          </button>
        )}

        {existingReport ? (
          <a href={existingReport.linear_url} target="_blank" rel="noreferrer"
            title="Open the Linear issue for this piece"
            className={`${btnBase} border-green-500/30 text-green-400 hover:bg-green-500/10`}>
            <CheckCircle size={12} /> Reported
          </a>
        ) : props.reportable ? (
          <button onClick={() => setShowReport(true)} title="Draft a Linear issue for the Pieces team"
            className={`${btnBase} border-primary-500/40 text-primary-300 hover:bg-primary-500/10`}>
            <Send size={12} /> Report to Pieces team
          </button>
        ) : null}
      </div>
      {showReport && <ReportToPiecesModal pieceName={pieceName} onClose={() => setShowReport(false)} />}
    </div>
  );
}

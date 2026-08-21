import { useState, useEffect, useRef, useCallback } from 'react';
import {
  api,
  type TestPlanStep, type TestPlan, type StepResult, type PlanProgress,
  type AgentLogEntry, type PlanStreamCallbacks,
  type PlanAssertion, type AssertionResult, type AssertionOp,
} from '../lib/api';
import {
  Play, Loader2, Brain, Check, X, ChevronDown, ChevronRight,
  Trash2, Plus, GripVertical, AlertTriangle, Clock, CheckCircle,
  XCircle, Pause, MessageSquare, Shield, Terminal, Edit3,
  RotateCcw, Save, Wrench, BookOpen, Lightbulb, Square,
} from 'lucide-react';

// ── Step type config ──

const STEP_TYPE_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  setup:       { label: 'Setup',       color: 'text-blue-400',   bg: 'bg-blue-500/10',   border: 'border-blue-500/30' },
  test:        { label: 'Test',        color: 'text-green-400',  bg: 'bg-green-500/10',  border: 'border-green-500/30' },
  verify:      { label: 'Verify',      color: 'text-cyan-400',   bg: 'bg-cyan-500/10',   border: 'border-cyan-500/30' },
  cleanup:     { label: 'Cleanup',     color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/30' },
  human_input: { label: 'Human Input', color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/30' },
  trigger_arm: { label: 'Arm Trigger', color: 'text-teal-400',   bg: 'bg-teal-500/10',   border: 'border-teal-500/30' },
  trigger_test:{ label: 'Trigger',     color: 'text-green-400',  bg: 'bg-green-500/10',  border: 'border-green-500/30' },
};

const STEP_STATUS_ICON: Record<string, JSX.Element> = {
  pending:       <Clock size={14} className="text-gray-500" />,
  running:       <Loader2 size={14} className="text-blue-400 animate-spin" />,
  completed:     <CheckCircle size={14} className="text-green-400" />,
  failed:        <XCircle size={14} className="text-red-400" />,
  assert_failed: <AlertTriangle size={14} className="text-amber-400" />,
  skipped:       <X size={14} className="text-gray-600" />,
  waiting:       <Pause size={14} className="text-yellow-400" />,
};

// ── Assertions (the oracle) UI ──

const ASSERTION_OPS: { value: AssertionOp; label: string; needsValue: boolean }[] = [
  { value: 'exists',    label: 'exists',          needsValue: false },
  { value: 'not_empty', label: 'not empty',       needsValue: false },
  { value: 'equals',    label: 'equals',          needsValue: true },
  { value: 'contains',  label: 'contains',        needsValue: true },
  { value: 'matches',   label: 'matches /regex/', needsValue: true },
  { value: 'gt',        label: '> (number)',      needsValue: true },
  { value: 'lt',        label: '< (number)',      needsValue: true },
  { value: 'type',      label: 'type is',         needsValue: true },
];

// Deterministic error categories — amber = not the piece's fault, red = likely is.
const ERROR_CATEGORY_LABELS: Record<string, { label: string; cls: string }> = {
  auth:        { label: 'Auth / token',  cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  rate_limit:  { label: 'Rate limited',  cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  transient:   { label: 'Transient',     cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  bad_request: { label: 'Bad input',     cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  not_found:   { label: 'Not found',     cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  piece_error: { label: 'Piece error',   cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
  unknown:     { label: 'Unknown',       cls: 'bg-gray-600/30 text-gray-300 border-gray-600/40' },
};

function fmtVal(v: unknown): string {
  if (v === undefined) return 'undefined';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Parse a raw editor string into an assertion operand: JSON if it parses, else the raw string. */
function parseAssertionValue(raw: string): unknown {
  if (raw === '') return '';
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Collect dotted leaf paths from a value, for the assertion path picker.
 * Arrays expose their first element as `.0` so you can target `data.0.id`.
 * Mirrors the server-side path collector so the picker matches the true output root.
 */
function collectLeafPaths(obj: unknown, prefix = '', depth = 5): string[] {
  if (depth <= 0 || obj === null || obj === undefined || typeof obj !== 'object') {
    return prefix ? [prefix] : [];
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return prefix ? [prefix] : [];
    const idxPrefix = prefix ? `${prefix}.0` : '0';
    const first = obj[0];
    return (first !== null && typeof first === 'object') ? collectLeafPaths(first, idxPrefix, depth - 1) : [idxPrefix];
  }
  const out: string[] = [];
  for (const key of Object.keys(obj as Record<string, unknown>).slice(0, 60)) {
    const full = prefix ? `${prefix}.${key}` : key;
    const child = (obj as Record<string, unknown>)[key];
    if (child !== null && typeof child === 'object' && depth > 1) out.push(...collectLeafPaths(child, full, depth - 1));
    else out.push(full);
  }
  return out;
}

/** Renders evaluated assertion results (after a run), or the defined assertions (before). */
function AssertionResultsView({ results, defined }: { results?: AssertionResult[]; defined?: PlanAssertion[] }) {
  if (results && results.length > 0) {
    return (
      <div>
        <span className="text-gray-400 font-medium">Assertions (oracle):</span>
        <div className="mt-1 space-y-1">
          {results.map((r, i) => (
            <div key={i} className={`flex items-start gap-2 rounded p-1.5 border text-[11px] ${
              r.passed ? 'bg-green-500/5 border-green-500/20' : 'bg-amber-500/10 border-amber-500/30'
            }`}>
              {r.passed
                ? <Check size={12} className="text-green-400 mt-0.5 flex-shrink-0" />
                : <X size={12} className="text-amber-400 mt-0.5 flex-shrink-0" />}
              <div className="min-w-0">
                <code className="text-gray-300">
                  {r.path || 'output'} {r.op}{r.expected !== undefined ? ` ${fmtVal(r.expected)}` : ''}
                </code>
                {!r.passed && (
                  <div className="text-amber-300/80 font-mono break-all">got: {fmtVal(r.actual).slice(0, 140)}</div>
                )}
                {r.description && <div className="text-gray-500">{r.description}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (defined && defined.length > 0) {
    return (
      <div>
        <span className="text-gray-400 font-medium">Assertions (oracle):</span>
        <div className="mt-1 space-y-1">
          {defined.map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px] text-gray-400">
              <Shield size={11} className="text-gray-500 flex-shrink-0" />
              <code className="text-gray-400">{a.path || 'output'} {a.op}{a.value !== undefined ? ` ${fmtVal(a.value)}` : ''}</code>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
}

/** Inline editor for a step's output assertions (the human-authored oracle). */
function AssertionsEditor({ assertions, availablePaths, onChange }: {
  assertions?: PlanAssertion[];
  /** Dotted paths detected in the step's last-run output, for the path picker. */
  availablePaths: string[];
  onChange: (a: PlanAssertion[]) => void;
}) {
  const list = assertions || [];
  const update = (i: number, patch: Partial<PlanAssertion>) => onChange(list.map((a, idx) => idx === i ? { ...a, ...patch } : a));
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i));
  const add = () => onChange([...list, { path: '', op: 'exists' }]);
  const hasPaths = availablePaths.length > 0;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-gray-500 font-medium">Assertions (oracle):</span>
        <button onClick={(e) => { e.stopPropagation(); add(); }} className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
          <Plus size={10} /> Add assertion
        </button>
      </div>
      {list.length === 0 && (
        <p className="text-[10px] text-gray-600 mt-1">No assertions — this step passes if it merely runs without error. Add one to check the output is actually correct.</p>
      )}
      {list.length > 0 && (
        <p className="text-[10px] text-gray-600 mt-1">
          {hasPaths ? 'Use the ⌄ menu to pick a field from the last run’s output.' : 'Run the plan once to pick fields from the output, or type a dot-path (empty = whole output).'}
        </p>
      )}
      <div className="mt-1 space-y-1">
        {list.map((a, i) => {
          const opMeta = ASSERTION_OPS.find(o => o.value === a.op);
          return (
            <div key={i} className="flex items-center gap-1">
              <div className="flex-1 min-w-0 flex items-center gap-1">
                <input
                  className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 font-mono"
                  placeholder='path (e.g. id) — empty = whole output'
                  value={a.path}
                  onChange={(e) => update(i, { path: e.target.value })}
                />
                {hasPaths && (
                  <select
                    title="Pick a field detected in the last run's output"
                    className="bg-gray-800 border border-gray-700 rounded px-0.5 py-1 text-[11px] text-gray-400 flex-shrink-0"
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '') return;
                      update(i, { path: v === ' root' ? '' : v });
                    }}
                  >
                    <option value="">⌄</option>
                    <option value={' root'}>(whole output)</option>
                    {availablePaths.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                )}
              </div>
              <select
                className="bg-gray-800 border border-gray-700 rounded px-1 py-1 text-[11px] text-gray-200 flex-shrink-0"
                value={a.op}
                onChange={(e) => update(i, { op: e.target.value as AssertionOp })}
              >
                {ASSERTION_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {opMeta?.needsValue && (
                <input
                  className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 font-mono"
                  placeholder="value"
                  value={a.value === undefined ? '' : typeof a.value === 'string' ? a.value : JSON.stringify(a.value)}
                  onChange={(e) => update(i, { value: parseAssertionValue(e.target.value) })}
                />
              )}
              <button onClick={(e) => { e.stopPropagation(); remove(i); }} className="text-red-400 hover:text-red-300 flex-shrink-0">
                <Trash2 size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════

interface TestPlanViewProps {
  pieceName: string;
  /** The target name. For triggers this holds the trigger name. */
  actionName: string;
  actionDisplayName: string;
  hasAnthropicKey: boolean;
  /** 'action' (default) or 'trigger'. Triggers use the v2 trigger planner and have no v1/fix path. */
  targetKind?: 'action' | 'trigger';
  onClose?: () => void;
  /** Notify parent when plan is created/updated/deleted */
  onPlanChange?: (plan: TestPlan | null) => void;
}

export default function TestPlanView({
  pieceName, actionName, actionDisplayName, hasAnthropicKey, targetKind = 'action', onClose, onPlanChange,
}: TestPlanViewProps) {
  const isTrigger = targetKind === 'trigger';
  // Background job key used by the server (v2 trigger jobs are namespaced).
  const jobKey = isTrigger ? `v2:trigger:${actionName}` : `v2:${actionName}`;
  const [plan, setPlan] = useState<TestPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [agentLogs, setAgentLogs] = useState<AgentLogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editedSteps, setEditedSteps] = useState<TestPlanStep[]>([]);
  // Raw text buffers for the input JSON editor, keyed by step id, so typing
  // invalid-intermediate JSON doesn't get reset out from under the cursor.
  const [inputDrafts, setInputDrafts] = useState<Record<string, string>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, boolean>>({});
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  // Execution state
  const [executing, setExecuting] = useState(false);
  const [stepResults, setStepResults] = useState<StepResult[]>([]);
  const [currentRunId, setCurrentRunId] = useState<number | null>(null);
  const [pausedInfo, setPausedInfo] = useState<{ stepId: string; prompt: string; type: 'human' | 'approval' } | null>(null);
  const [humanInput, setHumanInput] = useState('');
  const [saveHumanInput, setSaveHumanInput] = useState(true);
  const [executionDone, setExecutionDone] = useState(false);
  const [fixing, setFixing] = useState(false);
  // Optional free-text hint the user gives the AI fixer ("the id is under data[0].id", etc.)
  const [fixInstruction, setFixInstruction] = useState('');

  // Auto-test state (during plan creation)
  const [autoTestResults, setAutoTestResults] = useState<StepResult[]>([]);
  const [autoTestPassed, setAutoTestPassed] = useState<boolean | null>(null);

  // Lessons panel
  const [lessons, setLessons] = useState<{ id: number; lesson: string; source: string; created_at: string }[]>([]);
  const [showLessons, setShowLessons] = useState(false);

  // Inline human-response editing
  const [editingResponseStepId, setEditingResponseStepId] = useState<string | null>(null);
  const [editingResponseValue, setEditingResponseValue] = useState('');

  // Cross-plan propagation prompt
  const [propagateOffer, setPropagateOffer] = useState<{
    prompt: string;
    value: string;
    matches: Array<{ planId: number; actionName: string; stepId: string }>;
  } | null>(null);

  // v2 multi-agent toggle
  const [useV2, setUseV2] = useState(true);

  // Cost tracking
  const [costSummary, setCostSummary] = useState<{ cost_usd: number; input_tokens: number; output_tokens: number; requests: number } | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Load existing plan + lessons, and check for active background jobs
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = isTrigger
          ? await api.getTestPlanByTrigger(pieceName, actionName)
          : await api.getTestPlanByAction(pieceName, actionName);
        if (!cancelled) { setPlan(existing); setEditedSteps(existing.steps); }
      } catch {
        // No plan exists yet
      }
      try {
        const ls = await api.getLessons(pieceName);
        if (!cancelled) setLessons(ls);
      } catch { /* non-critical */ }
      if (!cancelled) setLoading(false);

      // Check for a running background job and reconnect
      try {
        const jobs = await api.getAiPlanJobs(pieceName);
        if (cancelled) return;
        const activeJob = isTrigger ? jobs[jobKey] : (jobs[`v2:${actionName}`] || jobs[actionName]);
        if (activeJob && activeJob.status === 'running') {
          setCreating(true);
          setShowLogs(true);

          const callbacks: PlanStreamCallbacks = {
            onLog: (log) => { if (!cancelled) setAgentLogs(prev => [...prev, log]); },
            onResult: (result) => {
              if (cancelled) return;
              if (result.costSummary) setCostSummary(result.costSummary);
              const hasUnfilledHuman = result.steps.some(
                (s: any) => s.type === 'human_input' && !s.savedHumanResponse
              );
              const newPlan: TestPlan = {
                id: result.planId,
                piece_name: pieceName,
                target_action: actionName,
                target_type: targetKind,
                steps: result.steps,
                status: result.status as 'draft' | 'approved',
                agent_memory: result.agentMemory || '',
                automation_status: hasUnfilledHuman ? 'requires_human' : 'fully_automated',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
              setPlan(newPlan);
              setEditedSteps(result.steps);
              onPlanChange?.(newPlan);
              if (result.autoTestPassed) setAutoTestPassed(true);
            },
            onPlanProgress: (progress) => {
              if (!cancelled && progress.stepResults) setAutoTestResults([...progress.stepResults]);
            },
            onError: (msg) => { if (!cancelled) setAgentLogs(prev => [...prev, { timestamp: Date.now(), type: 'error', message: msg }]); },
            onDone: () => { if (!cancelled) { setCreating(false); refreshLessons(); } },
          };

          controllerRef.current = isTrigger
            ? api.streamTriggerPlanV2(pieceName, actionName, callbacks, plan?.agent_memory || undefined)
            : jobs[`v2:${actionName}`]
            ? api.streamAiPlanV2(pieceName, actionName, callbacks, plan?.agent_memory || undefined)
            : api.subscribeAiPlanJob(pieceName, actionName, callbacks);
        }
      } catch { /* non-critical */ }
    })();

    return () => { cancelled = true; };
  }, [pieceName, actionName]);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agentLogs]);

  // ── Create plan with AI ──
  const createPlan = useCallback(() => {
    controllerRef.current?.abort();
    setCreating(true);
    setAgentLogs([]);
    setShowLogs(true);
    setAutoTestResults([]);
    setAutoTestPassed(null);
    setCostSummary(null);

    const memory = plan?.agent_memory || undefined;

    const callbacks: PlanStreamCallbacks = {
      onLog: (log) => setAgentLogs(prev => [...prev, log]),
      onResult: (result) => {
        if (result.costSummary) setCostSummary(result.costSummary);
        const hasUnfilledHuman = result.steps.some(
          (s: any) => s.type === 'human_input' && !s.savedHumanResponse
        );
        const newPlan: TestPlan = {
          id: result.planId,
          piece_name: pieceName,
          target_action: actionName,
          target_type: targetKind,
          steps: result.steps,
          status: result.status as 'draft' | 'approved',
          agent_memory: result.agentMemory || '',
          automation_status: hasUnfilledHuman ? 'requires_human' : 'fully_automated',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setPlan(newPlan);
        setEditedSteps(result.steps);
        onPlanChange?.(newPlan);
        if (result.autoTestPassed) {
          setAutoTestPassed(true);
        }
      },
      onPlanProgress: (progress) => {
        if (progress.stepResults) setAutoTestResults([...progress.stepResults]);
      },
      onError: (msg) => setAgentLogs(prev => [...prev, { timestamp: Date.now(), type: 'error', message: msg }]),
      onDone: () => { setCreating(false); refreshLessons(); },
    };

    controllerRef.current = isTrigger
      ? api.streamTriggerPlanV2(pieceName, actionName, callbacks, memory)
      : useV2
      ? api.streamAiPlanV2(pieceName, actionName, callbacks, memory)
      : api.streamAiPlan(pieceName, actionName, callbacks, memory);
  }, [pieceName, actionName, plan, useV2, isTrigger, targetKind]);

  // ── Execute plan ──
  const runPlan = useCallback(() => {
    if (!plan) return;
    controllerRef.current?.abort();
    setExecuting(true);
    setExecutionDone(false);
    setStepResults([]);
    setPausedInfo(null);

    controllerRef.current = api.streamPlanExecution(plan.id, {
      onProgress: (progress: PlanProgress) => {
        if (progress.stepResults) {
          setStepResults([...progress.stepResults]);
        }
        if (progress.runId) setCurrentRunId(progress.runId);
        if (progress.type === 'paused_for_human') {
          setPausedInfo({ stepId: progress.stepId!, prompt: progress.pausedPrompt || '', type: 'human' });
        } else if (progress.type === 'paused_for_approval') {
          setPausedInfo({ stepId: progress.stepId!, prompt: progress.pausedPrompt || '', type: 'approval' });
        } else {
          setPausedInfo(null);
        }
      },
      onDone: (data) => {
        setStepResults(data.step_results || []);
        setCurrentRunId(data.runId);
        setExecuting(false);
        setExecutionDone(true);
      },
      onError: (msg) => {
        setAgentLogs(prev => [...prev, { timestamp: Date.now(), type: 'error', message: msg }]);
        setExecuting(false);
        setExecutionDone(true);
      },
    });
  }, [plan]);

  // ── Respond to paused run ──
  const respondToRun = useCallback(async (approved?: boolean) => {
    if (!currentRunId || !pausedInfo) return;
    try {
      const response = pausedInfo.type === 'human' ? humanInput : undefined;
      await api.respondToPlanRun(currentRunId, {
        stepId: pausedInfo.stepId,
        approved,
        humanResponse: response,
      });

      // Save human response into the plan step for future runs
      if (saveHumanInput && pausedInfo.type === 'human' && response && plan) {
        const updatedSteps = (plan.steps || []).map(s =>
          s.id === pausedInfo.stepId ? { ...s, savedHumanResponse: response } : s
        );
        try {
          const updated = await api.updateTestPlan(plan.id, { steps: updatedSteps });
          setPlan(updated);
          setEditedSteps(updated.steps);
        } catch (err: any) {
          console.warn('Failed to save human response to plan:', err.message);
        }
      }

      setPausedInfo(null);
      setHumanInput('');
    } catch (err: any) {
      console.error('Failed to respond:', err);
    }
  }, [currentRunId, pausedInfo, humanInput, saveHumanInput, plan]);

  // ── Save edited steps ──
  const saveEdits = useCallback(async () => {
    if (!plan) return;
    try {
      const updated = await api.updateTestPlan(plan.id, { steps: editedSteps });
      setPlan(updated);
      setEditMode(false);
      setInputDrafts({});
      setInputErrors({});
      onPlanChange?.(updated);
    } catch (err: any) {
      console.error('Failed to save plan:', err);
    }
  }, [plan, editedSteps, onPlanChange]);

  // Update a single field on a step being edited.
  const patchStep = useCallback((stepId: string, patch: Partial<TestPlanStep>) => {
    setEditedSteps(prev => prev.map(s => s.id === stepId ? { ...s, ...patch } : s));
  }, []);

  // ── Approve plan ──
  const approvePlan = useCallback(async () => {
    if (!plan) return;
    try {
      const updated = await api.updateTestPlan(plan.id, { status: 'approved' });
      setPlan(updated);
      onPlanChange?.(updated);
    } catch (err: any) {
      console.error('Failed to approve:', err);
    }
  }, [plan, onPlanChange]);

  // ── Delete plan ──
  const deletePlan = useCallback(async () => {
    if (!plan) return;
    try {
      await api.deleteTestPlan(plan.id);
      setPlan(null);
      setEditedSteps([]);
      setStepResults([]);
      setExecutionDone(false);
      onPlanChange?.(null);
    } catch (err: any) {
      console.error('Failed to delete:', err);
    }
  }, [plan, onPlanChange]);

  // ── Lesson management ──
  const refreshLessons = useCallback(async () => {
    try { setLessons(await api.getLessons(pieceName)); } catch { /* non-critical */ }
  }, [pieceName]);

  const removelesson = useCallback(async (id: number) => {
    try {
      await api.deleteLesson(pieceName, id);
      setLessons(prev => prev.filter(l => l.id !== id));
    } catch (err: any) { console.error(err); }
  }, [pieceName]);

  // ── Inline edit saved human response ──
  const saveInlineResponse = useCallback(async (stepId: string, newValue: string) => {
    if (!plan) return;
    const updatedSteps = plan.steps.map(s =>
      s.id === stepId ? { ...s, savedHumanResponse: newValue || undefined } : s
    );
    try {
      const updated = await api.updateTestPlan(plan.id, { steps: updatedSteps });
      setPlan(updated);
      setEditedSteps(updated.steps);
      onPlanChange?.(updated);
      setEditingResponseStepId(null);

      // After saving, check if other plans in this piece ask the same question
      if (newValue) {
        const thisStep = plan.steps.find(s => s.id === stepId);
        if (thisStep?.humanPrompt) {
          try {
            const allPlans = await api.listTestPlans(pieceName);
            const matches: Array<{ planId: number; actionName: string; stepId: string }> = [];
            for (const p of allPlans) {
              if (p.id === plan.id) continue;
              for (const s of (p.steps || [])) {
                if (s.type === 'human_input' && s.humanPrompt === thisStep.humanPrompt
                    && s.savedHumanResponse !== newValue) {
                  matches.push({ planId: p.id, actionName: p.target_action, stepId: s.id });
                }
              }
            }
            if (matches.length > 0) {
              setPropagateOffer({ prompt: thisStep.humanPrompt, value: newValue, matches });
            }
          } catch { /* non-critical */ }
        }
      }
    } catch (err: any) {
      console.error('Failed to save response:', err);
    }
  }, [plan, pieceName, onPlanChange]);

  // ── Propagate saved response to other plans ──
  const propagateToOthers = useCallback(async () => {
    if (!propagateOffer) return;
    try {
      for (const match of propagateOffer.matches) {
        const targetPlan = await api.getTestPlan(match.planId);
        if (!targetPlan) continue;
        const updatedSteps = targetPlan.steps.map((s: TestPlanStep) =>
          s.id === match.stepId ? { ...s, savedHumanResponse: propagateOffer.value } : s
        );
        await api.updateTestPlan(match.planId, { steps: updatedSteps });
      }
      setPropagateOffer(null);
    } catch (err: any) {
      console.error('Failed to propagate:', err);
    }
  }, [propagateOffer]);

  // ── Fix plan with AI after failure ──
  const fixPlan = useCallback(() => {
    if (!plan || stepResults.length === 0) return;
    controllerRef.current?.abort();
    setFixing(true);
    setAgentLogs([]);
    setShowLogs(true);
    setCostSummary(null);
    const instruction = fixInstruction.trim() || undefined;

    const callbacks: PlanStreamCallbacks = {
      onLog: (log) => setAgentLogs(prev => [...prev, log]),
      onResult: (result) => {
        if (result.costSummary) setCostSummary(result.costSummary);
        const updatedPlan: TestPlan = {
          ...plan,
          id: result.planId,
          steps: result.steps,
          agent_memory: result.agentMemory || plan.agent_memory,
          updated_at: new Date().toISOString(),
        };
        setPlan(updatedPlan);
        setEditedSteps(result.steps);
        setStepResults([]);
        setExecutionDone(false);
        onPlanChange?.(updatedPlan);
      },
      onError: (msg) => setAgentLogs(prev => [...prev, { timestamp: Date.now(), type: 'error', message: msg }]),
      onDone: () => { setFixing(false); refreshLessons(); },
    };

    controllerRef.current = isTrigger
      ? api.streamTriggerPlanFixV2(pieceName, actionName, plan.steps, stepResults, plan.agent_memory || undefined, callbacks, instruction)
      : useV2
      ? api.streamAiPlanFixV2(pieceName, actionName, plan.steps, stepResults, plan.agent_memory || undefined, callbacks, instruction)
      : api.streamAiPlanFix(pieceName, actionName, plan.steps, stepResults, plan.agent_memory || undefined, callbacks);
  }, [pieceName, actionName, plan, stepResults, useV2, isTrigger, fixInstruction]);

  /** Stop client stream and cancel server-side background plan job (if any). */
  const stopPlanAi = useCallback(() => {
    controllerRef.current?.abort();
    if (creating) {
      const cancel = isTrigger
        ? api.cancelTriggerPlanV2Job(pieceName, actionName)
        : api.cancelAiPlanJob(pieceName, actionName, useV2);
      void cancel.catch(() => {});
    }
    setCreating(false);
    setFixing(false);
    setAgentLogs(prev => [...prev, { timestamp: Date.now(), type: 'error', message: 'AI stopped.' }]);
  }, [pieceName, actionName, useV2, creating, isTrigger]);

  // Cleanup on unmount
  useEffect(() => () => { controllerRef.current?.abort(); }, []);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  const steps = editMode ? editedSteps : (plan?.steps || []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-sm">Test Plan: {actionDisplayName}</h3>
          {plan && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              plan.status === 'approved' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
            }`}>
              {plan.status === 'approved' ? 'Approved' : 'Draft'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {plan && !editMode && !executing && (
            <>
              <button onClick={() => { setEditMode(true); setEditedSteps(plan.steps); setInputDrafts({}); setInputErrors({}); }}
                className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 flex items-center gap-1">
                <Edit3 size={10} /> Edit
              </button>
              <button onClick={deletePlan}
                className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 flex items-center gap-1">
                <Trash2 size={10} /> Delete
              </button>
            </>
          )}
          {editMode && (
            <>
              <button onClick={saveEdits}
                className="text-xs text-green-400 hover:text-green-300 px-2 py-1 rounded bg-green-500/10 hover:bg-green-500/20 flex items-center gap-1">
                <Save size={10} /> Save
              </button>
              <button onClick={() => { setEditMode(false); setEditedSteps(plan?.steps || []); setInputDrafts({}); setInputErrors({}); }}
                className="text-xs text-gray-400 hover:text-gray-300 px-2 py-1 rounded bg-gray-800 hover:bg-gray-700">
                Cancel
              </button>
            </>
          )}
          {/* Lessons toggle */}
          <button onClick={() => setShowLessons(!showLessons)}
            className={`text-[10px] px-2 py-1 rounded flex items-center gap-1 transition-colors ${
              lessons.length > 0
                ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/30'
                : 'bg-gray-800 text-gray-500 hover:bg-gray-700 hover:text-gray-400'
            }`}
            title={lessons.length > 0 ? `${lessons.length} learned lesson(s) active` : 'No lessons yet — accumulates after AI fixes'}
          >
            <Lightbulb size={10} />
            {lessons.length > 0 ? `${lessons.length} lesson${lessons.length > 1 ? 's' : ''}` : 'No lessons'}
          </button>

          {(creating || fixing) && (
            <button
              type="button"
              onClick={stopPlanAi}
              className="text-[10px] text-red-300 hover:text-red-200 px-2 py-1 rounded bg-red-500/15 border border-red-500/30 hover:bg-red-500/25 flex items-center gap-1"
              title="Stop this AI run (cancels Claude + plan execution on the server for background jobs)"
            >
              <Square size={10} /> Stop AI
            </button>
          )}
          {(agentLogs.length > 0 || creating) && (
            <button onClick={() => setShowLogs(!showLogs)}
              className="text-[10px] text-gray-400 hover:text-gray-200 px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 flex items-center gap-1">
              <Terminal size={10} /> {showLogs ? 'Hide' : 'Show'} Logs
            </button>
          )}
          {onClose && (
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Lessons panel */}
      {showLessons && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-amber-500/20">
            <div className="flex items-center gap-2">
              <Lightbulb size={12} className="text-amber-400" />
              <span className="text-xs font-medium text-amber-300">Learned Lessons for this piece</span>
              <span className="text-[10px] text-gray-500">— automatically injected into AI prompts</span>
            </div>
            <button onClick={() => setShowLessons(false)} className="text-gray-600 hover:text-gray-400">
              <X size={10} />
            </button>
          </div>

          {lessons.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <BookOpen size={20} className="mx-auto mb-2 text-gray-600" />
              <p className="text-xs text-gray-500">No lessons yet.</p>
              <p className="text-[10px] text-gray-600 mt-1">
                Lessons are automatically extracted whenever the AI fixes a failing plan.<br/>
                They accumulate over time and make future plans smarter.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-amber-500/10">
              {lessons.map(l => (
                <div key={l.id} className="flex items-start gap-2 px-3 py-2 group">
                  <span className="text-amber-400 mt-0.5 text-[10px] shrink-0">
                    {l.source === 'manual' ? '✏️' : '🔧'}
                  </span>
                  <span className="text-xs text-gray-300 flex-1">{l.lesson}</span>
                  <button
                    onClick={() => removelesson(l.id)}
                    className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-opacity shrink-0"
                    title="Delete this lesson"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* No plan -- create one */}
      {!plan && !creating && (
        <div className="text-center py-8 border border-dashed border-gray-700 rounded-lg">
          <Brain size={32} className="mx-auto mb-3 text-gray-600" />
          <p className="text-gray-400 text-sm mb-3">No test plan exists for this {isTrigger ? 'trigger' : 'action'} yet.</p>
          {hasAnthropicKey ? (
            <div className="flex flex-col items-center gap-3">
              <button onClick={createPlan}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded flex items-center gap-2">
                <Brain size={14} /> Create Plan with AI
              </button>
              {!isTrigger && (
                <button
                  onClick={() => setUseV2(!useV2)}
                  className={`text-xs px-2 py-1 rounded flex items-center gap-1.5 transition-colors ${
                    useV2
                      ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                      : 'bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-400'
                  }`}
                  title={useV2 ? 'v2: Multi-agent (research → plan → verify)' : 'v1: Single agent loop'}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${useV2 ? 'bg-purple-400' : 'bg-gray-600'}`} />
                  {useV2 ? 'v2 Multi-Agent' : 'v1 Classic'}
                </button>
              )}
            </div>
          ) : (
            <p className="text-yellow-500 text-xs">Configure Anthropic API key in Settings first.</p>
          )}
        </div>
      )}

      {/* Creating animation */}
      {creating && !plan && (
        <div className="text-center py-8">
          <Loader2 size={24} className="animate-spin text-purple-400 mx-auto mb-3" />
          <p className="text-purple-300 text-sm">AI is designing the test plan...</p>
        </div>
      )}

      {/* Step timeline */}
      {steps.length > 0 && (
        <div className="space-y-1">
          {steps.map((step, idx) => {
            const typeConfig = STEP_TYPE_CONFIG[step.type] || STEP_TYPE_CONFIG.setup;
            const sr = stepResults.find(r => r.stepId === step.id);
            const isExpanded = expandedStep === step.id;
            const isPaused = pausedInfo?.stepId === step.id;

            return (
              <div key={step.id} className={`rounded-lg border ${
                isPaused ? 'border-yellow-500/50 bg-yellow-500/5' :
                sr?.status === 'failed' ? 'border-red-500/30 bg-red-500/5' :
                sr?.status === 'assert_failed' ? 'border-amber-500/40 bg-amber-500/5' :
                sr?.status === 'completed' ? 'border-green-500/20 bg-green-500/5' :
                sr?.status === 'running' ? 'border-blue-500/30 bg-blue-500/5' :
                'border-gray-800 bg-gray-900'
              }`}>
                {/* Step header */}
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer"
                  onClick={() => setExpandedStep(isExpanded ? null : step.id)}
                >
                  {/* Step number */}
                  <span className="text-[10px] text-gray-600 w-4 text-right">{idx + 1}</span>

                  {/* Status icon */}
                  {sr ? STEP_STATUS_ICON[sr.status] || STEP_STATUS_ICON.pending : STEP_STATUS_ICON.pending}

                  {/* Type badge */}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${typeConfig.bg} ${typeConfig.color} ${typeConfig.border} border`}>
                    {typeConfig.label}
                  </span>

                  {/* Label */}
                  <span className="text-sm flex-1 truncate">{step.label}</span>

                  {/* Duration */}
                  {sr && sr.duration_ms > 0 && (
                    <span className="text-[10px] text-gray-500">{(sr.duration_ms / 1000).toFixed(1)}s</span>
                  )}

                  {/* Approval badge */}
                  {step.requiresApproval && (
                    <Shield size={12} className="text-yellow-500" />
                  )}

                  {/* Expand chevron */}
                  {isExpanded ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 text-xs space-y-2 border-t border-gray-800/50">
                    {/* Label (editable) */}
                    {editMode ? (
                      <div>
                        <span className="text-gray-500 font-medium">Label:</span>
                        <input
                          className="w-full mt-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                          value={step.label}
                          onChange={(e) => patchStep(step.id, { label: e.target.value })}
                        />
                      </div>
                    ) : (
                      step.description && <p className="text-gray-400">{step.description}</p>
                    )}

                    {/* Description (editable) */}
                    {editMode && (
                      <div>
                        <span className="text-gray-500 font-medium">Description:</span>
                        <textarea
                          className="w-full mt-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 resize-y"
                          rows={2}
                          value={step.description}
                          onChange={(e) => patchStep(step.id, { description: e.target.value })}
                        />
                      </div>
                    )}

                    {/* Action / trigger target */}
                    {step.kind === 'trigger' ? (
                      <div className="text-gray-500">
                        <span className="font-medium">Trigger:</span>{' '}
                        <code className="text-gray-300">{step.triggerName || step.actionName}</code>
                        {step.triggerStrategy && <span className="text-gray-600 ml-1">({step.triggerStrategy})</span>}
                      </div>
                    ) : step.actionName ? (
                      editMode ? (
                        <div>
                          <span className="text-gray-500 font-medium">Action:</span>
                          <input
                            className="w-full mt-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-200"
                            value={step.actionName}
                            onChange={(e) => patchStep(step.id, { actionName: e.target.value })}
                          />
                        </div>
                      ) : (
                        <div className="text-gray-500">
                          <span className="font-medium">Action:</span> <code className="text-gray-300">{step.actionName}</code>
                        </div>
                      )
                    ) : null}

                    {/* Static input — always editable in edit mode (even when empty) */}
                    {(editMode || Object.keys(step.input).length > 0) && (
                      <div>
                        <span className="text-gray-500 font-medium">Input:</span>
                        {editMode ? (
                          <>
                            <textarea
                              className={`w-full mt-1 bg-gray-800 border rounded p-2 text-xs font-mono text-gray-300 resize-y ${inputErrors[step.id] ? 'border-red-500/60' : 'border-gray-700'}`}
                              rows={4}
                              value={inputDrafts[step.id] ?? JSON.stringify(step.input, null, 2)}
                              onChange={(e) => {
                                const text = e.target.value;
                                setInputDrafts(prev => ({ ...prev, [step.id]: text }));
                                try {
                                  const parsed = JSON.parse(text);
                                  patchStep(step.id, { input: parsed });
                                  setInputErrors(prev => ({ ...prev, [step.id]: false }));
                                } catch {
                                  setInputErrors(prev => ({ ...prev, [step.id]: true }));
                                }
                              }}
                            />
                            {inputErrors[step.id] && <span className="text-[10px] text-red-400">Invalid JSON — last valid value will be kept.</span>}
                          </>
                        ) : (
                          <pre className="mt-1 bg-gray-800/50 rounded p-2 overflow-x-auto text-gray-300 font-mono">
                            {JSON.stringify(step.input, null, 2)}
                          </pre>
                        )}
                      </div>
                    )}

                    {/* Input mapping — editable field→expression rows in edit mode */}
                    {editMode ? (
                      <div>
                        <span className="text-gray-500 font-medium">Dynamic mapping</span>
                        <span className="text-gray-600 ml-1">(field ← ${'{steps.<id>.output.<path>}'})</span>
                        <div className="mt-1 space-y-1">
                          {Object.entries(step.inputMapping || {}).map(([field, expr], mi) => (
                            <div key={mi} className="flex items-center gap-1.5">
                              <input
                                className="w-1/3 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] font-mono text-cyan-300"
                                value={field}
                                placeholder="field"
                                onChange={(e) => {
                                  const m = { ...(step.inputMapping || {}) };
                                  const val = m[field];
                                  delete m[field];
                                  m[e.target.value] = val;
                                  patchStep(step.id, { inputMapping: m });
                                }}
                              />
                              <span className="text-gray-600">&larr;</span>
                              <input
                                className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] font-mono text-purple-300"
                                value={expr}
                                placeholder="${steps.step_1.output.id}"
                                onChange={(e) => patchStep(step.id, { inputMapping: { ...(step.inputMapping || {}), [field]: e.target.value } })}
                              />
                              <button
                                onClick={() => { const m = { ...(step.inputMapping || {}) }; delete m[field]; patchStep(step.id, { inputMapping: m }); }}
                                className="text-red-400 hover:text-red-300"
                                title="Remove mapping"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          ))}
                          <button
                            onClick={() => patchStep(step.id, { inputMapping: { ...(step.inputMapping || {}), '': '' } })}
                            className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                          >
                            <Plus size={10} /> Add mapping
                          </button>
                        </div>
                      </div>
                    ) : (
                      (() => {
                        const entries = Object.entries(step.inputMapping || {});
                        if (entries.length === 0) return null;
                        return (
                          <div>
                            <span className="text-gray-500 font-medium">Dynamic mapping:</span>
                            <div className="mt-1 space-y-0.5">
                              {entries.map(([field, expr]) => (
                                <div key={field} className="flex items-center gap-2 text-gray-400">
                                  <code className="text-cyan-400">{field}</code>
                                  <span className="text-gray-600">&larr;</span>
                                  <code className="text-purple-400">{expr}</code>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()
                    )}

                    {/* Human prompt (for human_input steps) */}
                    {step.type === 'human_input' && step.humanPrompt && (
                      <div className="bg-purple-500/10 border border-purple-500/20 rounded p-2 text-purple-300">
                        <MessageSquare size={12} className="inline mr-1" />
                        {step.humanPrompt}
                      </div>
                    )}

                    {/* Saved human response — inline editable */}
                    {step.type === 'human_input' && (
                      <div className="bg-green-500/10 border border-green-500/20 rounded p-2">
                        {editingResponseStepId === step.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              autoFocus
                              type="text"
                              value={editingResponseValue}
                              onChange={e => setEditingResponseValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveInlineResponse(step.id, editingResponseValue);
                                if (e.key === 'Escape') setEditingResponseStepId(null);
                              }}
                              className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs font-mono text-gray-200 focus:outline-none focus:border-green-500"
                              placeholder="Enter value..."
                            />
                            <button
                              onClick={e => { e.stopPropagation(); saveInlineResponse(step.id, editingResponseValue); }}
                              className="text-[10px] px-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded"
                            >Save</button>
                            <button
                              onClick={e => { e.stopPropagation(); setEditingResponseStepId(null); }}
                              className="text-[10px] px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded"
                            >Cancel</button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-xs text-green-300">
                              <Save size={11} className="flex-shrink-0" />
                              {step.savedHumanResponse ? (
                                <span>Saved: <code className="bg-gray-800 px-1 py-0.5 rounded text-green-200">{step.savedHumanResponse}</code></span>
                              ) : (
                                <span className="text-gray-500 italic">No saved value — will pause for input each run</span>
                              )}
                            </div>
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                setEditingResponseStepId(step.id);
                                setEditingResponseValue(step.savedHumanResponse || '');
                              }}
                              className="text-[10px] text-gray-400 hover:text-gray-200 px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 flex items-center gap-1"
                            >
                              <Edit3 size={9} /> {step.savedHumanResponse ? 'Change' : 'Set value'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Live step logs (e.g. webhook subscribe/receive) */}
                    {sr?.logs && sr.logs.length > 0 && (
                      <div>
                        <span className="text-gray-400 font-medium">Logs:</span>
                        <pre className="mt-1 bg-gray-800/50 rounded p-2 overflow-x-auto text-gray-300/80 font-mono max-h-40 overflow-y-auto whitespace-pre-wrap">
                          {sr.logs.join('\n')}
                        </pre>
                      </div>
                    )}

                    {/* Step result output (shown for a clean pass AND an assertion failure) */}
                    {sr?.output != null && (sr.status === 'completed' || sr.status === 'assert_failed') && (
                      <div>
                        <span className={`font-medium ${sr.status === 'assert_failed' ? 'text-amber-400' : 'text-green-500'}`}>Output:</span>
                        <pre className={`mt-1 bg-gray-800/50 rounded p-2 overflow-x-auto font-mono max-h-40 overflow-y-auto ${
                          sr.status === 'assert_failed' ? 'text-amber-200/80' : 'text-green-300/80'
                        }`}>
                          {typeof sr.output === 'string' ? sr.output : String(JSON.stringify(sr.output, null, 2))}
                        </pre>
                      </div>
                    )}

                    {/* Output assertions (the oracle) — results after a run, or the defined checks before */}
                    {!editMode && <AssertionResultsView results={sr?.assertions} defined={step.assertions} />}

                    {/* Step error (thrown). For assert_failed the amber assertion list above tells the story. */}
                    {sr?.error && sr.status !== 'assert_failed' && (
                      <div className="bg-red-500/10 border border-red-500/20 rounded p-2 text-red-300 font-mono">
                        {sr.errorCategory && (
                          <span className={`inline-block mb-1 mr-2 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${ERROR_CATEGORY_LABELS[sr.errorCategory]?.cls || ''}`}>
                            {ERROR_CATEGORY_LABELS[sr.errorCategory]?.label || sr.errorCategory}
                          </span>
                        )}
                        {sr.error}
                      </div>
                    )}

                    {/* Assertions editor (the oracle) — author what "correct output" means */}
                    {editMode && step.type !== 'human_input' && step.type !== 'trigger_arm' && (
                      <AssertionsEditor
                        assertions={step.assertions}
                        availablePaths={sr?.output != null ? Array.from(new Set(collectLeafPaths(sr.output))).slice(0, 200) : []}
                        onChange={(a) => patchStep(step.id, { assertions: a })}
                      />
                    )}

                    {/* Edit controls */}
                    {editMode && (
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditedSteps(prev => prev.filter(s => s.id !== step.id)); }}
                          className="text-[10px] text-red-400 hover:text-red-300 flex items-center gap-1"
                        >
                          <Trash2 size={10} /> Remove step
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Paused: Human input form */}
                {isPaused && pausedInfo.type === 'human' && (
                  <div className="px-3 pb-3 border-t border-yellow-500/20">
                    <div className="mt-2 bg-yellow-500/10 border border-yellow-500/20 rounded p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <MessageSquare size={14} className="text-yellow-400" />
                        <span className="text-sm font-medium text-yellow-300">Input Required</span>
                      </div>
                      <p className="text-xs text-gray-300 mb-2">{pausedInfo.prompt}</p>
                      {/* Show saved response if available */}
                      {step.savedHumanResponse && (
                        <div className="mb-2 flex items-center gap-2 text-xs bg-gray-800/50 rounded p-2">
                          <Save size={10} className="text-green-400 flex-shrink-0" />
                          <span className="text-gray-400">Previously saved:</span>
                          <span className="text-gray-200 font-mono">{step.savedHumanResponse}</span>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={humanInput}
                          onChange={e => setHumanInput(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') respondToRun(true); }}
                          className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200"
                          placeholder="Type your response..."
                          autoFocus
                        />
                        <button onClick={() => respondToRun(true)}
                          className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white text-xs rounded flex items-center gap-1">
                          <Check size={12} /> Submit
                        </button>
                      </div>
                      <label className="flex items-center gap-2 mt-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={saveHumanInput}
                          onChange={e => setSaveHumanInput(e.target.checked)}
                          className="rounded border-gray-600"
                        />
                        <span className="text-[10px] text-gray-400">Save response for future runs (scheduled/automated)</span>
                      </label>
                    </div>
                  </div>
                )}

                {/* Paused: Approval prompt */}
                {isPaused && pausedInfo.type === 'approval' && (
                  <div className="px-3 pb-3 border-t border-yellow-500/20">
                    <div className="mt-2 bg-yellow-500/10 border border-yellow-500/20 rounded p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Shield size={14} className="text-yellow-400" />
                        <span className="text-sm font-medium text-yellow-300">Approval Required</span>
                      </div>
                      <p className="text-xs text-gray-300 mb-3">{pausedInfo.prompt}</p>
                      <div className="flex gap-2">
                        <button onClick={() => respondToRun(true)}
                          className="px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs rounded flex items-center gap-1">
                          <Check size={12} /> Approve & Continue
                        </button>
                        <button onClick={() => respondToRun(false)}
                          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded flex items-center gap-1">
                          <X size={12} /> Skip Step
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Cross-plan propagation offer */}
      {propagateOffer && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-xs">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-blue-300 font-medium mb-1">Same question found in {propagateOffer.matches.length} other action{propagateOffer.matches.length > 1 ? 's' : ''}</p>
              <p className="text-gray-400 mb-1.5">
                <span className="text-gray-300">"{propagateOffer.prompt}"</span>
              </p>
              <div className="flex flex-wrap gap-1 mb-2">
                {propagateOffer.matches.map(m => (
                  <code key={`${m.planId}-${m.stepId}`} className="bg-gray-800 px-1.5 py-0.5 rounded text-[10px] text-gray-300">
                    {m.actionName}
                  </code>
                ))}
              </div>
              <p className="text-gray-500">Apply <code className="bg-gray-800 px-1 py-0.5 rounded text-blue-200">{propagateOffer.value}</code> to all of them?</p>
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button
                onClick={propagateToOthers}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-[10px] font-medium whitespace-nowrap"
              >Apply to all</button>
              <button
                onClick={() => setPropagateOffer(null)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-[10px] whitespace-nowrap"
              >Skip</button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-test progress (shown while creating, after plan is received) */}
      {creating && plan && (
        <div className={`rounded-lg border p-3 text-xs ${
          autoTestPassed === true
            ? 'border-green-500/30 bg-green-500/5'
            : 'border-blue-500/20 bg-blue-500/5'
        }`}>
          <div className="flex items-center gap-2 mb-2">
            {autoTestPassed === true ? (
              <><CheckCircle size={13} className="text-green-400" /><span className="text-green-300 font-medium">Auto-test passed — plan is verified!</span></>
            ) : (
              <><Loader2 size={13} className="animate-spin text-blue-400" /><span className="text-blue-300 font-medium">Auto-testing plan...</span></>
            )}
          </div>
          {autoTestResults.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {autoTestResults.map(sr => {
                const step = plan.steps.find(s => s.id === sr.stepId);
                const color = sr.status === 'completed' ? 'bg-green-500/20 text-green-400 border-green-500/30'
                  : sr.status === 'failed' ? 'bg-red-500/20 text-red-400 border-red-500/30'
                  : sr.status === 'assert_failed' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                  : sr.status === 'running' ? 'bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse'
                  : sr.status === 'skipped' ? 'bg-gray-700/50 text-gray-500 border-gray-700'
                  : 'bg-gray-800 text-gray-600 border-gray-700';
                return (
                  <span key={sr.stepId} className={`px-2 py-0.5 rounded border text-[10px] font-medium ${color}`}
                    title={sr.error || undefined}>
                    {step?.label || sr.stepId}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      {plan && !editMode && (
        <div className="flex items-center gap-2 pt-2">
          {!executing && !fixing ? (
            <>
              <button onClick={runPlan}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded flex items-center gap-2 font-medium">
                <Play size={14} /> Run Plan
              </button>
              {plan.status === 'draft' && (
                <button onClick={approvePlan}
                  className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-sm rounded flex items-center gap-2">
                  <Check size={14} /> Approve
                </button>
              )}
              <button onClick={createPlan}
                className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-sm rounded flex items-center gap-2 text-gray-400">
                <RotateCcw size={14} /> Regenerate
              </button>
              {!isTrigger && (
                <button
                  onClick={() => setUseV2(!useV2)}
                  className={`px-2 py-2 text-xs rounded flex items-center gap-1.5 transition-colors ${
                    useV2
                      ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                      : 'bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-400'
                  }`}
                  title={useV2 ? 'v2: Multi-agent system (research → plan → verify)' : 'v1: Single agent loop'}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${useV2 ? 'bg-purple-400' : 'bg-gray-600'}`} />
                  {useV2 ? 'v2' : 'v1'}
                </button>
              )}
            </>
          ) : executing ? (
            <div className="flex items-center gap-2 text-sm text-blue-400">
              <Loader2 size={14} className="animate-spin" />
              <span>Executing plan...</span>
              <button onClick={() => {
                controllerRef.current?.abort();
                setExecuting(false);
                setExecutionDone(false);
                setPausedInfo(null);
              }}
                className="px-2 py-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded text-xs">
                Abort
              </button>
            </div>
          ) : fixing ? (
            <div className="flex items-center gap-2 text-sm text-purple-400">
              <Loader2 size={14} className="animate-spin" />
              <span>AI is analyzing failure and fixing the plan...</span>
              <button onClick={() => {
                controllerRef.current?.abort();
                setFixing(false);
                setExecutionDone(true);
              }}
                className="px-2 py-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded text-xs">
                Abort
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* Execution summary */}
      {executionDone && stepResults.length > 0 && (() => {
        const threw = stepResults.filter(r => r.status === 'failed');
        const asserted = stepResults.filter(r => r.status === 'assert_failed');
        const hasFailed = threw.length > 0 || asserted.length > 0;
        const allOk = stepResults.every(r => r.status === 'completed' || r.status === 'skipped');
        const onlyAssert = asserted.length > 0 && threw.length === 0;
        const containerCls = allOk
          ? 'bg-green-500/10 border border-green-500/20 text-green-300'
          : onlyAssert
            ? 'bg-amber-500/10 border border-amber-500/30 text-amber-200'
            : 'bg-red-500/10 border border-red-500/20 text-red-300';
        return (
          <div className={`rounded-lg p-3 text-sm ${containerCls}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium">
                {allOk
                  ? <><CheckCircle size={16} /> All steps passed — output assertions held</>
                  : onlyAssert
                    ? <><AlertTriangle size={16} /> Ran, but output didn't match expectations</>
                    : <><XCircle size={16} /> Plan execution failed</>}
              </div>

              {/* Fix with AI button (actions + triggers) */}
              {hasFailed && hasAnthropicKey && !fixing && (
                <button onClick={fixPlan}
                  className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded flex items-center gap-1.5 font-medium">
                  <Wrench size={12} /> Fix with AI
                </button>
              )}
              {fixing && (
                <span className="text-xs text-purple-400 flex items-center gap-1.5 animate-pulse">
                  <Loader2 size={12} className="animate-spin" /> AI fixing plan...
                </span>
              )}
            </div>

            {/* Optional hint to steer the AI fixer */}
            {hasFailed && hasAnthropicKey && !fixing && (
              <div className="mt-2">
                <textarea
                  value={fixInstruction}
                  onChange={e => setFixInstruction(e.target.value)}
                  rows={2}
                  placeholder="Suggestions for the AI fix (optional) — e.g. 'the id is at data[0].id', 'use the Create Contact action as the generator', 'assert email exists'"
                  className="w-full bg-gray-900/60 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 resize-y focus:outline-none focus:border-purple-500/60"
                />
              </div>
            )}
            <div className="flex flex-wrap gap-4 mt-1 text-xs">
              <span>Total: {stepResults.length}</span>
              <span className="text-green-400">Passed: {stepResults.filter(r => r.status === 'completed').length}</span>
              {asserted.length > 0 && <span className="text-amber-300">Output mismatch: {asserted.length}</span>}
              <span className="text-red-400">Errored: {threw.length}</span>
              <span className="text-gray-400">Skipped: {stepResults.filter(r => r.status === 'skipped').length}</span>
            </div>

            {/* Failed step details — assertion failures (amber) and thrown errors (red, with category) */}
            {hasFailed && (
              <div className="mt-2 space-y-1">
                {asserted.map(r => {
                  const step = (plan?.steps || []).find(s => s.id === r.stepId);
                  return (
                    <div key={r.stepId} className="text-xs bg-amber-500/5 rounded p-2 border border-amber-500/20">
                      <span className="font-medium text-amber-300">{step?.label || r.stepId}:</span>{' '}
                      <span className="text-amber-200/80 font-mono">{r.error?.slice(0, 240)}</span>
                    </div>
                  );
                })}
                {threw.map(r => {
                  const step = (plan?.steps || []).find(s => s.id === r.stepId);
                  const cat = r.errorCategory ? ERROR_CATEGORY_LABELS[r.errorCategory] : undefined;
                  return (
                    <div key={r.stepId} className="text-xs bg-red-500/5 rounded p-2 border border-red-500/10">
                      <span className="font-medium text-red-300">{step?.label || r.stepId}:</span>{' '}
                      {cat && (
                        <span className={`inline-block mr-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${cat.cls}`}>
                          {cat.label}
                        </span>
                      )}
                      <span className="text-red-400/80 font-mono">{r.error?.slice(0, 200)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* Cost summary banner */}
      {costSummary && !creating && !fixing && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-green-500/20 bg-green-500/5 text-xs">
          <span className="text-green-400 font-semibold">
            ${costSummary.cost_usd < 0.01 ? costSummary.cost_usd.toFixed(4) : costSummary.cost_usd.toFixed(2)}
          </span>
          <span className="text-gray-500">|</span>
          <span className="text-gray-400">
            {((costSummary.input_tokens + costSummary.output_tokens) / 1000).toFixed(1)}K tokens
          </span>
          <span className="text-gray-600 text-[10px]">
            ({(costSummary.input_tokens / 1000).toFixed(1)}K in / {(costSummary.output_tokens / 1000).toFixed(1)}K out)
          </span>
          <span className="text-gray-500">|</span>
          <span className="text-gray-400">{costSummary.requests} API call{costSummary.requests !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Agent logs panel */}
      {showLogs && agentLogs.length > 0 && (
        <div className="bg-gray-950 border border-gray-800 rounded-lg max-h-60 overflow-y-auto">
          <div className="p-2 border-b border-gray-800 flex items-center justify-between">
            <span className="text-[10px] text-gray-500 font-medium uppercase">Agent Logs</span>
            <button onClick={() => setShowLogs(false)} className="text-gray-600 hover:text-gray-400">
              <X size={10} />
            </button>
          </div>
          <div className="p-2 space-y-1">
            {agentLogs.map((log, i) => (
              <div key={i} className={`text-[10px] font-mono ${
                log.type === 'error' ? 'text-red-400' :
                log.type === 'tool_call' ? 'text-cyan-400' :
                log.type === 'tool_result' ? 'text-green-400' :
                log.type === 'decision' ? 'text-yellow-400' :
                log.type === 'worker_spawn' ? 'text-purple-400' :
                log.type === 'worker_complete' ? 'text-purple-300' :
                log.type === 'phase' ? 'text-indigo-400 font-semibold' :
                'text-gray-500'
              }`}>
                <span className="text-gray-700">[{log.role ? `${log.role}:` : ''}{log.type}]</span> {log.message}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}

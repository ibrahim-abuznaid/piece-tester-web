import { useState, useEffect, useRef, useCallback } from 'react';
import {
  api,
  type TestPlanStep, type TestPlan, type StepResult, type PlanProgress,
  type AgentLogEntry, type PlanStreamCallbacks,
} from '../lib/api';
import {
  Play, Loader2, Brain, Check, X, ChevronDown, ChevronRight,
  Trash2, Plus, GripVertical, AlertTriangle, Clock, CheckCircle,
  XCircle, Pause, MessageSquare, Shield, Terminal, Edit3,
  RotateCcw, Save, Wrench, BookOpen, Lightbulb,
} from 'lucide-react';

// ── Step type config ──

const STEP_TYPE_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  setup:       { label: 'Setup',       color: 'text-blue-400',   bg: 'bg-blue-500/10',   border: 'border-blue-500/30' },
  test:        { label: 'Test',        color: 'text-green-400',  bg: 'bg-green-500/10',  border: 'border-green-500/30' },
  verify:      { label: 'Verify',      color: 'text-cyan-400',   bg: 'bg-cyan-500/10',   border: 'border-cyan-500/30' },
  cleanup:     { label: 'Cleanup',     color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/30' },
  human_input: { label: 'Human Input', color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/30' },
};

const STEP_STATUS_ICON: Record<string, JSX.Element> = {
  pending:   <Clock size={14} className="text-gray-500" />,
  running:   <Loader2 size={14} className="text-blue-400 animate-spin" />,
  completed: <CheckCircle size={14} className="text-green-400" />,
  failed:    <XCircle size={14} className="text-red-400" />,
  skipped:   <X size={14} className="text-gray-600" />,
  waiting:   <Pause size={14} className="text-yellow-400" />,
};

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════

interface TestPlanViewProps {
  pieceName: string;
  actionName: string;
  actionDisplayName: string;
  hasAnthropicKey: boolean;
  onClose?: () => void;
  /** Notify parent when plan is created/updated/deleted */
  onPlanChange?: (plan: TestPlan | null) => void;
}

export default function TestPlanView({
  pieceName, actionName, actionDisplayName, hasAnthropicKey, onClose, onPlanChange,
}: TestPlanViewProps) {
  const [plan, setPlan] = useState<TestPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [agentLogs, setAgentLogs] = useState<AgentLogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editedSteps, setEditedSteps] = useState<TestPlanStep[]>([]);
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

  const controllerRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Load existing plan + lessons, and check for active background jobs
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await api.getTestPlanByAction(pieceName, actionName);
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
        const activeJob = jobs[actionName];
        if (activeJob && activeJob.status === 'running') {
          setCreating(true);
          setShowLogs(true);

          const callbacks: PlanStreamCallbacks = {
            onLog: (log) => { if (!cancelled) setAgentLogs(prev => [...prev, log]); },
            onResult: (result) => {
              if (cancelled) return;
              const hasUnfilledHuman = result.steps.some(
                (s: any) => s.type === 'human_input' && !s.savedHumanResponse
              );
              const newPlan: TestPlan = {
                id: result.planId,
                piece_name: pieceName,
                target_action: actionName,
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

          controllerRef.current = api.subscribeAiPlanJob(pieceName, actionName, callbacks);
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

    const memory = plan?.agent_memory || undefined;

    const callbacks: PlanStreamCallbacks = {
      onLog: (log) => setAgentLogs(prev => [...prev, log]),
      onResult: (result) => {
        const hasUnfilledHuman = result.steps.some(
          (s: any) => s.type === 'human_input' && !s.savedHumanResponse
        );
        const newPlan: TestPlan = {
          id: result.planId,
          piece_name: pieceName,
          target_action: actionName,
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

    controllerRef.current = api.streamAiPlan(pieceName, actionName, callbacks, memory);
  }, [pieceName, actionName, plan]);

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
      onPlanChange?.(updated);
    } catch (err: any) {
      console.error('Failed to save plan:', err);
    }
  }, [plan, editedSteps, onPlanChange]);

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

    const callbacks: PlanStreamCallbacks = {
      onLog: (log) => setAgentLogs(prev => [...prev, log]),
      onResult: (result) => {
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

    controllerRef.current = api.streamAiPlanFix(
      pieceName,
      actionName,
      plan.steps,
      stepResults,
      plan.agent_memory || undefined,
      callbacks,
    );
  }, [pieceName, actionName, plan, stepResults]);

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
              <button onClick={() => { setEditMode(true); setEditedSteps(plan.steps); }}
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
              <button onClick={() => { setEditMode(false); setEditedSteps(plan?.steps || []); }}
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
          <p className="text-gray-400 text-sm mb-3">No test plan exists for this action yet.</p>
          {hasAnthropicKey ? (
            <button onClick={createPlan}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded flex items-center gap-2 mx-auto">
              <Brain size={14} /> Create Plan with AI
            </button>
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
                    {step.description && <p className="text-gray-400">{step.description}</p>}

                    {step.actionName && (
                      <div className="text-gray-500">
                        <span className="font-medium">Action:</span> <code className="text-gray-300">{step.actionName}</code>
                      </div>
                    )}

                    {/* Static input */}
                    {Object.keys(step.input).length > 0 && (
                      <div>
                        <span className="text-gray-500 font-medium">Input:</span>
                        {editMode ? (
                          <textarea
                            className="w-full mt-1 bg-gray-800 border border-gray-700 rounded p-2 text-xs font-mono text-gray-300 resize-y"
                            rows={3}
                            value={JSON.stringify(step.input, null, 2)}
                            onChange={(e) => {
                              try {
                                const parsed = JSON.parse(e.target.value);
                                setEditedSteps(prev => prev.map(s => s.id === step.id ? { ...s, input: parsed } : s));
                              } catch { /* ignore invalid JSON while typing */ }
                            }}
                          />
                        ) : (
                          <pre className="mt-1 bg-gray-800/50 rounded p-2 overflow-x-auto text-gray-300 font-mono">
                            {JSON.stringify(step.input, null, 2)}
                          </pre>
                        )}
                      </div>
                    )}

                    {/* Input mapping */}
                    {(() => {
                      const mapping = step.inputMapping || {};
                      const entries = Object.entries(mapping);
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
                    })()}

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

                    {/* Step result output */}
                    {sr?.output != null && sr.status === 'completed' && (
                      <div>
                        <span className="text-green-500 font-medium">Output:</span>
                        <pre className="mt-1 bg-gray-800/50 rounded p-2 overflow-x-auto text-green-300/80 font-mono max-h-40 overflow-y-auto">
                          {typeof sr.output === 'string' ? sr.output : String(JSON.stringify(sr.output, null, 2))}
                        </pre>
                      </div>
                    )}

                    {/* Step error */}
                    {sr?.error && (
                      <div className="bg-red-500/10 border border-red-500/20 rounded p-2 text-red-300 font-mono">
                        {sr.error}
                      </div>
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
        const hasFailed = stepResults.some(r => r.status === 'failed');
        const allOk = stepResults.every(r => r.status === 'completed' || r.status === 'skipped');
        return (
          <div className={`rounded-lg p-3 text-sm ${
            allOk ? 'bg-green-500/10 border border-green-500/20 text-green-300'
                  : 'bg-red-500/10 border border-red-500/20 text-red-300'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium">
                {allOk
                  ? <><CheckCircle size={16} /> All steps completed</>
                  : <><XCircle size={16} /> Plan execution failed</>}
              </div>

              {/* Fix with AI button */}
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
            <div className="flex gap-4 mt-1 text-xs">
              <span>Total: {stepResults.length}</span>
              <span className="text-green-400">Passed: {stepResults.filter(r => r.status === 'completed').length}</span>
              <span className="text-red-400">Failed: {stepResults.filter(r => r.status === 'failed').length}</span>
              <span className="text-gray-400">Skipped: {stepResults.filter(r => r.status === 'skipped').length}</span>
            </div>

            {/* Failed step details */}
            {hasFailed && (
              <div className="mt-2 space-y-1">
                {stepResults.filter(r => r.status === 'failed').map(r => {
                  const step = (plan?.steps || []).find(s => s.id === r.stepId);
                  return (
                    <div key={r.stepId} className="text-xs bg-red-500/5 rounded p-2 border border-red-500/10">
                      <span className="font-medium text-red-300">{step?.label || r.stepId}:</span>{' '}
                      <span className="text-red-400/80 font-mono">{r.error?.slice(0, 200)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

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
                'text-gray-500'
              }`}>
                <span className="text-gray-700">[{log.type}]</span> {log.message}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}

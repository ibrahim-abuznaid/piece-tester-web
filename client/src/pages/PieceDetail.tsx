import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type TestPlan, type AgentLogEntry, type StepResult, type PlanProgress } from '../lib/api';
import TestResultBadge from '../components/TestResultBadge';
import TestPlanView from '../components/TestPlanView';
import {
  ArrowLeft, Play, Loader2, Link2, ExternalLink, Download,
  Clock, Trash2, Check, Wand2, AlertTriangle, ChevronDown,
  ChevronRight, X, Brain, ListChecks, Terminal,
  CheckCircle, XCircle, SkipForward, MessageSquare, Zap,
} from 'lucide-react';

const CONNECTION_TYPES = ['SECRET_TEXT', 'BASIC_AUTH', 'OAUTH2', 'CUSTOM_AUTH', 'NO_AUTH'] as const;

export default function PieceDetail() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // ── Queries ──
  const { data: piece, isLoading, error } = useQuery({
    queryKey: ['piece', name],
    queryFn: () => api.getPiece(name!),
    enabled: !!name,
  });
  const { data: connections } = useQuery({ queryKey: ['connections'], queryFn: api.listConnections });
  // All connections for this piece (active + inactive)
  const { data: pieceConnections } = useQuery({
    queryKey: ['pieceConnections', name],
    queryFn: () => api.listConnectionsForPiece(name!),
    enabled: !!name,
  });
  const localConn = pieceConnections?.find((c: any) => c.is_active) || null;
  const inactiveConns = pieceConnections?.filter((c: any) => !c.is_active) || [];
  const { data: remoteConns, isLoading: loadingRemote } = useQuery({
    queryKey: ['remoteConns', name],
    queryFn: () => api.listRemoteConnectionsForPiece(name!),
    enabled: !!name,
  });
  const { data: dashInfo } = useQuery({ queryKey: ['apDashboard'], queryFn: api.getApDashboardUrl });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });

  // ── Action config state ──
  const [editedInputs, setEditedInputs] = useState<Record<string, Record<string, unknown>>>({});
  const [enabledActions, setEnabledActions] = useState<Set<string>>(new Set());
  const [expandedAction, setExpandedAction] = useState<string | null>(null);
  const [restoredFromDb, setRestoredFromDb] = useState(false);

  // ── Auto-config (basic) ──
  const [autoConfig, setAutoConfig] = useState<any>(null);
  const [loadingAutoConfig, setLoadingAutoConfig] = useState(false);

  // ── Test Plan view (unified AI approach) ──
  const [planAction, setPlanAction] = useState<string | null>(null);
  const [actionPlans, setActionPlans] = useState<Record<string, TestPlan>>({});
  const [setupAllRunning, setSetupAllRunning] = useState(false);
  const [setupAllProgress, setSetupAllProgress] = useState<{ current: number; total: number; currentAction: string } | null>(null);

  // ── Batch setup detailed tracking ──
  const [batchStatuses, setBatchStatuses] = useState<Record<string, BatchActionStatus>>({});
  const [batchLogs, setBatchLogs] = useState<Record<string, AgentLogEntry[]>>({});
  const [batchErrors, setBatchErrors] = useState<Record<string, string>>({});
  const [batchExpandedLog, setBatchExpandedLog] = useState<string | null>(null);
  const [showBatchPanel, setShowBatchPanel] = useState(false);

  // ── Tab / UI state ──
  const [step, setStep] = useState<'connect' | 'configure' | 'test'>('connect');
  const [running, setRunning] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // ── Plan execution state ──
  interface PlanRunState {
    actionName: string;
    planId: number;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
    stepResults: StepResult[];
    pausedInfo?: { stepId: string; prompt: string; type: 'human' | 'approval' };
    runId?: number;
    error?: string;
  }
  const [planRuns, setPlanRuns] = useState<PlanRunState[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [humanInputValue, setHumanInputValue] = useState('');
  const [saveHumanForFuture, setSaveHumanForFuture] = useState(true);
  const runControllerRef = useRef<AbortController | null>(null);

  // ── Connection form ──
  const [connMode, setConnMode] = useState<'import' | 'manual'>('import');
  const [connForm, setConnForm] = useState({ connection_type: 'SECRET_TEXT', connection_value: '{}' });

  // ── No-auth detection ──
  const needsAuth = !!piece?.auth;
  const autoCreatingNoAuthRef = useRef(false);

  // Auto-create NO_AUTH connection for pieces that don't require auth
  useEffect(() => {
    if (!piece || !name || needsAuth || localConn || autoCreatingNoAuthRef.current) return;
    if (pieceConnections === undefined) return; // still loading
    if (pieceConnections.some((c: any) => c.is_active)) return; // already has active
    autoCreatingNoAuthRef.current = true;
    createConnMut.mutate({
      piece_name: name,
      display_name: piece.displayName,
      connection_type: 'NO_AUTH',
      connection_value: '{}',
      actions_config: '{}',
    });
  }, [piece, name, needsAuth, localConn, pieceConnections]);

  // Auto-advance to configure if already connected OR piece doesn't need auth
  useEffect(() => {
    if (step === 'connect' && (localConn || (piece && !needsAuth))) setStep('configure');
  }, [localConn, piece, needsAuth]);

  // ── Restore saved config from DB when connection loads ──
  useEffect(() => {
    if (!localConn || restoredFromDb) return;

    const savedInputs = localConn.actions_config || {};
    const actionNames = Object.keys(savedInputs);

    if (actionNames.length > 0) {
      setEditedInputs(savedInputs);
      const enabled = new Set<string>();
      for (const actionName of actionNames) {
        const meta = (localConn.ai_config_meta || {})[actionName];
        if (meta?.enabled !== false) {
          enabled.add(actionName);
        }
      }
      setEnabledActions(enabled);
    }

    setRestoredFromDb(true);
  }, [localConn, restoredFromDb]);

  // Track which actions have active background AI jobs
  const [activeAiJobs, setActiveAiJobs] = useState<Record<string, { status: string; startedAt: number }>>({});

  // ── Load existing plans for all actions + check for running AI jobs ──
  useEffect(() => {
    if (!name) return;
    (async () => {
      try {
        const plans = await api.listTestPlans(name);
        const planMap: Record<string, TestPlan> = {};
        const enabled = new Set(enabledActions);
        for (const p of plans) {
          planMap[p.target_action] = p;
          enabled.add(p.target_action);
        }
        setActionPlans(planMap);
        setEnabledActions(enabled);
      } catch {
        // No plans yet
      }
      try {
        const jobs = await api.getAiPlanJobs(name);
        setActiveAiJobs(jobs);
      } catch { /* non-critical */ }
    })();
  }, [name]);

  // Cleanup save timers, running batch AI setup, and plan execution
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setupAllControllerRef.current?.abort();
    runControllerRef.current?.abort();
  }, []);

  // ── Mutations ──
  function invalidateConns() {
    qc.invalidateQueries({ queryKey: ['connections'] });
    qc.invalidateQueries({ queryKey: ['pieceConnections', name] });
  }
  const importMut = useMutation({
    mutationFn: (remote: any) => api.importConnection({
      pieceName: name,
      remoteConnectionId: remote.externalId || remote.id,
      displayName: remote.displayName || piece?.displayName || name,
      connectionType: remote.type || 'CLOUD_OAUTH2',
    }),
    onSuccess: () => { invalidateConns(); setStep('configure'); },
  });
  const createConnMut = useMutation({
    mutationFn: (data: any) => api.createConnection(data),
    onSuccess: () => { invalidateConns(); setStep('configure'); },
  });
  const updateConnMut = useMutation({
    mutationFn: (data: any) => api.updateConnection(localConn?.id, data),
    onSuccess: invalidateConns,
  });
  const deleteConnMut = useMutation({
    mutationFn: (id?: number) => api.deleteConnection(id ?? localConn?.id),
    onSuccess: () => { invalidateConns(); if (!pieceConnections || pieceConnections.length <= 1) { setStep('connect'); setAutoConfig(null); setRestoredFromDb(false); } },
  });
  const activateConnMut = useMutation({
    mutationFn: (id: number) => api.activateConnection(id),
    onSuccess: () => { invalidateConns(); setRestoredFromDb(false); },
  });

  // ── Basic auto-generate ──
  async function handleAutoGenerate() {
    if (!name) return;
    setLoadingAutoConfig(true);
    try {
      const config = await api.getAutoConfig(name);
      setAutoConfig(config);
      const enabled = new Set<string>();
      const inputs: Record<string, Record<string, unknown>> = {};
      for (const action of config.actions) {
        enabled.add(action.actionName);
        inputs[action.actionName] = { ...action.input };
      }
      setEnabledActions(enabled);
      setEditedInputs(inputs);

      // Save to DB
      if (localConn) {
        const actionsConfig: Record<string, Record<string, unknown>> = {};
        for (const actionName of enabled) {
          actionsConfig[actionName] = inputs[actionName] || {};
        }
        api.saveActionsBulk(localConn.id, { actions_config: actionsConfig })
          .catch(err => console.warn('[save] bulk save failed:', err.message));
      }
    } catch (err: any) {
      alert(`Failed to generate config: ${err.message}`);
    }
    setLoadingAutoConfig(false);
  }

  // ── Auto-save helpers ──
  function saveActionToDb(actionName: string, input: Record<string, unknown>, aiMeta?: any, enabled?: boolean) {
    if (!localConn) return;
    api.saveActionConfig(localConn.id, actionName, {
      input,
      ai_meta: aiMeta,
      enabled,
    }).catch(err => console.warn('[save] Failed to save action config:', err.message));
  }

  function debouncedSaveAction(actionName: string, input: Record<string, unknown>) {
    if (!localConn) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveActionToDb(actionName, input);
    }, 800);
  }

  // ── Setup all actions with AI (batch plan creation) ──
  const setupAllControllerRef = useRef<AbortController | null>(null);

  const setupAllWithAi = useCallback(async () => {
    if (!name || !piece) return;
    const actions = Object.keys(piece.actions || {});
    if (actions.length === 0) return;

    // Abort any previous batch
    setupAllControllerRef.current?.abort();
    const batchController = new AbortController();
    setupAllControllerRef.current = batchController;

    // Initialize tracking
    const initialStatuses: Record<string, BatchActionStatus> = {};
    for (const a of actions) {
      initialStatuses[a] = actionPlans[a] ? 'skipped' : 'pending';
    }
    setBatchStatuses(initialStatuses);
    setBatchLogs({});
    setBatchErrors({});
    setShowBatchPanel(true);
    setSetupAllRunning(true);
    setSetupAllProgress({ current: 0, total: actions.length, currentAction: '' });

    // Actions that need human input in their plans (created but have human_input steps without saved responses)
    const needsHumanInput: string[] = [];

    for (let i = 0; i < actions.length; i++) {
      if (batchController.signal.aborted) break;

      const actionName = actions[i];
      setSetupAllProgress({ current: i + 1, total: actions.length, currentAction: actionName });

      // Skip if plan already exists
      if (actionPlans[actionName]) {
        setBatchStatuses(prev => ({ ...prev, [actionName]: 'skipped' }));
        // Check if existing plan has unfilled human_input steps
        const existingPlan = actionPlans[actionName];
        const hasUnfilledHuman = existingPlan.steps.some(
          s => s.type === 'human_input' && !s.savedHumanResponse
        );
        if (hasUnfilledHuman) needsHumanInput.push(actionName);
        continue;
      }

      setBatchStatuses(prev => ({ ...prev, [actionName]: 'running' }));
      setBatchExpandedLog(actionName);

      try {
        const resultPlan = await new Promise<TestPlan>((resolve, reject) => {
          if (batchController.signal.aborted) { reject(new Error('Cancelled')); return; }

          const callbacks = {
            onLog: (log: AgentLogEntry) => {
              setBatchLogs(prev => ({
                ...prev,
                [actionName]: [...(prev[actionName] || []), log],
              }));
            },
            onResult: (result: any) => {
              const hasUnfilledHuman = result.steps?.some(
                (s: any) => s.type === 'human_input' && !s.savedHumanResponse
              );
              const newPlan: TestPlan = {
                id: result.planId,
                piece_name: name,
                target_action: actionName,
                steps: result.steps,
                status: result.status as 'draft' | 'approved',
                agent_memory: result.agentMemory || '',
                automation_status: hasUnfilledHuman ? 'requires_human' : 'fully_automated',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
              setActionPlans(prev => ({ ...prev, [actionName]: newPlan }));
              resolve(newPlan);
            },
            onError: (msg: string) => reject(new Error(msg)),
            onDone: () => {}, // resolve already called from onResult
          };
          const memory = actionPlans[actionName]?.agent_memory || undefined;
          const ctrl = api.streamAiPlan(name, actionName, callbacks, memory);
          batchController.signal.addEventListener('abort', () => ctrl.abort());

          // Timeout safety: if onResult never fires but onDone does, reject after a delay
          setTimeout(() => reject(new Error('Timeout: no result received')), 300000);
        });

        setBatchStatuses(prev => ({ ...prev, [actionName]: 'done' }));

        // Check if the newly created plan has human_input steps
        const hasHumanSteps = resultPlan.steps.some(
          s => s.type === 'human_input' && !s.savedHumanResponse
        );
        if (hasHumanSteps) {
          setBatchStatuses(prev => ({ ...prev, [actionName]: 'waiting_human' }));
          needsHumanInput.push(actionName);
        }
      } catch (err: any) {
        if (batchController.signal.aborted) break;
        console.warn(`[setup-all] Failed to create plan for ${actionName}:`, err.message);
        setBatchStatuses(prev => ({ ...prev, [actionName]: 'error' }));
        setBatchErrors(prev => ({ ...prev, [actionName]: err.message }));
      }
    }

    setSetupAllRunning(false);
    setSetupAllProgress(null);
    setupAllControllerRef.current = null;

    // If any actions need human input, highlight them
    if (needsHumanInput.length > 0) {
      setBatchLogs(prev => ({
        ...prev,
        _summary: [
          ...(prev._summary || []),
          {
            timestamp: Date.now(),
            type: 'decision' as const,
            message: `${needsHumanInput.length} action(s) have steps requiring human input. Open them individually to provide the input.`,
          },
        ],
      }));
    }
  }, [name, piece, actionPlans]);

  const cancelSetupAll = useCallback(() => {
    setupAllControllerRef.current?.abort();
    setSetupAllRunning(false);
    setSetupAllProgress(null);
  }, []);

  // Callback for TestPlanView to notify parent when a plan is created/updated
  const onPlanChange = useCallback((actionName: string, plan: TestPlan | null) => {
    setActionPlans(prev => {
      const next = { ...prev };
      if (plan) {
        next[actionName] = plan;
      } else {
        delete next[actionName];
      }
      return next;
    });
    // Auto-select when plan is created
    if (plan) {
      setEnabledActions(prev => { const next = new Set(prev); next.add(actionName); return next; });
    }
    // Clear active job indicator when plan arrives
    setActiveAiJobs(prev => {
      if (!prev[actionName]) return prev;
      const next = { ...prev };
      delete next[actionName];
      return next;
    });
  }, []);

  function toggleAction(actionName: string) {
    setEnabledActions(prev => {
      const next = new Set(prev);
      const nowEnabled = !next.has(actionName);
      if (nowEnabled) next.add(actionName); else next.delete(actionName);
      // Save enabled state to DB
      if (localConn) {
        api.saveActionConfig(localConn.id, actionName, { enabled: nowEnabled })
          .catch(err => console.warn('[save] toggle failed:', err.message));
      }
      return next;
    });
  }

  function updatePropValue(actionName: string, propName: string, value: unknown) {
    setEditedInputs(prev => {
      const updated = { ...(prev[actionName] || {}), [propName]: value };
      // Debounced save to DB
      debouncedSaveAction(actionName, updated);
      return { ...prev, [actionName]: updated };
    });
  }

  // ── Run all selected plans ──
  async function handleRunPlans() {
    if (!name) return;

    // Gather plans for enabled actions
    const plansToRun: { actionName: string; plan: TestPlan }[] = [];
    for (const actionName of enabledActions) {
      const plan = actionPlans[actionName];
      if (plan) plansToRun.push({ actionName, plan });
    }

    if (plansToRun.length === 0) return;

    runControllerRef.current?.abort();
    const controller = new AbortController();
    runControllerRef.current = controller;

    // Initialize all runs
    const initialRuns: PlanRunState[] = plansToRun.map(({ actionName, plan }) => ({
      actionName,
      planId: plan.id,
      status: 'pending' as const,
      stepResults: [],
    }));
    setPlanRuns(initialRuns);
    setExpandedRun(plansToRun[0]?.actionName || null);
    setRunning(true);
    setStep('test');

    // Execute plans sequentially
    for (let i = 0; i < plansToRun.length; i++) {
      if (controller.signal.aborted) break;

      const { actionName, plan } = plansToRun[i];

      // Mark as running
      setPlanRuns(prev => prev.map(r => r.actionName === actionName ? { ...r, status: 'running' } : r));
      setExpandedRun(actionName);

      try {
        await new Promise<void>((resolve, reject) => {
          if (controller.signal.aborted) { reject(new Error('Cancelled')); return; }

          const ctrl = api.streamPlanExecution(plan.id, {
            onProgress: (progress: PlanProgress) => {
              setPlanRuns(prev => prev.map(r => {
                if (r.actionName !== actionName) return r;
                const updated = { ...r, stepResults: progress.stepResults || r.stepResults };
                if (progress.runId) updated.runId = progress.runId;
                if (progress.type === 'paused_for_human') {
                  updated.status = 'paused';
                  updated.pausedInfo = { stepId: progress.stepId!, prompt: progress.pausedPrompt || '', type: 'human' };
                } else if (progress.type === 'paused_for_approval') {
                  updated.status = 'paused';
                  updated.pausedInfo = { stepId: progress.stepId!, prompt: progress.pausedPrompt || '', type: 'approval' };
                } else {
                  updated.pausedInfo = undefined;
                }
                return updated;
              }));
            },
            onDone: (data) => {
              setPlanRuns(prev => prev.map(r => {
                if (r.actionName !== actionName) return r;
                return {
                  ...r,
                  status: data.status === 'completed' ? 'completed' : 'failed',
                  stepResults: data.step_results || r.stepResults,
                  runId: data.runId,
                };
              }));
              resolve();
            },
            onError: (msg) => {
              setPlanRuns(prev => prev.map(r => {
                if (r.actionName !== actionName) return r;
                return { ...r, status: 'failed', error: msg };
              }));
              resolve(); // Don't reject -- continue to next plan
            },
          });

          controller.signal.addEventListener('abort', () => { ctrl.abort(); reject(new Error('Cancelled')); });
        });
      } catch (err: any) {
        if (controller.signal.aborted) break;
      }
    }

    setRunning(false);
    runControllerRef.current = null;
  }

  // ── Respond to human input during plan execution ──
  async function respondToRunPause(actionName: string, approved?: boolean) {
    const run = planRuns.find(r => r.actionName === actionName);
    if (!run?.runId || !run.pausedInfo) return;

    const response = run.pausedInfo.type === 'human' ? humanInputValue : undefined;

    try {
      await api.respondToPlanRun(run.runId, {
        stepId: run.pausedInfo.stepId,
        approved,
        humanResponse: response,
      });

      // Optionally save the human response for future runs
      if (saveHumanForFuture && run.pausedInfo.type === 'human' && response) {
        const plan = actionPlans[actionName];
        if (plan) {
          const updatedSteps = plan.steps.map(s =>
            s.id === run.pausedInfo!.stepId ? { ...s, savedHumanResponse: response } : s
          );
          try {
            const updated = await api.updateTestPlan(plan.id, { steps: updatedSteps });
            onPlanChange(actionName, updated);
          } catch { /* ignore */ }
        }
      }

      setPlanRuns(prev => prev.map(r =>
        r.actionName === actionName ? { ...r, status: 'running', pausedInfo: undefined } : r
      ));
      setHumanInputValue('');
    } catch (err: any) {
      console.error('Failed to respond:', err);
    }
  }

  // ── Render ──
  if (isLoading) return <div className="text-gray-400">Loading piece details...</div>;
  if (error) return <div className="text-red-400">Failed to load piece: {(error as Error).message}</div>;
  if (!piece) return <div className="text-gray-400">Piece not found.</div>;

  const authType = piece.auth?.type;
  const isOAuth = authType === 'OAUTH2' || authType === 'PLATFORM_OAUTH2';
  const actionList = Object.entries(piece.actions || {}) as [string, any][];
  const hasAnthropicKey = settings?.has_anthropic_key;

  return (
    <div>
      {/* Back */}
      <button onClick={() => navigate('/pieces')} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200 mb-4">
        <ArrowLeft size={16} /> Back to Pieces
      </button>

      {/* Header */}
      <div className="flex items-start gap-4 mb-6">
        {piece.logoUrl ? (
          <img src={piece.logoUrl} alt="" className="w-14 h-14 rounded-xl" />
        ) : (
          <div className="w-14 h-14 rounded-xl bg-gray-800 flex items-center justify-center text-gray-500 text-xl font-bold">{piece.displayName?.[0]}</div>
        )}
        <div className="flex-1">
          <h2 className="text-2xl font-bold">{piece.displayName}</h2>
          <p className="text-sm text-gray-500 mt-0.5">{piece.name} &middot; v{piece.version}</p>
          <p className="text-sm text-gray-400 mt-1">{piece.description}</p>
          <div className="flex gap-4 mt-2 text-xs text-gray-500">
            <span>{actionList.length} actions</span>
            {authType ? (
              <span className="bg-gray-800 px-2 py-0.5 rounded">Auth: {authType}</span>
            ) : (
              <span className="bg-green-500/10 text-green-400 px-2 py-0.5 rounded">No Auth Required</span>
            )}
            {localConn && needsAuth && (
              <span className="text-green-400 flex items-center gap-1">
                <Link2 size={12} /> {localConn.display_name}
                {inactiveConns.length > 0 && <span className="text-gray-500 ml-1">(+{inactiveConns.length} saved)</span>}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Batch queue notice */}
      {Object.values(activeAiJobs).some(j => j.status === 'running' || j.status === 'pending') && (
        <div className="mb-4 flex items-center gap-3 bg-purple-500/10 border border-purple-500/30 rounded-lg px-4 py-2.5 text-sm text-purple-300">
          <Loader2 size={14} className="animate-spin flex-shrink-0" />
          <span>
            {Object.values(activeAiJobs).filter(j => j.status === 'running').length > 0
              ? `AI is creating plans for ${Object.values(activeAiJobs).filter(j => j.status === 'running').length} action(s)...`
              : `${Object.values(activeAiJobs).filter(j => j.status === 'pending').length} action(s) queued for AI plan creation`
            }
          </span>
          <button
            onClick={() => navigate('/batch-setup')}
            className="ml-auto text-xs bg-purple-500/20 hover:bg-purple-500/30 px-2 py-1 rounded flex items-center gap-1"
          >
            <ListChecks size={11} /> View Batch
          </button>
        </div>
      )}

      {/* Steps indicator */}
      <div className="flex items-center gap-2 mb-6">
        {[
          { id: 'connect' as const, label: '1. Connect', done: !!localConn, hidden: !needsAuth },
          { id: 'configure' as const, label: needsAuth ? '2. Configure & Test' : '1. Configure & Test', done: false },
          { id: 'test' as const, label: needsAuth ? '3. Results' : '2. Results', done: false, hidden: planRuns.length === 0 },
        ].filter(s => !s.hidden).map((s) => (
          <button
            key={s.id}
            onClick={() => setStep(s.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              step === s.id
                ? 'bg-primary-600/20 text-primary-300 border border-primary-500/40'
                : s.done
                ? 'bg-green-600/10 text-green-400 border border-green-500/30'
                : 'bg-gray-800 text-gray-500 border border-gray-700'
            }`}
          >
            {s.done && step !== s.id ? <Check size={14} /> : null}
            {s.label}
          </button>
        ))}
      </div>

      {/* ══════ STEP 1: Connect ══════ */}
      {step === 'connect' && (
        <div className="max-w-2xl">
          {localConn ? (
            <ConnectedCard
              conn={localConn}
              onDelete={() => { if (confirm('Remove active connection?')) deleteConnMut.mutate(undefined); }}
              onNext={() => setStep('configure')}
              inactiveConns={inactiveConns}
              onActivate={(id) => activateConnMut.mutate(id)}
              onDeleteInactive={(id) => deleteConnMut.mutate(id)}
            />
          ) : (
            <div className="space-y-4">
              <div className="flex gap-2">
                <button onClick={() => setConnMode('import')} className={`px-4 py-2 rounded text-sm font-medium ${connMode === 'import' ? 'bg-primary-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
                  Import from Activepieces
                </button>
                <button onClick={() => setConnMode('manual')} className={`px-4 py-2 rounded text-sm font-medium ${connMode === 'manual' ? 'bg-primary-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
                  Enter Manually
                </button>
              </div>
              {connMode === 'import' && (
                <ImportPanel remoteConns={remoteConns} loadingRemote={loadingRemote} isOAuth={isOAuth} dashInfo={dashInfo} importMut={importMut} hasExisting={inactiveConns.length > 0} />
              )}
              {connMode === 'manual' && (
                <ManualConnPanel isOAuth={isOAuth} form={connForm} setForm={setConnForm}
                  onSubmit={() => createConnMut.mutate({ piece_name: name, display_name: piece.displayName, connection_type: connForm.connection_type, connection_value: connForm.connection_value, actions_config: '{}' })}
                  isPending={createConnMut.isPending} error={createConnMut.error} />
              )}
              {/* Show saved inactive connections even when no active connection */}
              {inactiveConns.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                  <h4 className="text-xs font-semibold text-gray-400 mb-2">Previously Saved Connections</h4>
                  <div className="space-y-2">
                    {inactiveConns.map((ic: any) => (
                      <div key={ic.id} className="flex items-center justify-between bg-gray-800 rounded px-3 py-2">
                        <div>
                          <span className="text-sm text-gray-300">{ic.display_name}</span>
                          <span className="text-xs text-gray-500 ml-2">{ic.connection_type}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => activateConnMut.mutate(ic.id)} className="text-xs px-2 py-1 bg-primary-600/20 text-primary-400 hover:bg-primary-600/30 rounded">
                            Activate
                          </button>
                          <button onClick={() => { if (confirm('Delete this saved connection?')) deleteConnMut.mutate(ic.id); }} className="text-gray-500 hover:text-red-400">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════ STEP 2: Configure & Test ══════ */}
      {step === 'configure' && (
        <div className="max-w-3xl">
          {!localConn && needsAuth && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 mb-4 text-sm text-yellow-300">
              Connect first. <button onClick={() => setStep('connect')} className="underline ml-1">Go back</button>
            </div>
          )}

          {/* Quick actions bar */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            {hasAnthropicKey && (
              <>
                <button
                  onClick={setupAllWithAi}
                  disabled={setupAllRunning}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                >
                  {setupAllRunning ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
                  {setupAllRunning
                    ? `Setting up ${setupAllProgress?.current}/${setupAllProgress?.total}...`
                    : 'Setup All with AI'
                  }
                </button>
                {!setupAllRunning && Object.keys(batchStatuses).length > 0 && !showBatchPanel && (
                  <button
                    onClick={() => setShowBatchPanel(true)}
                    className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 flex items-center gap-1"
                  >
                    <Terminal size={10} /> View Setup Logs
                  </button>
                )}
              </>
            )}
            <button
              onClick={handleAutoGenerate}
              disabled={loadingAutoConfig}
              className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm font-medium border border-gray-700 disabled:opacity-50"
            >
              {loadingAutoConfig ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              Basic Auto-Fill
            </button>
            {!hasAnthropicKey && (
              <span className="text-xs text-gray-500">
                Add Anthropic API key in <a href="/settings" className="text-purple-400 hover:underline">Settings</a> for AI
              </span>
            )}
            <div className="flex-1" />
            {/* Select all / deselect all */}
            <button
              onClick={() => {
                if (enabledActions.size === actionList.length) {
                  setEnabledActions(new Set());
                } else {
                  setEnabledActions(new Set(actionList.map(([n]) => n)));
                }
              }}
              className="text-[10px] text-gray-400 hover:text-gray-200 px-2 py-1 rounded bg-gray-800 hover:bg-gray-700"
            >
              {enabledActions.size === actionList.length ? 'Deselect All' : 'Select All'}
            </button>
            <span className="text-xs text-gray-500">
              {enabledActions.size}/{actionList.length} selected
              {Object.keys(actionPlans).length > 0 && (
                <span className="text-gray-600 ml-1">({Object.keys(actionPlans).length} have plans)</span>
              )}
            </span>
          </div>

          {/* Batch setup panel */}
          {showBatchPanel && Object.keys(batchStatuses).length > 0 && (
            <BatchSetupPanel
              statuses={batchStatuses}
              logs={batchLogs}
              errors={batchErrors}
              expandedLog={batchExpandedLog}
              onExpandLog={setBatchExpandedLog}
              running={setupAllRunning}
              progress={setupAllProgress}
              onCancel={cancelSetupAll}
              onClose={() => { if (!setupAllRunning) setShowBatchPanel(false); }}
              onOpenAction={(actionName) => { setPlanAction(actionName); setShowBatchPanel(false); }}
              actionMetas={piece?.actions || {}}
            />
          )}

          {/* Actions list */}
          <div className="space-y-2 mb-6">
            {actionList.map(([actionName, actionMeta]) => {
              const isEnabled = enabledActions.has(actionName);
              const isExpanded = expandedAction === actionName;
              const hasPlan = !!actionPlans[actionName];
              const planStatus = actionPlans[actionName]?.status;
              const isPlanOpen = planAction === actionName;
              const jobStatus = activeAiJobs[actionName]?.status;
              const hasActiveJob = jobStatus === 'running' || jobStatus === 'pending';
              const autoAction = autoConfig?.actions?.find((a: any) => a.actionName === actionName);
              const rawProps = Object.entries(actionMeta.props || {}).filter(
                ([, pDef]: [string, any]) => !['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH', 'MARKDOWN'].includes(pDef?.type)
              );

              return (
                <div
                  key={actionName}
                  className={`border rounded-lg transition-colors ${
                    !isEnabled ? 'border-gray-800 bg-gray-900 opacity-50' :
                    isPlanOpen
                      ? 'border-purple-500/40 bg-purple-500/5'
                      : hasPlan
                      ? planStatus === 'approved'
                        ? 'border-green-500/30 bg-green-600/5'
                        : 'border-yellow-500/30 bg-yellow-500/5'
                      : 'border-gray-800 bg-gray-900'
                  }`}
                >
                  {/* Header */}
                  <div className="flex items-center gap-3 p-3">
                    {/* Selection checkbox */}
                    <button
                      onClick={() => toggleAction(actionName)}
                      className={`w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                        isEnabled ? 'bg-primary-600 border-primary-600' : 'border-gray-600 hover:border-gray-400'
                      }`}
                    >
                      {isEnabled && <Check size={13} className="text-white" />}
                    </button>

                    <button
                      onClick={() => setExpandedAction(isExpanded ? null : actionName)}
                      className="flex-1 text-left flex items-center gap-2"
                    >
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium">{actionMeta.displayName}</span>
                        <span className="text-xs text-gray-500 ml-2">{actionName}</span>
                      </div>
                    </button>

                    <div className="flex items-center gap-2">
                      {/* Active AI job indicator */}
                      {hasActiveJob && (
                        <span className="text-[10px] px-2 py-0.5 rounded flex items-center gap-1 bg-purple-500/20 text-purple-400 animate-pulse">
                          <Loader2 size={10} className="animate-spin" /> {jobStatus === 'pending' ? 'Queued...' : 'Creating...'}
                        </span>
                      )}

                      {/* Plan status badge */}
                      {hasPlan && !hasActiveJob && (
                        <span className={`text-[10px] px-2 py-0.5 rounded flex items-center gap-1 ${
                          planStatus === 'approved'
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          <ListChecks size={10} />
                          {planStatus === 'approved' ? 'Plan Ready' : 'Draft'}
                          <span className="text-gray-500 ml-1">({actionPlans[actionName].steps.length} steps)</span>
                        </span>
                      )}

                      {/* Automation classification badge */}
                      {hasPlan && (
                        actionPlans[actionName].automation_status === 'requires_human'
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 flex items-center gap-1" title="Has human-in-the-loop steps without saved responses — cannot be scheduled">
                              <MessageSquare size={9} /> Manual
                            </span>
                          : <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 flex items-center gap-1" title="Fully automated — safe to schedule">
                              <Zap size={9} /> Auto
                            </span>
                      )}

                      {/* Unified AI Test button */}
                      {hasAnthropicKey && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPlanAction(isPlanOpen ? null : actionName);
                            if (!isPlanOpen) setExpandedAction(null);
                          }}
                          className={`text-[10px] px-2 py-1 rounded flex items-center gap-1 font-medium ${
                            isPlanOpen
                              ? 'bg-purple-600 text-white'
                              : 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30'
                          }`}
                        >
                          <Brain size={10} /> {hasPlan ? 'View Plan' : hasActiveJob ? 'View Progress' : 'AI Test'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Inline Test Plan View */}
                  {isPlanOpen && (
                    <div className="border-t border-purple-500/20 px-3 pb-3 pt-2">
                      <TestPlanView
                        pieceName={name!}
                        actionName={actionName}
                        actionDisplayName={actionMeta.displayName || actionName}
                        hasAnthropicKey={hasAnthropicKey}
                        onClose={() => setPlanAction(null)}
                        onPlanChange={(plan) => onPlanChange(actionName, plan)}
                      />
                    </div>
                  )}

                  {/* Expanded: manual props editor (for non-AI basic config) */}
                  {isExpanded && !isPlanOpen && (
                    <div className="border-t border-gray-800/50 px-4 py-3 space-y-3">
                      <p className="text-xs text-gray-500">{actionMeta.description}</p>

                      {rawProps.length === 0 && (
                        <p className="text-xs text-gray-500">No input parameters needed.</p>
                      )}

                      {autoAction ? (
                        autoAction.propsDetail.map((prop: any) => (
                          <BasicPropEditor
                            key={prop.name}
                            prop={prop}
                            rawProp={(actionMeta.props || {})[prop.name]}
                            value={editedInputs[actionName]?.[prop.name]}
                            onChange={(v) => updatePropValue(actionName, prop.name, v)}
                          />
                        ))
                      ) : (
                        rawProps.map(([propName, propDef]: [string, any]) => (
                          <RawPropEditor
                            key={propName}
                            propName={propName}
                            propDef={propDef}
                            value={editedInputs[actionName]?.[propName]}
                            onChange={(v) => updatePropValue(actionName, propName, v)}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Run button */}
          {(() => {
            const plansToRun = Array.from(enabledActions).filter(a => actionPlans[a]);
            const noPlanCount = enabledActions.size - plansToRun.length;
            return (
              <div className="flex gap-3 items-center">
                <button
                  onClick={handleRunPlans}
                  disabled={running || plansToRun.length === 0}
                  className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-semibold disabled:opacity-40"
                >
                  {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                  Run {plansToRun.length} Plan{plansToRun.length !== 1 ? 's' : ''}
                </button>
                <span className="text-xs text-gray-500">
                  {setupAllRunning
                    ? 'AI is setting up actions...'
                    : plansToRun.length === 0
                    ? 'Select actions with test plans to run'
                    : noPlanCount > 0
                    ? `${noPlanCount} selected action${noPlanCount > 1 ? 's' : ''} missing plans`
                    : ''
                  }
                </span>
              </div>
            );
          })()}

          <ScheduleBlock pieceName={name!} actionPlans={actionPlans} enabledActions={enabledActions} />
        </div>
      )}

      {/* ══════ STEP 3: Results ══════ */}
      {step === 'test' && (
        <div className="max-w-3xl w-full">
          {planRuns.length > 0 ? (
            <>
              {/* Summary header */}
              {(() => {
                const completed = planRuns.filter(r => r.status === 'completed').length;
                const failed = planRuns.filter(r => r.status === 'failed').length;
                const paused = planRuns.filter(r => r.status === 'paused').length;
                const pending = planRuns.filter(r => r.status === 'pending' || r.status === 'running').length;
                const allDone = !running && pending === 0;
                return (
                  <div className="mb-4">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-semibold">Plan Execution</h3>
                      {running && <Loader2 size={16} className="animate-spin text-blue-400" />}
                      {allDone && failed === 0 && <CheckCircle size={16} className="text-green-400" />}
                      {allDone && failed > 0 && <XCircle size={16} className="text-red-400" />}
                    </div>
                    <div className="flex gap-4 text-sm">
                      <span className="text-gray-400">Total: {planRuns.length}</span>
                      <span className="text-green-400">Passed: {completed}</span>
                      <span className="text-red-400">Failed: {failed}</span>
                      {paused > 0 && <span className="text-yellow-400">Waiting: {paused}</span>}
                      {pending > 0 && <span className="text-blue-400">Running: {pending}</span>}
                    </div>
                  </div>
                );
              })()}

              {/* Per-plan results */}
              <div className="space-y-3 mb-6">
                {planRuns.map((run) => {
                  const plan = actionPlans[run.actionName];
                  const steps = plan?.steps || [];
                  const isExpanded = expandedRun === run.actionName;
                  const meta = piece?.actions?.[run.actionName];

                  const statusIcon = run.status === 'completed' ? <CheckCircle size={16} className="text-green-400" />
                    : run.status === 'failed' ? <XCircle size={16} className="text-red-400" />
                    : run.status === 'running' ? <Loader2 size={16} className="text-blue-400 animate-spin" />
                    : run.status === 'paused' ? <MessageSquare size={16} className="text-yellow-400" />
                    : <Clock size={16} className="text-gray-500" />;

                  const statusBorder = run.status === 'completed' ? 'border-green-500/30'
                    : run.status === 'failed' ? 'border-red-500/30'
                    : run.status === 'running' ? 'border-blue-500/30'
                    : run.status === 'paused' ? 'border-yellow-500/30'
                    : 'border-gray-800';

                  return (
                    <div key={run.actionName} className={`border rounded-lg ${statusBorder} bg-gray-900 overflow-hidden`}>
                      {/* Plan header */}
                      <button
                        onClick={() => setExpandedRun(isExpanded ? null : run.actionName)}
                        className="w-full flex items-center gap-3 p-3 text-left hover:bg-gray-800/50 transition-colors"
                      >
                        {statusIcon}
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium">{meta?.displayName || run.actionName}</span>
                          <span className="text-xs text-gray-500 ml-2">{steps.length} steps</span>
                        </div>
                        {/* Step progress mini-bar */}
                        <div className="flex items-center gap-0.5">
                          {steps.map((s) => {
                            const sr = run.stepResults.find(r => r.stepId === s.id);
                            const color = sr?.status === 'completed' ? 'bg-green-500'
                              : sr?.status === 'failed' ? 'bg-red-500'
                              : sr?.status === 'running' ? 'bg-blue-500 animate-pulse'
                              : sr?.status === 'waiting' ? 'bg-yellow-500'
                              : sr?.status === 'skipped' ? 'bg-gray-600'
                              : 'bg-gray-700';
                            return <div key={s.id} className={`w-3 h-1.5 rounded-sm ${color}`} title={s.label} />;
                          })}
                        </div>
                        {isExpanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
                      </button>

                      {/* Expanded: step details */}
                      {isExpanded && (
                        <div className="border-t border-gray-800/50 px-3 pb-3 pt-2 space-y-1">
                          {steps.map((s, idx) => {
                            const sr = run.stepResults.find(r => r.stepId === s.id);
                            const isPaused = run.pausedInfo?.stepId === s.id;

                            const stepIcon = sr?.status === 'completed' ? <CheckCircle size={12} className="text-green-400" />
                              : sr?.status === 'failed' ? <XCircle size={12} className="text-red-400" />
                              : sr?.status === 'running' ? <Loader2 size={12} className="text-blue-400 animate-spin" />
                              : sr?.status === 'waiting' ? <MessageSquare size={12} className="text-yellow-400" />
                              : sr?.status === 'skipped' ? <SkipForward size={12} className="text-gray-600" />
                              : <Clock size={12} className="text-gray-600" />;

                            const typeColors: Record<string, string> = {
                              setup: 'text-blue-400 bg-blue-500/10',
                              test: 'text-green-400 bg-green-500/10',
                              verify: 'text-cyan-400 bg-cyan-500/10',
                              cleanup: 'text-orange-400 bg-orange-500/10',
                              human_input: 'text-purple-400 bg-purple-500/10',
                            };

                            return (
                              <div key={s.id}>
                                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
                                  sr?.status === 'failed' ? 'bg-red-500/5' :
                                  sr?.status === 'completed' ? 'bg-green-500/5' :
                                  isPaused ? 'bg-yellow-500/5' : ''
                                }`}>
                                  <span className="text-[10px] text-gray-600 w-3 text-right">{idx + 1}</span>
                                  {stepIcon}
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${typeColors[s.type] || 'text-gray-400 bg-gray-800'}`}>
                                    {s.type}
                                  </span>
                                  <span className="flex-1 truncate text-gray-300">{s.label}</span>
                                  {sr && sr.duration_ms > 0 && (
                                    <span className="text-[10px] text-gray-500">{(sr.duration_ms / 1000).toFixed(1)}s</span>
                                  )}
                                </div>

                                {/* Step error */}
                                {sr?.error && (
                                  <div className="ml-8 mt-1 text-[10px] text-red-400 bg-red-500/5 rounded p-1.5 font-mono">
                                    {sr.error}
                                  </div>
                                )}

                                {/* Step output preview */}
                                {sr?.status === 'completed' && sr.output != null && (
                                  <div className="ml-8 mt-1 text-[10px] text-green-400/60 bg-green-500/5 rounded p-1.5 font-mono max-h-16 overflow-y-auto truncate">
                                    {typeof sr.output === 'string' ? sr.output.slice(0, 200) : JSON.stringify(sr.output, null, 2).slice(0, 200)}
                                  </div>
                                )}

                                {/* Human input form */}
                                {isPaused && run.pausedInfo?.type === 'human' && (
                                  <div className="ml-8 mt-2 bg-yellow-500/10 border border-yellow-500/20 rounded p-2.5">
                                    <p className="text-xs text-yellow-300 mb-2">{run.pausedInfo.prompt}</p>
                                    <div className="flex gap-2">
                                      <input
                                        type="text"
                                        value={humanInputValue}
                                        onChange={e => setHumanInputValue(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') respondToRunPause(run.actionName, true); }}
                                        className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200"
                                        placeholder="Type your response..."
                                        autoFocus
                                      />
                                      <button onClick={() => respondToRunPause(run.actionName, true)}
                                        className="px-2 py-1 bg-yellow-600 hover:bg-yellow-500 text-white text-[10px] rounded">
                                        Submit
                                      </button>
                                    </div>
                                    <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer">
                                      <input type="checkbox" checked={saveHumanForFuture} onChange={e => setSaveHumanForFuture(e.target.checked)} className="rounded border-gray-600" />
                                      <span className="text-[10px] text-gray-500">Save for future runs</span>
                                    </label>
                                  </div>
                                )}

                                {/* Approval form */}
                                {isPaused && run.pausedInfo?.type === 'approval' && (
                                  <div className="ml-8 mt-2 bg-yellow-500/10 border border-yellow-500/20 rounded p-2.5">
                                    <p className="text-xs text-yellow-300 mb-2">{run.pausedInfo.prompt}</p>
                                    <div className="flex gap-2">
                                      <button onClick={() => respondToRunPause(run.actionName, true)}
                                        className="px-2 py-1 bg-green-600 hover:bg-green-500 text-white text-[10px] rounded flex items-center gap-1">
                                        <Check size={10} /> Approve
                                      </button>
                                      <button onClick={() => respondToRunPause(run.actionName, false)}
                                        className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-[10px] rounded">
                                        Skip
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}

                          {/* Fix with AI for failed plans */}
                          {run.status === 'failed' && hasAnthropicKey && (
                            <div className="flex items-center gap-2 pt-2 mt-1 border-t border-gray-800/50">
                              <button
                                onClick={() => { setPlanAction(run.actionName); setStep('configure'); }}
                                className="text-xs bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 px-3 py-1.5 rounded flex items-center gap-1.5"
                              >
                                <Brain size={11} /> Fix with AI
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Action buttons */}
              <div className="flex gap-3">
                <button onClick={handleRunPlans} disabled={running}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-40">
                  {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Re-run
                </button>
                {running && (
                  <button onClick={() => { runControllerRef.current?.abort(); setRunning(false); }}
                    className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded text-sm">
                    <X size={14} /> Abort
                  </button>
                )}
                <button onClick={() => setStep('configure')} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm">
                  Edit Config
                </button>
              </div>
            </>
          ) : running ? (
            <div className="text-center py-12">
              <Loader2 size={32} className="animate-spin text-primary-400 mx-auto mb-3" />
              <p className="text-gray-400">Starting plan execution...</p>
            </div>
          ) : (
            <p className="text-gray-500">No results yet. Go to Configure & Test to run plans.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Batch Setup Panel
// ══════════════════════════════════════════════════════════════

type BatchActionStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'waiting_human';

const BATCH_STATUS_CONFIG: Record<BatchActionStatus, { icon: JSX.Element; label: string; color: string }> = {
  pending:        { icon: <Clock size={12} className="text-gray-500" />,              label: 'Pending',        color: 'text-gray-500' },
  running:        { icon: <Loader2 size={12} className="text-purple-400 animate-spin" />, label: 'Setting up...', color: 'text-purple-400' },
  done:           { icon: <CheckCircle size={12} className="text-green-400" />,       label: 'Done',           color: 'text-green-400' },
  error:          { icon: <XCircle size={12} className="text-red-400" />,             label: 'Error',          color: 'text-red-400' },
  skipped:        { icon: <SkipForward size={12} className="text-gray-400" />,        label: 'Already exists', color: 'text-gray-400' },
  waiting_human:  { icon: <MessageSquare size={12} className="text-yellow-400" />,    label: 'Needs input',    color: 'text-yellow-400' },
};

function BatchSetupPanel({
  statuses, logs, errors, expandedLog, onExpandLog,
  running, progress, onCancel, onClose, onOpenAction, actionMetas,
}: {
  statuses: Record<string, BatchActionStatus>;
  logs: Record<string, AgentLogEntry[]>;
  errors: Record<string, string>;
  expandedLog: string | null;
  onExpandLog: (a: string | null) => void;
  running: boolean;
  progress: { current: number; total: number; currentAction: string } | null;
  onCancel: () => void;
  onClose: () => void;
  onOpenAction: (actionName: string) => void;
  actionMetas: Record<string, any>;
}) {
  const logEndRef = useRef<HTMLDivElement>(null);
  const currentLogs = expandedLog ? (logs[expandedLog] || []) : [];

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentLogs.length]);

  const counts = Object.values(statuses);
  const doneCount = counts.filter(s => s === 'done' || s === 'skipped').length;
  const errorCount = counts.filter(s => s === 'error').length;
  const humanCount = counts.filter(s => s === 'waiting_human').length;

  return (
    <div className="mb-4 bg-gray-950 border border-purple-500/30 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-purple-500/10 border-b border-purple-500/20">
        <div className="flex items-center gap-3">
          <Brain size={16} className="text-purple-400" />
          <span className="text-sm font-medium text-purple-300">
            {running ? 'Setting up all actions...' : 'Batch Setup Complete'}
          </span>
          {progress && running && (
            <span className="text-xs text-gray-400">
              ({progress.current}/{progress.total})
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Summary stats */}
          <div className="flex items-center gap-3 text-[10px]">
            <span className="text-green-400">{doneCount} done</span>
            {errorCount > 0 && <span className="text-red-400">{errorCount} errors</span>}
            {humanCount > 0 && <span className="text-yellow-400">{humanCount} need input</span>}
          </div>
          {running ? (
            <button onClick={onCancel} className="text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 px-2 py-1 rounded flex items-center gap-1">
              <X size={10} /> Cancel
            </button>
          ) : (
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {running && progress && (
        <div className="w-full bg-gray-900 h-1">
          <div
            className="bg-purple-500 h-1 transition-all duration-300"
            style={{ width: `${(progress.current / progress.total) * 100}%` }}
          />
        </div>
      )}

      <div className="flex" style={{ maxHeight: '400px' }}>
        {/* Left: action list */}
        <div className="w-[280px] border-r border-gray-800 overflow-y-auto">
          {Object.entries(statuses).map(([actionName, status]) => {
            const cfg = BATCH_STATUS_CONFIG[status];
            const isActive = expandedLog === actionName;
            const meta = actionMetas[actionName];
            const logCount = (logs[actionName] || []).length;

            return (
              <button
                key={actionName}
                onClick={() => onExpandLog(isActive ? null : actionName)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs border-b border-gray-800/50 transition-colors ${
                  isActive ? 'bg-gray-800/80' : 'hover:bg-gray-900/50'
                }`}
              >
                {cfg.icon}
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium text-gray-300">
                    {meta?.displayName || actionName}
                  </div>
                  <div className={`text-[10px] ${cfg.color}`}>{cfg.label}</div>
                </div>
                {logCount > 0 && (
                  <span className="text-[9px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">
                    {logCount}
                  </span>
                )}
                {status === 'waiting_human' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onOpenAction(actionName); }}
                    className="text-[9px] bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 px-1.5 py-0.5 rounded"
                  >
                    Open
                  </button>
                )}
              </button>
            );
          })}
        </div>

        {/* Right: logs for selected action */}
        <div className="flex-1 overflow-y-auto bg-gray-950 p-3 min-h-[200px]">
          {expandedLog ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-400 flex items-center gap-1.5">
                  <Terminal size={11} />
                  {actionMetas[expandedLog]?.displayName || expandedLog}
                </span>
                {statuses[expandedLog] === 'error' && errors[expandedLog] && (
                  <span className="text-[10px] text-red-400 bg-red-500/10 px-2 py-0.5 rounded">
                    {errors[expandedLog]}
                  </span>
                )}
              </div>
              <div className="space-y-1">
                {currentLogs.map((log, i) => (
                  <div key={i} className={`text-[10px] font-mono leading-relaxed ${
                    log.type === 'error' ? 'text-red-400' :
                    log.type === 'tool_call' ? 'text-cyan-400' :
                    log.type === 'tool_result' ? 'text-green-400/70' :
                    log.type === 'decision' ? 'text-yellow-400' :
                    log.type === 'thinking' ? 'text-purple-300/80' :
                    'text-gray-500'
                  }`}>
                    <span className="text-gray-700 mr-1">[{log.type}]</span>
                    {log.message}
                    {log.detail && (
                      <span className="text-gray-700 block ml-4 truncate">{log.detail.slice(0, 150)}</span>
                    )}
                  </div>
                ))}
                {statuses[expandedLog] === 'running' && (
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-500 pt-1">
                    <Loader2 size={10} className="animate-spin" /> Working...
                  </div>
                )}
                <div ref={logEndRef} />
              </div>
              {currentLogs.length === 0 && statuses[expandedLog] !== 'running' && (
                <p className="text-xs text-gray-600 italic">
                  {statuses[expandedLog] === 'skipped' ? 'Plan already exists, skipped.' : 'No logs yet.'}
                </p>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-gray-600">
              Select an action on the left to see its logs
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Field Editors
// ══════════════════════════════════════════════════════════════

/** Field editor for basic auto-config fields */
function BasicPropEditor({ prop, rawProp, value, onChange }: {
  prop: any;
  rawProp: any;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs font-medium text-gray-300">
          {prop.displayName}
          {prop.required && <span className="text-red-400 ml-0.5">*</span>}
        </label>
        <span className="text-[10px] bg-gray-800 px-1.5 py-0.5 rounded text-gray-500">{prop.type}</span>
        {prop.needsManualInput && (
          <span className="text-[10px] text-yellow-400 flex items-center gap-0.5">
            <AlertTriangle size={9} /> {prop.reason}
          </span>
        )}
      </div>
      <PropInput
        propName={prop.name}
        propDef={rawProp}
        type={prop.type}
        value={value}
        onChange={onChange}
        highlight={prop.needsManualInput}
      />
    </div>
  );
}

/** Field editor for raw piece metadata props (no auto-config) */
function RawPropEditor({ propName, propDef, value, onChange }: {
  propName: string;
  propDef: any;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const type = propDef?.type || 'SHORT_TEXT';
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs font-medium text-gray-300">
          {propDef?.displayName || propName}
          {propDef?.required && <span className="text-red-400 ml-0.5">*</span>}
        </label>
        <span className="text-[10px] bg-gray-800 px-1.5 py-0.5 rounded text-gray-500">{type}</span>
      </div>
      {propDef?.description && (
        <p className="text-[10px] text-gray-500">{propDef.description}</p>
      )}
      <PropInput
        propName={propName}
        propDef={propDef}
        type={type}
        value={value}
        onChange={onChange}
        highlight={false}
      />
    </div>
  );
}

/** Core input component that renders the appropriate input type */
function PropInput({ propName, propDef, type, value, onChange, highlight }: {
  propName: string;
  propDef: any;
  type: string;
  value: unknown;
  onChange: (v: unknown) => void;
  highlight: boolean;
}) {
  if (type === 'CHECKBOX') {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} className="rounded" />
        <span className="text-xs text-gray-400">{value ? 'Yes' : 'No'}</span>
      </label>
    );
  }

  if (type === 'NUMBER') {
    return (
      <input type="number" className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs"
        value={value as number ?? ''} onChange={e => onChange(parseFloat(e.target.value) || 0)} />
    );
  }

  if (type === 'STATIC_DROPDOWN' && propDef?.options?.options) {
    return (
      <select className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs"
        value={value as string ?? ''} onChange={e => onChange(e.target.value)}>
        <option value="">-- select --</option>
        {propDef.options.options.map((opt: any) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    );
  }

  if (type === 'JSON' || type === 'OBJECT' || type === 'DYNAMIC' || type === 'ARRAY') {
    return (
      <JsonTextarea
        value={value}
        onChange={onChange}
        placeholder={type === 'ARRAY' ? '[]' : '{}'}
      />
    );
  }

  if (type === 'LONG_TEXT') {
    return (
      <textarea className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs h-16"
        value={value as string ?? ''} onChange={e => onChange(e.target.value)} />
    );
  }

  // Default: text input
  return (
    <input className={`w-full bg-gray-800 border rounded px-2 py-1.5 text-xs ${highlight ? 'border-yellow-500/50' : 'border-gray-700'}`}
      value={value as string ?? ''} onChange={e => onChange(e.target.value)}
      placeholder={highlight ? `Enter ${propDef?.displayName || propName}...` : ''} />
  );
}

// ══════════════════════════════════════════════════════════════
// Shared Sub-components
// ══════════════════════════════════════════════════════════════

function JsonTextarea({ value, onChange, placeholder, className }: { value: unknown; onChange: (v: unknown) => void; placeholder?: string; className?: string }) {
  const [rawText, setRawText] = useState(() =>
    typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)
  );
  const [parseError, setParseError] = useState(false);

  useEffect(() => {
    const incoming = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
    try {
      const currentParsed = JSON.parse(rawText);
      const parentParsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (JSON.stringify(currentParsed) === JSON.stringify(parentParsed)) return;
    } catch { /* sync from parent */ }
    setRawText(incoming);
    setParseError(false);
  }, [value]);

  function handleChange(text: string) {
    setRawText(text);
    try {
      const parsed = JSON.parse(text);
      setParseError(false);
      onChange(parsed);
    } catch {
      setParseError(true);
      onChange(text);
    }
  }

  function handleBlur() {
    try {
      const parsed = JSON.parse(rawText);
      setParseError(false);
      setRawText(JSON.stringify(parsed, null, 2));
      onChange(parsed);
    } catch {
      setParseError(true);
    }
  }

  return (
    <div>
      <textarea
        className={`w-full bg-gray-800 border rounded px-2 py-1.5 text-xs font-mono h-16 ${parseError ? 'border-red-500/50' : 'border-gray-700'} ${className ?? ''}`}
        value={rawText}
        onChange={e => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
      />
      {parseError && <p className="text-[10px] text-red-400 mt-0.5">Invalid JSON -- will be saved as text</p>}
    </div>
  );
}

function ConnectedCard({ conn, onDelete, onNext, inactiveConns, onActivate, onDeleteInactive }: {
  conn: any;
  onDelete: () => void;
  onNext: () => void;
  inactiveConns: any[];
  onActivate: (id: number) => void;
  onDeleteInactive: (id: number) => void;
}) {
  return (
    <div className="space-y-3">
      {/* Active connection */}
      <div className="bg-gray-900 border border-green-500/30 rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Check size={18} className="text-green-400" />
            <h3 className="font-semibold text-green-300">Active Connection</h3>
          </div>
          <button onClick={onDelete} className="text-red-400 hover:text-red-300 text-xs flex items-center gap-1"><Trash2 size={13} /> Remove</button>
        </div>
        <div className="text-sm text-gray-400 space-y-1">
          <p><span className="text-gray-500">Display Name:</span> {conn.display_name}</p>
          <p><span className="text-gray-500">Type:</span> {conn.connection_type}</p>
        </div>
        <button onClick={onNext} className="mt-4 px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium flex items-center gap-2">
          <Wand2 size={15} /> Configure Actions & Test
        </button>
      </div>

      {/* Saved connections list */}
      {inactiveConns.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h4 className="text-xs font-semibold text-gray-400 mb-2">Saved Connections (switch without losing config)</h4>
          <div className="space-y-2">
            {inactiveConns.map((ic: any) => (
              <div key={ic.id} className="flex items-center justify-between bg-gray-800 rounded px-3 py-2">
                <div>
                  <span className="text-sm text-gray-300">{ic.display_name}</span>
                  <span className="text-xs text-gray-500 ml-2">{ic.connection_type}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => onActivate(ic.id)} className="text-xs px-2 py-1 bg-primary-600/20 text-primary-400 hover:bg-primary-600/30 rounded">
                    Switch to this
                  </button>
                  <button onClick={() => { if (confirm('Delete this saved connection?')) onDeleteInactive(ic.id); }} className="text-gray-500 hover:text-red-400">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ImportPanel({ remoteConns, loadingRemote, isOAuth, dashInfo, importMut, hasExisting }: any) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4">
      <h3 className="font-semibold text-sm">Import existing connection from Activepieces</h3>
      <p className="text-xs text-gray-500">
        {isOAuth ? 'This piece uses OAuth -- import your existing AP connection (recommended).' : 'Select a connection already set up in your AP project.'}
        {hasExisting && ' Adding a new connection will make it active. Your previous connections are saved.'}
      </p>
      {loadingRemote ? (
        <p className="text-sm text-gray-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading...</p>
      ) : remoteConns?.length > 0 ? (
        <div className="space-y-2">
          {remoteConns.map((rc: any) => (
            <div key={rc.id || rc.externalId} className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-3">
              <div>
                <p className="text-sm font-medium">{rc.displayName}</p>
                <p className="text-xs text-gray-500">{rc.type} &middot; {rc.status}</p>
              </div>
              <button onClick={() => importMut.mutate(rc)} disabled={importMut.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-xs font-medium disabled:opacity-50">
                <Download size={13} /> Import
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-gray-400 space-y-3">
          <p>No connections found for this piece.</p>
          {isOAuth && dashInfo && (
            <div className="bg-gray-800 rounded-lg p-4">
              <p className="text-sm mb-2">Create the OAuth connection in Activepieces first:</p>
              <a href={`${dashInfo.dashboardUrl}/connections`} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium w-fit">
                <ExternalLink size={14} /> Open AP Connections Page
              </a>
              <p className="text-xs text-gray-500 mt-2">Then come back and refresh this page.</p>
            </div>
          )}
        </div>
      )}
      {importMut.error && <p className="text-sm text-red-400">{(importMut.error as Error).message}</p>}
    </div>
  );
}

function ManualConnPanel({ isOAuth, form, setForm, onSubmit, isPending, error }: any) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-3">
      <h3 className="font-semibold text-sm">Enter credentials manually</h3>
      {isOAuth && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded p-3 text-xs text-yellow-300">
          OAuth piece -- manual entry requires a pre-existing access token. Importing is recommended.
        </div>
      )}
      <div>
        <label className="block text-xs text-gray-400 mb-1">Connection Type</label>
        <select className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" value={form.connection_type} onChange={e => setForm({ ...form, connection_type: e.target.value })}>
          {CONNECTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <CredentialInput type={form.connection_type} value={form.connection_value} onChange={v => setForm({ ...form, connection_value: v })} />
      <button onClick={onSubmit} disabled={isPending} className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium disabled:opacity-50">
        {isPending ? 'Creating...' : 'Create Connection'}
      </button>
      {error && <p className="text-sm text-red-400">{(error as Error).message}</p>}
    </div>
  );
}

function CredentialInput({ type, value, onChange }: { type: string; value: string; onChange: (v: string) => void }) {
  const parsed = safeJson(value);
  if (type === 'NO_AUTH') return <p className="text-xs text-gray-500">No credentials needed.</p>;
  if (type === 'SECRET_TEXT') return (
    <div><label className="block text-xs text-gray-400 mb-1">API Key / Secret</label>
    <input className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" type="password" value={parsed.secret_text ?? ''} onChange={e => onChange(JSON.stringify({ secret_text: e.target.value }))} /></div>
  );
  if (type === 'BASIC_AUTH') return (
    <div className="space-y-2">
      <div><label className="block text-xs text-gray-400 mb-1">Username</label><input className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" value={parsed.username ?? ''} onChange={e => onChange(JSON.stringify({ ...parsed, username: e.target.value }))} /></div>
      <div><label className="block text-xs text-gray-400 mb-1">Password</label><input className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" type="password" value={parsed.password ?? ''} onChange={e => onChange(JSON.stringify({ ...parsed, password: e.target.value }))} /></div>
    </div>
  );
  return (
    <div><label className="block text-xs text-gray-400 mb-1">Credentials (JSON)</label>
    <textarea className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono h-20" value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)} onChange={e => onChange(e.target.value)} /></div>
  );
}

function ScheduleBlock({ pieceName, actionPlans, enabledActions }: {
  pieceName: string;
  actionPlans: Record<string, TestPlan>;
  enabledActions: Set<string>;
}) {
  const qc = useQueryClient();
  const { data: schedules } = useQuery({ queryKey: ['schedules'], queryFn: api.listSchedules });
  const existing = schedules?.find((s: any) => s.piece_name === pieceName);
  const [cronExpr, setCronExpr] = useState('0 8 * * *');

  const createMut = useMutation({
    mutationFn: () => api.createSchedule({ piece_name: pieceName, cron_expression: cronExpr }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });

  // Compute automation stats
  const selectedPlans = Array.from(enabledActions)
    .map(a => actionPlans[a])
    .filter(Boolean);
  const manualPlans = selectedPlans.filter(p => p.automation_status === 'requires_human');
  const autoPlans = selectedPlans.filter(p => p.automation_status !== 'requires_human');
  const noPlanCount = enabledActions.size - selectedPlans.length;

  return (
    <div className="mt-8 border-t border-gray-800 pt-6">
      <h4 className="text-sm font-semibold flex items-center gap-2 mb-3"><Clock size={15} /> Schedule Recurring Tests</h4>

      {/* Automation classification summary */}
      {selectedPlans.length > 0 && (
        <div className="mb-3 p-3 bg-gray-900 border border-gray-800 rounded-lg">
          <div className="flex items-center gap-3 text-xs mb-1">
            <span className="text-gray-400">Selected plans:</span>
            <span className="text-cyan-400 flex items-center gap-1"><Zap size={10} /> {autoPlans.length} automated</span>
            {manualPlans.length > 0 && (
              <span className="text-orange-400 flex items-center gap-1"><MessageSquare size={10} /> {manualPlans.length} manual</span>
            )}
            {noPlanCount > 0 && (
              <span className="text-gray-500">{noPlanCount} no plan</span>
            )}
          </div>
          {manualPlans.length > 0 && (
            <p className="text-[10px] text-orange-400/80 mt-1">
              {manualPlans.length} plan{manualPlans.length > 1 ? 's' : ''} require{manualPlans.length === 1 ? 's' : ''} human input and will be
              <strong> skipped during scheduled runs</strong>. Save human responses in each plan to make them fully automated.
            </p>
          )}
        </div>
      )}

      {existing ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between">
          <div>
            <p className="text-sm">Scheduled: <code className="bg-gray-800 px-1.5 py-0.5 rounded text-xs">{existing.cron_expression}</code></p>
            {existing.last_run_at && <p className="text-xs text-gray-500 mt-1">Last: {new Date(existing.last_run_at).toLocaleString()}</p>}
            {manualPlans.length > 0 && (
              <p className="text-[10px] text-orange-400 mt-1 flex items-center gap-1">
                <AlertTriangle size={10} /> {manualPlans.length} plan(s) with human-in-the-loop will be skipped
              </p>
            )}
          </div>
          <button onClick={() => deleteMut.mutate(existing.id)} className="text-red-400 hover:text-red-300 text-xs flex items-center gap-1"><Trash2 size={12} /> Remove</button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <select className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" value={cronExpr} onChange={e => setCronExpr(e.target.value)}>
            <option value="0 8 * * *">Daily at 8 AM</option>
            <option value="0 8 * * 1">Weekly (Mon 8 AM)</option>
            <option value="0 */6 * * *">Every 6 hours</option>
            <option value="0 */12 * * *">Every 12 hours</option>
          </select>
          <button onClick={() => createMut.mutate()} disabled={createMut.isPending || autoPlans.length === 0}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-2">
            <Clock size={14} /> Add Schedule
            {autoPlans.length > 0 && <span className="text-[10px] text-gray-400">({autoPlans.length} automated)</span>}
          </button>
        </div>
      )}
    </div>
  );
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

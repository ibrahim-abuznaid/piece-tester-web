import { api, type TestPlan, type AgentLogEntry } from './api';

export type BatchActionStatus =
  | 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'waiting_human';

export interface BatchItem {
  key: string;                         // `${kind}:${name}` — actions and triggers can share a name
  kind: 'action' | 'trigger';
  name: string;
  displayName: string;
  status: BatchActionStatus;
}

export interface BatchState {
  pieceName: string | null;
  running: boolean;
  mode: 'create_missing' | 'replace_existing' | null;
  items: BatchItem[];
  logs: Record<string, AgentLogEntry[]>;   // keyed by item.key
  errors: Record<string, string>;          // keyed by item.key
  progress: { current: number; total: number; currentName: string } | null;
  results: Record<string, TestPlan>;   // plans created this batch, for consumers to merge
  resultsVersion: number;              // bumps on results change
  showPanel: boolean;
}

/** existingPlan supplies prior agent memory, and (for create-missing) marks the item as skipped. */
export interface BatchTarget {
  kind: 'action' | 'trigger';
  name: string;
  displayName: string;
  existingPlan?: TestPlan;
}

// Matches the server's 600s request timeout so a slow-but-healthy v2 run isn't flagged as an error.
const TARGET_TIMEOUT_MS = 600_000;

const EMPTY: BatchState = {
  pieceName: null,
  running: false,
  mode: null,
  items: [],
  logs: {},
  errors: {},
  progress: null,
  results: {},
  resultsVersion: 0,
  showPanel: false,
};

let state: BatchState = EMPTY;
const listeners = new Set<() => void>();

// Module scope so the run survives navigation and a fresh mount can still cancel it.
let batchController: AbortController | null = null;

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<BatchState>) {
  state = { ...state, ...patch };
  emit();
}

// ── useSyncExternalStore contract ──
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getSnapshot(): BatchState {
  return state;
}

// ── Mutators ──
function updateItem(key: string, status: BatchActionStatus) {
  setState({ items: state.items.map(it => (it.key === key ? { ...it, status } : it)) });
}

function appendLog(key: string, log: AgentLogEntry) {
  setState({ logs: { ...state.logs, [key]: [...(state.logs[key] || []), log] } });
}

function setError(key: string, msg: string) {
  setState({ errors: { ...state.errors, [key]: msg } });
}

function addResult(key: string, plan: TestPlan) {
  setState({
    results: { ...state.results, [key]: plan },
    resultsVersion: state.resultsVersion + 1,
  });
}

// Resolves on the first `result`; keeps merging later ones (the "approved" result after
// auto-test). Settles once and always clears its timer/listener so cancel is immediate.
function streamOne(
  pieceName: string,
  t: BatchTarget,
  signal: AbortSignal,
  cb: { onLog: (l: AgentLogEntry) => void; onResult: (p: TestPlan) => void },
): Promise<TestPlan> {
  return new Promise<TestPlan>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Cancelled')); return; }

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };

    const memory = t.existingPlan?.agent_memory || undefined;

    const callbacks = {
      onLog: (log: AgentLogEntry) => cb.onLog(log),
      onResult: (result: {
        planId: number;
        steps: TestPlan['steps'];
        agentMemory?: string;
        status: string;
      }) => {
        const hasUnfilledHuman = result.steps?.some(
          (s) => s.type === 'human_input' && !s.savedHumanResponse,
        );
        const plan: TestPlan = {
          id: result.planId,
          piece_name: pieceName,
          target_action: t.name,
          target_type: t.kind,
          steps: result.steps,
          status: result.status as 'draft' | 'approved',
          agent_memory: result.agentMemory || '',
          automation_status: hasUnfilledHuman ? 'requires_human' : 'fully_automated',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        cb.onResult(plan);          // merge every result (draft, then approved)
        finish(() => resolve(plan)); // resolve on the first
      },
      onError: (msg: string) => finish(() => reject(new Error(msg))),
      onDone: () => {
        // Ended without ever producing a result — don't hang the queue.
        finish(() => reject(new Error('Plan creation ended without a result')));
      },
    };

    const ctrl = t.kind === 'trigger'
      ? api.streamTriggerPlanV2(pieceName, t.name, callbacks, memory)
      : api.streamAiPlanV2(pieceName, t.name, callbacks, memory);

    function onAbort() {
      ctrl.abort();
      finish(() => reject(new Error('Cancelled')));
    }
    signal.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => finish(() => reject(new Error('Timeout: no result received'))), TARGET_TIMEOUT_MS);
  });
}

async function runLoop(opts: {
  pieceName: string;
  mode: 'create_missing' | 'replace_existing';
  targets: BatchTarget[];
  skipExisting: boolean;
}) {
  const { pieceName, mode, targets, skipExisting } = opts;

  // Abort any batch already in flight (possibly for another piece).
  batchController?.abort();
  const controller = new AbortController();
  batchController = controller;

  const items: BatchItem[] = targets.map(t => ({
    key: `${t.kind}:${t.name}`,
    kind: t.kind,
    name: t.name,
    displayName: t.displayName,
    status: skipExisting && t.existingPlan ? 'skipped' : 'pending',
  }));

  setState({
    pieceName,
    running: true,
    mode,
    items,
    logs: {},
    errors: {},
    results: {},
    resultsVersion: state.resultsVersion + 1,
    progress: { current: 0, total: targets.length, currentName: '' },
    showPanel: true,
  });

  for (let i = 0; i < targets.length; i++) {
    if (controller.signal.aborted) break;

    const t = targets[i];
    const key = `${t.kind}:${t.name}`;
    setState({ progress: { current: i + 1, total: targets.length, currentName: t.displayName } });

    if (skipExisting && t.existingPlan) {
      updateItem(key, 'skipped');
      continue;
    }

    updateItem(key, 'running');

    try {
      const plan = await streamOne(pieceName, t, controller.signal, {
        onLog: (log) => appendLog(key, log),
        onResult: (p) => addResult(key, p),
      });
      const hasUnfilledHuman = plan.steps.some(
        s => s.type === 'human_input' && !s.savedHumanResponse,
      );
      updateItem(key, hasUnfilledHuman ? 'waiting_human' : 'done');
    } catch (err) {
      if (controller.signal.aborted) break;
      const msg = err instanceof Error ? err.message : String(err);
      setError(key, msg);
      updateItem(key, 'error');
    }
  }

  if (batchController === controller) batchController = null;
  setState({ running: false, mode: null, progress: null });
}

// ── Public API ──

/** Create plans for actions/triggers that don't have one yet. */
export function startCreateMissing(params: {
  pieceName: string;
  actions: { name: string; displayName: string }[];
  triggers: { name: string; displayName: string }[];
  existingActionPlans: Record<string, TestPlan>;
  existingTriggerPlans: Record<string, TestPlan>;
}) {
  const targets: BatchTarget[] = [
    ...params.actions.map(a => ({
      kind: 'action' as const, name: a.name, displayName: a.displayName,
      existingPlan: params.existingActionPlans[a.name],
    })),
    ...params.triggers.map(tr => ({
      kind: 'trigger' as const, name: tr.name, displayName: tr.displayName,
      existingPlan: params.existingTriggerPlans[tr.name],
    })),
  ];
  if (targets.length === 0) return;
  void runLoop({ pieceName: params.pieceName, mode: 'create_missing', targets, skipExisting: true });
}

/** Rebuild an explicit list of targets (their existingPlan carries prior memory). */
export function startRebuild(params: { pieceName: string; targets: BatchTarget[] }) {
  if (params.targets.length === 0) return;
  void runLoop({ pieceName: params.pieceName, mode: 'replace_existing', targets: params.targets, skipExisting: false });
}

export function cancel() {
  batchController?.abort();
  batchController = null;
  setState({ running: false, mode: null, progress: null });
}

export function setShowPanel(v: boolean) {
  setState({ showPanel: v });
}

export const batchSetupRunner = {
  subscribe,
  getSnapshot,
  startCreateMissing,
  startRebuild,
  cancel,
  setShowPanel,
};

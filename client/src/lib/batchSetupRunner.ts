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

export const EMPTY_BATCH: BatchState = {
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

// Batches are keyed by piece so each piece keeps its own panel/progress independently.
let states: Record<string, BatchState> = {};
const controllers: Record<string, AbortController | null> = {};
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(pieceName: string, patch: Partial<BatchState>) {
  const prev = states[pieceName] ?? EMPTY_BATCH;
  states = { ...states, [pieceName]: { ...prev, ...patch } };
  emit();
}

// ── useSyncExternalStore contract (whole map; consumers select their piece) ──
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getSnapshot(): Record<string, BatchState> {
  return states;
}

export function getFor(pieceName: string): BatchState {
  return states[pieceName] ?? EMPTY_BATCH;
}

// ── Mutators ──
function updateItem(pieceName: string, key: string, status: BatchActionStatus) {
  const cur = states[pieceName] ?? EMPTY_BATCH;
  setState(pieceName, { items: cur.items.map(it => (it.key === key ? { ...it, status } : it)) });
}

function appendLog(pieceName: string, key: string, log: AgentLogEntry) {
  const cur = states[pieceName] ?? EMPTY_BATCH;
  setState(pieceName, { logs: { ...cur.logs, [key]: [...(cur.logs[key] || []), log] } });
}

function setError(pieceName: string, key: string, msg: string) {
  const cur = states[pieceName] ?? EMPTY_BATCH;
  setState(pieceName, { errors: { ...cur.errors, [key]: msg } });
}

function addResult(pieceName: string, key: string, plan: TestPlan) {
  const cur = states[pieceName] ?? EMPTY_BATCH;
  setState(pieceName, {
    results: { ...cur.results, [key]: plan },
    resultsVersion: cur.resultsVersion + 1,
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

  // Abort a prior batch for THIS piece only; other pieces keep running.
  controllers[pieceName]?.abort();
  const controller = new AbortController();
  controllers[pieceName] = controller;

  const items: BatchItem[] = targets.map(t => ({
    key: `${t.kind}:${t.name}`,
    kind: t.kind,
    name: t.name,
    displayName: t.displayName,
    status: skipExisting && t.existingPlan ? 'skipped' : 'pending',
  }));

  const prevVersion = (states[pieceName] ?? EMPTY_BATCH).resultsVersion;
  setState(pieceName, {
    pieceName,
    running: true,
    mode,
    items,
    logs: {},
    errors: {},
    results: {},
    resultsVersion: prevVersion + 1,
    progress: { current: 0, total: targets.length, currentName: '' },
    showPanel: true,
  });

  for (let i = 0; i < targets.length; i++) {
    if (controller.signal.aborted) break;

    const t = targets[i];
    const key = `${t.kind}:${t.name}`;
    setState(pieceName, { progress: { current: i + 1, total: targets.length, currentName: t.displayName } });

    if (skipExisting && t.existingPlan) {
      updateItem(pieceName, key, 'skipped');
      continue;
    }

    updateItem(pieceName, key, 'running');

    try {
      const plan = await streamOne(pieceName, t, controller.signal, {
        onLog: (log) => appendLog(pieceName, key, log),
        onResult: (p) => addResult(pieceName, key, p),
      });
      const hasUnfilledHuman = plan.steps.some(
        s => s.type === 'human_input' && !s.savedHumanResponse,
      );
      updateItem(pieceName, key, hasUnfilledHuman ? 'waiting_human' : 'done');
    } catch (err) {
      if (controller.signal.aborted) break;
      const msg = err instanceof Error ? err.message : String(err);
      setError(pieceName, key, msg);
      updateItem(pieceName, key, 'error');
    }
  }

  if (controllers[pieceName] === controller) controllers[pieceName] = null;
  setState(pieceName, { running: false, mode: null, progress: null });
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

/**
 * Rebuild the panel after a page reload by reconnecting to jobs the server still
 * has running (their SSE events are buffered and replayed). Only runs when this
 * piece has no in-memory batch, so a live run is never disturbed.
 */
export function resumeFromJobs(params: {
  pieceName: string;
  jobs: { kind: 'action' | 'trigger'; name: string; displayName: string }[];
}) {
  const { pieceName, jobs } = params;
  const existing = states[pieceName];
  if (existing && existing.items.length > 0) return;
  if (jobs.length === 0) return;

  controllers[pieceName]?.abort();
  const controller = new AbortController();
  controllers[pieceName] = controller;

  const items: BatchItem[] = jobs.map(j => ({
    key: `${j.kind}:${j.name}`, kind: j.kind, name: j.name, displayName: j.displayName, status: 'running',
  }));
  setState(pieceName, {
    pieceName,
    running: true,
    mode: 'create_missing',
    items,
    logs: {},
    errors: {},
    results: {},
    resultsVersion: (existing?.resultsVersion ?? 0) + 1,
    progress: { current: 0, total: items.length, currentName: '' },
    showPanel: true,
  });

  let completed = 0;
  void (async () => {
    await Promise.all(jobs.map(async (j) => {
      const key = `${j.kind}:${j.name}`;
      try {
        const plan = await streamOne(pieceName, j, controller.signal, {
          onLog: (log) => appendLog(pieceName, key, log),
          onResult: (p) => addResult(pieceName, key, p),
        });
        const human = plan.steps.some(s => s.type === 'human_input' && !s.savedHumanResponse);
        updateItem(pieceName, key, human ? 'waiting_human' : 'done');
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(pieceName, key, err instanceof Error ? err.message : String(err));
          updateItem(pieceName, key, 'error');
        }
      } finally {
        completed += 1;
        setState(pieceName, { progress: { current: completed, total: items.length, currentName: '' } });
      }
    }));
    if (controllers[pieceName] === controller) controllers[pieceName] = null;
    setState(pieceName, { running: false, mode: null, progress: null });
  })();
}

export function cancel(pieceName: string) {
  controllers[pieceName]?.abort();
  controllers[pieceName] = null;
  setState(pieceName, { running: false, mode: null, progress: null });
}

export function setShowPanel(pieceName: string, v: boolean) {
  setState(pieceName, { showPanel: v });
}

export const batchSetupRunner = {
  subscribe,
  getSnapshot,
  getFor,
  startCreateMissing,
  startRebuild,
  resumeFromJobs,
  cancel,
  setShowPanel,
};

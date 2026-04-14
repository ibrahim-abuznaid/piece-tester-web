const BASE = '/api';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

// ── SSE stream reader for AI agent ──

export interface AgentLogEntry {
  timestamp: number;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'decision' | 'error' | 'done' | 'worker_spawn' | 'worker_complete' | 'phase' | 'mcp_call';
  message: string;
  detail?: string;
  role?: string;
}

export interface AiCostSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_requests: number;
  by_version: { version: string; cost_usd: number; requests: number }[];
  by_operation: { operation: string; cost_usd: number; requests: number }[];
}

export interface AiUsageRow {
  id: number;
  session_id: string;
  piece_name: string;
  action_name: string;
  agent_role: string;
  agent_version: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  operation: string;
  created_at: string;
}

export interface AiActionResult {
  actionName: string;
  displayName: string;
  description: string;
  input: Record<string, unknown>;
  fields: {
    propName: string;
    displayName: string;
    type: string;
    confidence: 'auto' | 'review' | 'required';
    explanation: string;
    value: unknown;
  }[];
  readyToTest: boolean;
  note: string;
  agentMemory?: string;
  errorDiagnosis?: {
    type: 'config_issue' | 'piece_bug' | 'transient' | 'unknown';
    explanation: string;
  };
}

export interface AiStreamCallbacks {
  onLog: (log: AgentLogEntry) => void;
  onResult: (result: AiActionResult) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

/**
 * Connect to the AI agent SSE stream for a specific action.
 * Returns an AbortController so the caller can cancel the stream.
 */
function streamAiConfig(
  pieceName: string,
  actionName: string,
  callbacks: AiStreamCallbacks,
  previousMemory?: string,
): AbortController {
  const controller = new AbortController();
  let url = `${BASE}/pieces/${encodeURIComponent(pieceName)}/actions/${encodeURIComponent(actionName)}/ai-config`;
  if (previousMemory) url += `?memory=${encodeURIComponent(previousMemory)}`;

  (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const errText = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${errText}`);
        callbacks.onDone();
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        callbacks.onError('No response body');
        callbacks.onDone();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // Keep incomplete event in buffer

        for (const eventStr of events) {
          if (!eventStr.trim()) continue;

          const lines = eventStr.split('\n');
          let eventType = '';
          let data = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7);
            } else if (line.startsWith('data: ')) {
              data = line.slice(6);
            }
          }

          if (!eventType || !data) continue;

          try {
            const parsed = JSON.parse(data);

            switch (eventType) {
              case 'log':
                callbacks.onLog(parsed);
                break;
              case 'result':
                callbacks.onResult(parsed);
                break;
              case 'error':
                callbacks.onError(parsed.message || 'Unknown error');
                break;
              case 'done':
                callbacks.onDone();
                break;
            }
          } catch (e) {
            console.warn('[sse] Failed to parse event data:', data);
          }
        }
      }

      // Stream ended without 'done' event
      callbacks.onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        callbacks.onError(err.message || 'Connection failed');
        callbacks.onDone();
      }
    }
  })();

  return controller;
}

/**
 * Connect to the AI fix agent SSE stream after a test failure.
 */
function streamAiFix(
  pieceName: string,
  actionName: string,
  previousConfig: Record<string, unknown>,
  testError: string,
  agentMemory: string | undefined,
  callbacks: AiStreamCallbacks,
): AbortController {
  const controller = new AbortController();
  const url = `${BASE}/pieces/${encodeURIComponent(pieceName)}/actions/${encodeURIComponent(actionName)}/ai-fix`;

  (async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previousConfig, testError, agentMemory }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${errText}`);
        callbacks.onDone();
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) { callbacks.onError('No response body'); callbacks.onDone(); return; }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const eventStr of events) {
          if (!eventStr.trim()) continue;
          const lines = eventStr.split('\n');
          let eventType = '', data = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (!eventType || !data) continue;
          try {
            const parsed = JSON.parse(data);
            if (eventType === 'log') callbacks.onLog(parsed);
            else if (eventType === 'result') callbacks.onResult(parsed);
            else if (eventType === 'error') callbacks.onError(parsed.message || 'Unknown error');
            else if (eventType === 'done') callbacks.onDone();
          } catch { /* skip parse errors */ }
        }
      }
      callbacks.onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') { callbacks.onError(err.message); callbacks.onDone(); }
    }
  })();

  return controller;
}

// ── Test Plan types ──

export interface TestPlanStep {
  id: string;
  type: 'setup' | 'test' | 'verify' | 'cleanup' | 'human_input';
  label: string;
  description: string;
  actionName: string;
  input: Record<string, unknown>;
  inputMapping: Record<string, string>;
  requiresApproval: boolean;
  humanPrompt?: string;
  /** Saved human response for automatic reuse in future/scheduled runs */
  savedHumanResponse?: string;
}

export interface TestPlan {
  id: number;
  piece_name: string;
  target_action: string;
  steps: TestPlanStep[];
  status: 'draft' | 'approved';
  agent_memory: string;
  automation_status: 'fully_automated' | 'requires_human' | 'unknown';
  created_at: string;
  updated_at: string;
}

export interface TestPlanExportBundle {
  exported_at: string;
  piece_name: string;
  action_names: string[];
  plans: TestPlan[];
}

export interface StepResult {
  stepId: string;
  label?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
  output: unknown;
  error: string | null;
  duration_ms: number;
  humanResponse?: string;
}

export interface PlanProgress {
  type: 'step_start' | 'step_complete' | 'step_failed' | 'paused_for_human' | 'paused_for_approval' | 'plan_complete' | 'plan_failed' | 'error';
  runId: number;
  stepId?: string;
  stepResult?: StepResult;
  pausedPrompt?: string;
  message?: string;
  stepResults?: StepResult[];
}

export interface PlanStreamCallbacks {
  onLog: (log: AgentLogEntry) => void;
  onResult: (result: {
    planId: number;
    steps: TestPlanStep[];
    note: string;
    agentMemory?: string;
    status: string;
    autoTestPassed?: boolean;
    autoTestAttempts?: number;
    version?: string;
    costSummary?: {
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      requests: number;
    };
  }) => void;
  onPlanProgress?: (progress: PlanProgress) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

export interface PlanExecutionCallbacks {
  onProgress: (progress: PlanProgress) => void;
  onDone: (data: { runId: number; status: string; step_results: StepResult[] }) => void;
  onError: (message: string) => void;
}

export interface PlanRunRecord {
  id: number;
  plan_id: number;
  status: string;
  trigger_type: string; // 'manual' | 'scheduled'
  current_step_id: string | null;
  step_results: StepResult[];
  paused_prompt: string | null;
  started_at: string;
  completed_at: string | null;
  // Joined from test_plans
  piece_name: string;
  target_action: string;
}

/**
 * Stream AI plan creation via SSE.
 */
function streamAiPlan(
  pieceName: string,
  actionName: string,
  callbacks: PlanStreamCallbacks,
  previousMemory?: string,
): AbortController {
  const controller = new AbortController();
  let url = `${BASE}/pieces/${encodeURIComponent(pieceName)}/actions/${encodeURIComponent(actionName)}/ai-plan`;
  if (previousMemory) url += `?memory=${encodeURIComponent(previousMemory)}`;

  (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const errText = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${errText}`);
        callbacks.onDone();
        return;
      }
      await readSSE(response, {
        log: (d: any) => callbacks.onLog(d),
        result: (d: any) => callbacks.onResult(d),
        plan_progress: (d: any) => callbacks.onPlanProgress?.(d),
        error: (d: any) => callbacks.onError(d.message || 'Unknown error'),
        done: () => callbacks.onDone(),
      });
      callbacks.onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') { callbacks.onError(err.message); callbacks.onDone(); }
    }
  })();

  return controller;
}

/**
 * Subscribe to an already-running AI plan background job.
 * Replays buffered events and streams live events until completion.
 */
function subscribeAiPlanJob(
  pieceName: string,
  actionName: string,
  callbacks: PlanStreamCallbacks,
): AbortController {
  const controller = new AbortController();
  const url = `${BASE}/pieces/${encodeURIComponent(pieceName)}/actions/${encodeURIComponent(actionName)}/ai-plan/subscribe`;

  (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        if (response.status === 404) {
          callbacks.onDone();
          return;
        }
        const errText = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${errText}`);
        callbacks.onDone();
        return;
      }
      await readSSE(response, {
        log: (d: any) => callbacks.onLog(d),
        result: (d: any) => callbacks.onResult(d),
        plan_progress: (d: any) => callbacks.onPlanProgress?.(d),
        error: (d: any) => callbacks.onError(d.message || 'Unknown error'),
        done: () => callbacks.onDone(),
      });
      callbacks.onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') { callbacks.onError(err.message); callbacks.onDone(); }
    }
  })();

  return controller;
}

/**
 * Stream AI plan fix via SSE (POST with failed step results).
 */
function streamAiPlanFix(
  pieceName: string,
  actionName: string,
  previousSteps: TestPlanStep[],
  stepResults: StepResult[],
  agentMemory: string | undefined,
  callbacks: PlanStreamCallbacks,
): AbortController {
  const controller = new AbortController();
  const url = `${BASE}/pieces/${encodeURIComponent(pieceName)}/actions/${encodeURIComponent(actionName)}/ai-plan-fix`;

  (async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previousSteps, stepResults, agentMemory }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${errText}`);
        callbacks.onDone();
        return;
      }
      await readSSE(response, {
        log: (d: any) => callbacks.onLog(d),
        result: (d: any) => callbacks.onResult(d),
        error: (d: any) => callbacks.onError(d.message || 'Unknown error'),
        done: () => callbacks.onDone(),
      });
      callbacks.onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') { callbacks.onError(err.message); callbacks.onDone(); }
    }
  })();

  return controller;
}

/**
 * Stream AI plan creation via SSE using v2 multi-agent system.
 */
function streamAiPlanV2(
  pieceName: string,
  actionName: string,
  callbacks: PlanStreamCallbacks,
  previousMemory?: string,
): AbortController {
  const controller = new AbortController();
  let url = `${BASE}/pieces/${encodeURIComponent(pieceName)}/actions/${encodeURIComponent(actionName)}/ai-plan-v2`;
  if (previousMemory) url += `?memory=${encodeURIComponent(previousMemory)}`;

  (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const errText = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${errText}`);
        callbacks.onDone();
        return;
      }
      await readSSE(response, {
        log: (d: any) => callbacks.onLog(d),
        result: (d: any) => callbacks.onResult(d),
        plan_progress: (d: any) => callbacks.onPlanProgress?.(d),
        error: (d: any) => callbacks.onError(d.message || 'Unknown error'),
        done: () => callbacks.onDone(),
      });
      callbacks.onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') { callbacks.onError(err.message); callbacks.onDone(); }
    }
  })();

  return controller;
}

/**
 * Stream AI plan fix via SSE using v2 multi-agent system.
 */
function streamAiPlanFixV2(
  pieceName: string,
  actionName: string,
  previousSteps: TestPlanStep[],
  stepResults: StepResult[],
  agentMemory: string | undefined,
  callbacks: PlanStreamCallbacks,
): AbortController {
  const controller = new AbortController();
  const url = `${BASE}/pieces/${encodeURIComponent(pieceName)}/actions/${encodeURIComponent(actionName)}/ai-plan-fix-v2`;

  (async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previousSteps, stepResults, agentMemory }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${errText}`);
        callbacks.onDone();
        return;
      }
      await readSSE(response, {
        log: (d: any) => callbacks.onLog(d),
        result: (d: any) => callbacks.onResult(d),
        error: (d: any) => callbacks.onError(d.message || 'Unknown error'),
        done: () => callbacks.onDone(),
      });
      callbacks.onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') { callbacks.onError(err.message); callbacks.onDone(); }
    }
  })();

  return controller;
}

/**
 * Stream plan execution via SSE.
 */
function streamPlanExecution(
  planId: number,
  callbacks: PlanExecutionCallbacks,
): AbortController {
  const controller = new AbortController();
  const url = `${BASE}/test-plans/${planId}/run`;

  (async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${errText}`);
        return;
      }
      await readSSE(response, {
        progress: (d: any) => callbacks.onProgress(d),
        done: (d: any) => callbacks.onDone(d),
        error: (d: any) => callbacks.onError(d.message || 'Unknown error'),
      });
    } catch (err: any) {
      if (err.name !== 'AbortError') { callbacks.onError(err.message); }
    }
  })();

  return controller;
}

/** Shared SSE reader */
async function readSSE(response: Response, handlers: Record<string, (data: any) => void>) {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const eventStr of events) {
      if (!eventStr.trim()) continue;
      const lines = eventStr.split('\n');
      let eventType = '', data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (!eventType || !data) continue;
      try {
        const parsed = JSON.parse(data);
        if (handlers[eventType]) handlers[eventType](parsed);
      } catch { /* skip parse errors */ }
    }
  }
}

// ── Batch Setup types ──

export interface BatchQueueItemStatus {
  pieceName: string;
  pieceDisplayName: string;
  actionName: string;
  actionDisplayName: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
}

export interface BatchStatus {
  id: string;
  status: 'running' | 'done' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  currentIndex: number;
  totalItems: number;
  items: BatchQueueItemStatus[];
  stats: { pending: number; running: number; done: number; error: number; skipped: number };
}

export interface BatchStreamCallbacks {
  onItemUpdate: (data: BatchQueueItemStatus & { index: number }) => void;
  onLog: (data: { index: number; pieceName: string; actionName: string; log: AgentLogEntry }) => void;
  onPlanCreated: (data: { index: number; pieceName: string; actionName: string; planId: number; steps: TestPlanStep[]; status: string }) => void;
  onPlanApproved: (data: { index: number; pieceName: string; actionName: string; planId: number }) => void;
  onBatchDone: (data: { status: string }) => void;
  onError: (message: string) => void;
}

function subscribeBatchSetup(callbacks: BatchStreamCallbacks): AbortController {
  const controller = new AbortController();
  const url = `${BASE}/batch-setup/subscribe`;

  (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        if (response.status === 404) {
          callbacks.onBatchDone({ status: 'no_queue' });
          return;
        }
        const errText = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${errText}`);
        return;
      }
      await readSSE(response, {
        item_update: (d: any) => callbacks.onItemUpdate(d),
        log: (d: any) => callbacks.onLog(d),
        plan_created: (d: any) => callbacks.onPlanCreated(d),
        plan_approved: (d: any) => callbacks.onPlanApproved(d),
        batch_done: (d: any) => callbacks.onBatchDone(d),
        error: (d: any) => callbacks.onError(d.message || 'Unknown error'),
      });
    } catch (err: any) {
      if (err.name !== 'AbortError') { callbacks.onError(err.message); }
    }
  })();

  return controller;
}

export const api = {
  // Settings
  getSettings: () => request<any>('GET', '/settings'),
  updateSettings: (data: any) => request<any>('PUT', '/settings', data),
  testConnection: (data?: any) => request<any>('POST', '/settings/test-connection', data ?? {}),
  signIn: (email: string, password: string) => request<any>('POST', '/settings/sign-in', { email, password }),
  saveToken: (token: string) => request<any>('POST', '/settings/save-token', { token }),
  signOut: () => request<any>('POST', '/settings/sign-out'),
  saveAnthropicKey: (api_key: string, model?: string) => request<any>('POST', '/settings/save-anthropic-key', { api_key, model }),
  removeAnthropicKey: () => request<any>('POST', '/settings/remove-anthropic-key'),
  saveMcpToken: (mcp_token: string) => request<any>('POST', '/settings/save-mcp-token', { mcp_token }),
  removeMcpToken: () => request<any>('POST', '/settings/remove-mcp-token'),
  fetchMcpToken: () => request<any>('POST', '/settings/fetch-mcp-token'),

  // Pieces
  listPieces: () => request<any[]>('GET', '/pieces'),
  /** Cancel a running background plan-creation job (v1 or v2). Does not stop direct SSE fix/config streams — use AbortController.abort() for those. */
  cancelAiPlanJob: (pieceName: string, actionName: string, useV2: boolean) =>
    request<{ cancelled: boolean }>(
      'POST',
      `/pieces/${encodeURIComponent(pieceName)}/actions/${encodeURIComponent(actionName)}/${useV2 ? 'ai-plan-v2/cancel' : 'ai-plan/cancel'}`,
    ),
  /** Cancel every running AI plan creation job on the server (Claude + executePlan). */
  cancelAllAiPlanJobs: () =>
    request<{ cancelled: number }>('POST', '/pieces/abort-all-ai-jobs'),
  getPiece: (name: string) => request<any>('GET', `/pieces/${encodeURIComponent(name)}`),
  getAutoConfig: (name: string) => request<any>('GET', `/pieces/${encodeURIComponent(name)}/auto-config`),

  // AI Agent (SSE streaming)
  streamAiConfig,
  streamAiFix,

  // Connections
  listConnections: () => request<any[]>('GET', '/connections'),
  listConnectionsForPiece: (pieceName: string) => request<any[]>('GET', `/connections/piece/${encodeURIComponent(pieceName)}`),
  activateConnection: (id: number) => request<any>('POST', `/connections/${id}/activate`),
  saveActionConfig: (connId: number, actionName: string, data: { input?: Record<string, unknown>; ai_meta?: any; enabled?: boolean }) =>
    request<any>('PATCH', `/connections/${connId}/action/${encodeURIComponent(actionName)}`, data),
  saveActionsBulk: (connId: number, data: { actions_config?: Record<string, any>; ai_config_meta?: Record<string, any> }) =>
    request<any>('PATCH', `/connections/${connId}/actions-bulk`, data),
  listRemoteConnections: () => request<any[]>('GET', '/connections/remote'),
  listRemoteConnectionsForPiece: (pieceName: string) => request<any[]>('GET', `/connections/remote/${encodeURIComponent(pieceName)}`),
  importConnection: (data: any) => request<any>('POST', '/connections/import', data),
  getApDashboardUrl: () => request<{ dashboardUrl: string; projectId: string }>('GET', '/connections/ap-dashboard-url'),
  createConnection: (data: any) => request<any>('POST', '/connections', data),
  updateConnection: (id: number, data: any) => request<any>('PUT', `/connections/${id}`, data),
  deleteConnection: (id: number) => request<any>('DELETE', `/connections/${id}`),

  // Tests
  runTests: (pieceNames?: string[]) => request<{ runId: number }>('POST', '/tests/run', { pieceNames }),
  getTestStatus: (runId: number) => request<any>('GET', `/tests/status/${runId}`),

  // History
  listHistory: (limit = 20, offset = 0) => request<any[]>('GET', `/history?limit=${limit}&offset=${offset}`),
  getHistoryRun: (runId: number) => request<any>('GET', `/history/${runId}`),

  // Schedules
  listSchedules: () => request<any[]>('GET', '/schedules'),
  createSchedule: (data: any) => request<any>('POST', '/schedules', data),
  updateSchedule: (id: number, data: any) => request<any>('PUT', `/schedules/${id}`, data),
  deleteSchedule: (id: number) => request<any>('DELETE', `/schedules/${id}`),

  // Test Plans (v1)
  streamAiPlan,
  streamAiPlanFix,
  streamPlanExecution,

  // Test Plans (v2 multi-agent)
  streamAiPlanV2,
  streamAiPlanFixV2,
  getTestPlan: (planId: number) => request<TestPlan>('GET', `/test-plans/${planId}`),
  getTestPlanByAction: (pieceName: string, actionName: string) =>
    request<TestPlan>('GET', `/test-plans/by-action/${encodeURIComponent(pieceName)}/${encodeURIComponent(actionName)}`),
  updateTestPlan: (planId: number, data: { steps?: TestPlanStep[]; status?: string; agent_memory?: string }) =>
    request<TestPlan>('PATCH', `/test-plans/${planId}`, data),
  deleteTestPlan: (planId: number) => request<any>('DELETE', `/test-plans/${planId}`),
  listTestPlans: (pieceName?: string) =>
    request<TestPlan[]>('GET', `/test-plans${pieceName ? `?piece=${encodeURIComponent(pieceName)}` : ''}`),
  exportTestPlans: (pieceName: string, actionNames?: string[]) => {
    const params = new URLSearchParams();
    params.set('piece', pieceName);
    if (actionNames && actionNames.length > 0) {
      params.set('actions', actionNames.join(','));
    }
    return request<TestPlanExportBundle>('GET', `/test-plans/export?${params.toString()}`);
  },
  getPlanRun: (runId: number) => request<any>('GET', `/test-plans/runs/${runId}`),
  listPlanRuns: (planId: number) => request<any[]>('GET', `/test-plans/${planId}/runs`),
  respondToPlanRun: (runId: number, data: { stepId: string; approved?: boolean; humanResponse?: string }) =>
    request<any>('POST', `/test-plans/runs/${runId}/respond`, data),
  deletePlansByPiece: (pieceName: string, actionNames?: string[]) => {
    const params = new URLSearchParams();
    params.set('piece', pieceName);
    if (actionNames && actionNames.length > 0) {
      params.set('actions', actionNames.join(','));
    }
    return request<{ success: boolean; deleted: number }>('DELETE', `/test-plans?${params.toString()}`);
  },

  // AI Plan Jobs (background)
  getAiPlanJobs: (pieceName: string) =>
    request<Record<string, { status: string; startedAt: number }>>('GET', `/pieces/${encodeURIComponent(pieceName)}/ai-plan-jobs`),
  subscribeAiPlanJob: subscribeAiPlanJob,

  // Piece Lessons
  getLessons: (pieceName: string) => request<{ id: number; lesson: string; source: string; created_at: string }[]>('GET', `/pieces/${encodeURIComponent(pieceName)}/lessons`),
  addLesson: (pieceName: string, lesson: string) => request<{ id: number; lesson: string; source: string; created_at: string }>('POST', `/pieces/${encodeURIComponent(pieceName)}/lessons`, { lesson }),
  deleteLesson: (pieceName: string, lessonId: number) => request<{ success: boolean }>('DELETE', `/pieces/${encodeURIComponent(pieceName)}/lessons/${lessonId}`),

  // Reports
  getReportStats: (dateFrom?: string, dateTo?: string) => {
    const p = new URLSearchParams();
    if (dateFrom) p.set('date_from', dateFrom);
    if (dateTo) p.set('date_to', dateTo);
    const qs = p.toString();
    return request<any>('GET', `/reports/stats${qs ? `?${qs}` : ''}`);
  },
  getReportPieceBreakdown: (dateFrom?: string, dateTo?: string) => {
    const p = new URLSearchParams();
    if (dateFrom) p.set('date_from', dateFrom);
    if (dateTo) p.set('date_to', dateTo);
    const qs = p.toString();
    return request<any[]>('GET', `/reports/piece-breakdown${qs ? `?${qs}` : ''}`);
  },
  getReportTrends: (dateFrom?: string, dateTo?: string) => {
    const p = new URLSearchParams();
    if (dateFrom) p.set('date_from', dateFrom);
    if (dateTo) p.set('date_to', dateTo);
    const qs = p.toString();
    return request<any[]>('GET', `/reports/trends${qs ? `?${qs}` : ''}`);
  },
  getReportFailures: (limit = 50, dateFrom?: string, dateTo?: string) => {
    const p = new URLSearchParams();
    p.set('limit', String(limit));
    if (dateFrom) p.set('date_from', dateFrom);
    if (dateTo) p.set('date_to', dateTo);
    return request<any[]>('GET', `/reports/failures?${p.toString()}`);
  },
  getReportAnalyses: (limit = 10) => request<any[]>('GET', `/reports/analyses?limit=${limit}`),
  getLatestAnalysis: () => request<any>('GET', '/reports/latest-analysis'),
  getRunningAnalysis: () => request<any>('GET', '/reports/analysis/running'),
  getAnalysis: (id: number) => request<any>('GET', `/reports/analysis/${id}`),
  startAnalysis: (params: { time_range: string; date_from?: string; date_to?: string }) =>
    request<{ id: number }>('POST', '/reports/analyze', params),
  getResolvedIssues: (analysisId: number) =>
    request<any[]>('GET', `/reports/analysis/${analysisId}/resolved`),
  resolveIssue: (analysisId: number, params: { category: string; item_index: number; run_id?: number; piece_name?: string; action_name?: string; note?: string }) =>
    request<any>('POST', `/reports/analysis/${analysisId}/resolve`, params),
  unresolveIssue: (analysisId: number, params: { category: string; item_index: number }) =>
    request<any>('POST', `/reports/analysis/${analysisId}/unresolve`, params),
  updateResolvedNote: (resolvedId: number, note: string) =>
    request<any>('PATCH', `/reports/resolved-issues/${resolvedId}/note`, { note }),
  getRunInfo: (runId: number) =>
    request<{ run_id: number; plan_id: number; piece_name: string; target_action: string; status: string }>('GET', `/reports/run-info/${runId}`),
  runPlanBackground: (planId: number) =>
    request<{ run_id: number; plan_id: number }>('POST', `/test-plans/${planId}/run-background`, { trigger_type: 'retest' }),

  // Delete plan runs
  deletePlanRun: (runId: number) =>
    request<{ success: boolean }>('DELETE', `/test-plans/runs/${runId}`),
  deleteAllPlanRuns: (before?: string) =>
    request<{ success: boolean; deleted: number }>('DELETE', `/test-plans/runs${before ? `?before=${encodeURIComponent(before)}` : ''}`),

  // Delete legacy history runs
  deleteHistoryRun: (runId: number) =>
    request<{ success: boolean }>('DELETE', `/history/${runId}`),
  deleteAllHistoryRuns: (before?: string) =>
    request<{ success: boolean; deleted: number }>('DELETE', `/history${before ? `?before=${encodeURIComponent(before)}` : ''}`),

  // Batch Setup
  startBatchSetup: (pieceNames: string[]) =>
    request<{ id: string; totalItems: number; pendingItems: number; skippedItems: number }>('POST', '/batch-setup/start', { pieceNames }),
  getBatchStatus: () => request<BatchStatus | null>('GET', '/batch-setup/status'),
  subscribeBatchSetup,
  cancelBatchSetup: () => request<{ success: boolean }>('POST', '/batch-setup/cancel'),

  // Global plan run history
  listAllPlanRuns: (options?: { pieceName?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (options?.pieceName) params.set('piece', options.pieceName);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const qs = params.toString();
    return request<PlanRunRecord[]>('GET', `/test-plans/runs/all${qs ? `?${qs}` : ''}`);
  },

  // AI Cost Tracking
  getAiCostSummary: (filters?: { piece_name?: string; date_from?: string; date_to?: string }) => {
    const params = new URLSearchParams();
    if (filters?.piece_name) params.set('piece_name', filters.piece_name);
    if (filters?.date_from) params.set('date_from', filters.date_from);
    if (filters?.date_to) params.set('date_to', filters.date_to);
    const qs = params.toString();
    return request<AiCostSummary>('GET', `/settings/ai-costs${qs ? `?${qs}` : ''}`);
  },
  getAiCostRecent: (limit = 100) =>
    request<AiUsageRow[]>('GET', `/settings/ai-costs/recent?limit=${limit}`),
  getAiCostBySession: (sessionId: string) =>
    request<AiUsageRow[]>('GET', `/settings/ai-costs/session/${sessionId}`),
  getAiCostByPiece: (pieceName: string, limit = 50) =>
    request<AiUsageRow[]>('GET', `/settings/ai-costs/piece/${encodeURIComponent(pieceName)}?limit=${limit}`),
};

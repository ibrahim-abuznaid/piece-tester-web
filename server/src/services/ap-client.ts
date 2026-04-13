import axios, { AxiosInstance, AxiosError } from 'axios';

// ── Types (shared with client via API responses) ──

export interface PieceMetadataSummary {
  name: string;
  displayName: string;
  description: string;
  logoUrl: string;
  version: string;
  actions: number;
  triggers: number;
  auth?: unknown;
  categories?: string[];
  pieceType: string;
  packageType: string;
}

export interface PieceActionMeta {
  name: string;
  displayName: string;
  description: string;
  requireAuth: boolean;
  props: Record<string, unknown>;
}

export interface PieceTriggerMeta {
  name: string;
  displayName: string;
  description: string;
  type: string;
  requireAuth: boolean;
  props: Record<string, unknown>;
}

export interface PieceMetadataFull {
  name: string;
  displayName: string;
  description: string;
  logoUrl: string;
  version: string;
  auth?: { type: string; description?: string; props?: Record<string, unknown>; [k: string]: unknown };
  actions: Record<string, PieceActionMeta>;
  triggers: Record<string, PieceTriggerMeta>;
  categories?: string[];
  pieceType: string;
  packageType: string;
}

export interface PopulatedFlow {
  id: string;
  projectId: string;
  status: string;
  version: { id: string; flowId: string; displayName: string; trigger: Record<string, unknown>; valid: boolean; state: string; [k: string]: unknown };
  [k: string]: unknown;
}

export type FlowRunStatus = 'SUCCEEDED' | 'FAILED' | 'RUNNING' | 'QUEUED' | 'PAUSED' | 'INTERNAL_ERROR' | 'TIMEOUT' | 'CANCELED' | 'QUOTA_EXCEEDED' | 'MEMORY_LIMIT_EXCEEDED';

export const TERMINAL_STATUSES: FlowRunStatus[] = ['SUCCEEDED', 'FAILED', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELED', 'QUOTA_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED'];

export interface FlowRun {
  id: string;
  projectId: string;
  flowId: string;
  flowVersionId: string;
  status: FlowRunStatus;
  startTime?: string;
  finishTime?: string;
  steps: Record<string, unknown> | null;
  failedStep?: { name: string; displayName: string };
  [k: string]: unknown;
}

export interface AppConnection {
  id: string;
  pieceName: string;
  displayName: string;
  projectId: string;
  externalId: string;
  type: string;
  status: string;
  [k: string]: unknown;
}

interface SeekPage<T> { data: T[]; next: string | null; previous: string | null }

// ── Client ──

export class ActivepiecesClient {
  private http: AxiosInstance;
  private projectId: string;
  /** If set, this JWT token is used for endpoints that require a user principal (test-step) */
  private jwtToken: string | null;

  constructor(baseUrl: string, apiKey: string, projectId: string, jwtToken?: string) {
    this.projectId = projectId;
    this.jwtToken = jwtToken || null;
    this.http = axios.create({
      baseURL: baseUrl.replace(/\/+$/, ''),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
  }

  hasJwtToken(): boolean { return !!this.jwtToken; }

  /** Create an axios instance authenticated with the JWT token (for user-only endpoints) */
  private jwtHttp(): AxiosInstance {
    if (!this.jwtToken) throw new Error('JWT token not configured. Sign in via Settings to enable step testing.');
    return axios.create({
      baseURL: this.http.defaults.baseURL,
      headers: { Authorization: `Bearer ${this.jwtToken}`, 'Content-Type': 'application/json' },
      timeout: 120_000, // test-step can take a while
    });
  }

  /**
   * Sign in to AP and return a JWT token.
   * This token has a real user ID needed for the test-step endpoint.
   */
  static async signIn(baseUrl: string, email: string, password: string): Promise<{ token: string; projectId: string }> {
    const resp = await axios.post(`${baseUrl.replace(/\/+$/, '')}/v1/authentication/sign-in`, { email, password });
    return { token: resp.data.token ?? resp.data.body?.token ?? resp.data, projectId: resp.data.projectId };
  }

  // Pieces
  async listPieces(): Promise<PieceMetadataSummary[]> {
    const { data } = await this.http.get<PieceMetadataSummary[]>('/v1/pieces', { params: { projectId: this.projectId } });
    return data;
  }

  async getPieceMetadata(name: string): Promise<PieceMetadataFull> {
    const { data } = await this.http.get<PieceMetadataFull>(`/v1/pieces/${encodeURIComponent(name)}`, { params: { projectId: this.projectId } });
    return data;
  }

  // Connections
  async upsertConnection(params: { externalId: string; displayName: string; pieceName: string; type: string; value: Record<string, unknown> }): Promise<AppConnection> {
    const { data } = await this.http.post<AppConnection>('/v1/app-connections', { ...params, projectId: this.projectId });
    return data;
  }

  async listConnections(): Promise<AppConnection[]> {
    const { data } = await this.http.get<SeekPage<AppConnection>>('/v1/app-connections', { params: { projectId: this.projectId, limit: 100 } });
    return data.data;
  }

  // Flows
  async createFlow(displayName: string): Promise<PopulatedFlow> {
    const { data } = await this.http.post<PopulatedFlow>('/v1/flows', { displayName, projectId: this.projectId });
    return data;
  }

  async applyFlowOperation(flowId: string, operation: Record<string, unknown>): Promise<PopulatedFlow> {
    const { data } = await this.http.post<PopulatedFlow>(`/v1/flows/${flowId}`, operation);
    return data;
  }

  async deleteFlow(flowId: string): Promise<void> {
    await this.http.delete(`/v1/flows/${flowId}`, {
      headers: { 'Content-Type': undefined },
    });
  }

  /**
   * Delete a flow with retry logic to handle transient failures and
   * FLOW_OPERATION_IN_PROGRESS errors (e.g. flow still being disabled).
   * Waits for operationStatus to become NONE before each delete attempt.
   */
  async deleteFlowSafely(flowId: string, maxAttempts = 5, label = ''): Promise<void> {
    const tag = label ? `[${label}]` : '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Check if the flow's operationStatus is still in progress
        try {
          const flow = await this.getFlow(flowId);
          const opStatus = (flow as Record<string, unknown>).operationStatus as string | undefined;
          if (opStatus && opStatus !== 'NONE' && opStatus !== 'DELETING') {
            console.log(`${tag} Flow ${flowId} operationStatus=${opStatus}, waiting before delete (attempt ${attempt})...`);
            await new Promise(r => setTimeout(r, 3_000));
            continue;
          }
          if (opStatus === 'DELETING') {
            console.log(`${tag} Flow ${flowId} already being deleted.`);
            return;
          }
        } catch {
          // Flow might already be deleted (404) -- that's fine
          return;
        }

        await this.deleteFlow(flowId);
        console.log(`${tag} Deleted test flow ${flowId} (attempt ${attempt})`);
        return;
      } catch (err) {
        const msg = ActivepiecesClient.formatError(err);
        if (attempt < maxAttempts) {
          console.warn(`${tag} Delete attempt ${attempt}/${maxAttempts} failed for flow ${flowId}: ${msg} -- retrying...`);
          await new Promise(r => setTimeout(r, attempt * 2_000));
        } else {
          console.error(`${tag} FAILED to delete test flow ${flowId} after ${maxAttempts} attempts: ${msg}. Delete it manually.`);
        }
      }
    }
  }

  // ── Step testing (requires JWT token -- has a real user ID) ──

  /**
   * Test a single step in a flow. Requires JWT auth (not API key).
   * Creates a TESTING flow run, executes up to the named step, and returns the run.
   * The run is accessible via getFlowRun().
   */
  async testStep(flowVersionId: string, stepName: string): Promise<FlowRun> {
    const { data } = await this.jwtHttp().post<FlowRun>('/v1/sample-data/test-step', {
      projectId: this.projectId,
      flowVersionId,
      stepName,
    });
    return data;
  }

  // Webhook-based triggering (works with API keys, unlike test-step)

  /**
   * Trigger the flow via the SYNC draft webhook endpoint.
   * This waits for the flow to finish executing and returns the HTTP response.
   * No polling needed -- the result comes back directly.
   */
  async triggerWebhookDraftSync(flowId: string, payload: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
    const response = await this.http.post(`/v1/webhooks/${flowId}/draft/sync`, payload, {
      timeout: timeoutMs,
      // Don't throw on non-2xx since the flow might return 500 with useful error info
      validateStatus: () => true,
    });
    return { status: response.status, data: response.data, headers: response.headers as Record<string, string> };
  }

  /**
   * Trigger the flow via the ASYNC draft webhook endpoint (fire-and-forget).
   * Note: Draft runs are in TESTING environment and may not appear in flow-runs list.
   */
  async triggerWebhookDraft(flowId: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.http.post(`/v1/webhooks/${flowId}/draft`, payload);
  }

  /**
   * Trigger the flow via the PRODUCTION webhook endpoint (async).
   * The flow must be published and ENABLED first.
   * Production runs appear in the normal flow-runs list.
   * Returns the HTTP status code so callers can detect 404 (flow still disabled) etc.
   */
  async triggerWebhookProduction(flowId: string, payload: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
    const resp = await this.http.post(`/v1/webhooks/${flowId}`, payload, {
      // Don't throw on non-2xx so we can inspect the status
      validateStatus: () => true,
    });
    return { status: resp.status, body: resp.data };
  }

  /** Fetch a single flow by ID (to check its status, etc.) */
  async getFlow(flowId: string): Promise<PopulatedFlow> {
    const { data } = await this.http.get<PopulatedFlow>(`/v1/flows/${flowId}`);
    return data;
  }

  // Flow runs
  async getFlowRun(runId: string): Promise<FlowRun> {
    const { data } = await this.http.get<FlowRun>(`/v1/flow-runs/${runId}`);
    return data;
  }

  async listFlowRuns(flowId: string, limit = 1): Promise<FlowRun[]> {
    const { data } = await this.http.get<SeekPage<FlowRun>>('/v1/flow-runs', {
      params: { projectId: this.projectId, flowId, limit },
    });
    return data.data;
  }

  /** Debug: list all recent runs for the project (no flowId filter) */
  async listAllRecentRuns(limit = 5): Promise<FlowRun[]> {
    const { data } = await this.http.get<SeekPage<FlowRun>>('/v1/flow-runs', {
      params: { projectId: this.projectId, limit },
    });
    return data.data;
  }

  getProjectId() { return this.projectId; }
  getBaseUrl() { return this.http.defaults.baseURL ?? ''; }

  static formatError(err: unknown): string {
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? 'no status';
      const body = typeof err.response?.data === 'object' ? JSON.stringify(err.response.data) : (err.response?.data ?? err.message);
      return `HTTP ${status}: ${body}`;
    }
    return err instanceof Error ? err.message : String(err);
  }
}

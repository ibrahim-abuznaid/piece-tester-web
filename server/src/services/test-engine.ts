import { ActivepiecesClient, TERMINAL_STATUSES, type FlowRunStatus, type PieceMetadataFull } from './ap-client.js';
import { buildConnectionValue, makeExternalId, type ConnectionType } from './connection-builder.js';
import { getSettings, listConnections, listTestPlans, createTestRun, createTestResult, updateTestRun, type PieceConnectionRow, type ScheduleTarget } from '../db/queries.js';
import { executePlan } from './plan-executor.js';

const POLL_INTERVAL_MS = 3_000;
const ACTION_STEP_NAME = 'step_1';
/**
 * Total time budget for a single action test, including:
 *  - flow setup (~3-6s)
 *  - engine cold-start on AP cloud (~10-30s)
 *  - trigger evaluation + flow execution
 *  - runsMetadataQueue flush to DB (PRODUCTION runs are queued in Redis before being
 *    written to Postgres -- if the flow is deleted before the queue flushes, the run is
 *    discarded!)
 *
 * We poll up to 3 minutes; the AP cloud can be very slow for new flows.
 */
const DEFAULT_POLL_TIMEOUT_MS = 180_000; // 3 minutes

type LiveTestStatus = 'passed' | 'failed' | 'error' | 'timeout' | 'skipped';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Creates an AP client from current DB settings.
 * If a JWT token is available, it's passed to the client for test-step support.
 */
export function createClient(): ActivepiecesClient {
  const s = getSettings();
  if (!s.api_key || !s.project_id) throw new Error('Activepieces settings not configured. Go to Settings page first.');
  return new ActivepiecesClient(s.base_url, s.api_key, s.project_id, s.jwt_token || undefined);
}

/**
 * Run tests for the given piece names (or all configured pieces if empty).
 * Creates a test_run record, tests each action, writes test_results, returns the run ID.
 * Runs asynchronously -- caller gets the runId immediately and polls for status.
 */
export async function runTests(pieceNames?: string[]): Promise<number> {
  const connections = listConnections();
  const toTest = pieceNames && pieceNames.length > 0
    ? connections.filter(c => pieceNames.includes(c.piece_name))
    : connections;

  if (toTest.length === 0) throw new Error('No configured piece connections to test.');

  const run = createTestRun('manual');
  const runId = run.id;

  // Run in background (don't await at caller level)
  executeTestRun(runId, toTest).catch(err => {
    console.error('[test-engine] Fatal error in run', runId, err);
    updateTestRun(runId, { status: 'failed', finished_at: new Date().toISOString() });
  });

  return runId;
}

/**
 * Run scheduled tests for the given targets.
 * targets = [] means "all pieces, all actions".
 * Also runs all approved test plans matching the targets (in the background).
 */
export async function runScheduledTests(targets?: ScheduleTarget[] | null): Promise<number> {
  const connections = listConnections();

  // ── Determine which connections/actions to test (legacy engine) ──
  let toTest: PieceConnectionRow[];
  if (!targets || targets.length === 0) {
    toTest = connections;
  } else {
    const targetPieces = new Set(targets.map(t => t.piece_name));
    toTest = connections.filter(c => targetPieces.has(c.piece_name));
  }

  // ── Legacy test run ──
  let runId = -1;
  if (toTest.length > 0) {
    // If targets specify specific actions, filter actions_config per connection
    const filteredConns = toTest.map(conn => {
      if (!targets || targets.length === 0) return conn;
      const actionTargets = targets
        .filter(t => t.piece_name === conn.piece_name && t.action_name)
        .map(t => t.action_name!);
      if (actionTargets.length === 0) return conn; // no action filter = all actions
      // Rebuild actions_config with only targeted actions
      const allActions = parseJson(conn.actions_config);
      const filtered: Record<string, unknown> = {};
      for (const a of actionTargets) {
        if (allActions[a] !== undefined) filtered[a] = allActions[a];
      }
      return { ...conn, actions_config: JSON.stringify(filtered) };
    });

    const run = createTestRun('scheduled');
    runId = run.id;
    executeTestRun(run.id, filteredConns).catch(err => {
      console.error('[test-engine] Fatal error in scheduled run', run.id, err);
      updateTestRun(run.id, { status: 'failed', finished_at: new Date().toISOString() });
    });
  }

  // ── Test plan runs (modern approach) ──
  const allPlans = listTestPlans();
  const plansToRun = allPlans.filter(p => {
    if (p.status !== 'approved') return false;
    if (!targets || targets.length === 0) return true;
    return targets.some(t =>
      t.piece_name === p.piece_name &&
      (!t.action_name || t.action_name === p.target_action)
    );
  });

  const validPlans = plansToRun.filter(p => {
    try {
      const steps = JSON.parse(p.steps);
      if (!Array.isArray(steps) || steps.length === 0) {
        console.warn(`[scheduler] Skipping plan #${p.id} (${p.target_action}): no steps defined`);
        return false;
      }
      return true;
    } catch {
      console.warn(`[scheduler] Skipping plan #${p.id} (${p.target_action}): invalid steps JSON`);
      return false;
    }
  });

  if (validPlans.length > 0) {
    console.log(`[scheduler] Running ${validPlans.length} test plan(s)...`);
    (async () => {
      for (const plan of validPlans) {
        try {
          await executePlan(plan.id, () => {}, 'scheduled');
        } catch (err) {
          console.error(`[scheduler] Plan #${plan.id} (${plan.target_action}) failed:`, err);
        }
      }
    })();
  }

  return runId;
}

async function executeTestRun(runId: number, connections: PieceConnectionRow[]): Promise<void> {
  const client = createClient();
  const settings = getSettings();
  let totalTests = 0;
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const conn of connections) {
    let pieceMeta: PieceMetadataFull;
    try {
      pieceMeta = await client.getPieceMetadata(conn.piece_name);
    } catch (err) {
      const msg = ActivepiecesClient.formatError(err);
      const actions = parseJson(conn.actions_config);
      for (const actionName of Object.keys(actions)) {
        totalTests++;
        errors++;
        createTestResult({ run_id: runId, piece_name: conn.piece_name, action_name: actionName, status: 'error', duration_ms: 0, error_message: `Failed to fetch piece metadata: ${msg}` });
      }
      continue;
    }

    // Resolve connection in AP
    let connectionExternalId: string;
    const connValueParsed = parseJson(conn.connection_value);

    if (connValueParsed._imported) {
      // Imported connection -- already exists in AP, use its externalId directly
      // Find it from the remote connections list
      try {
        const remoteConns = await client.listConnections();
        const remote = remoteConns.find(rc => rc.id === connValueParsed.remote_id || rc.externalId === connValueParsed.remote_id);
        if (!remote) throw new Error(`Imported connection not found in AP (id: ${connValueParsed.remote_id})`);
        connectionExternalId = remote.externalId;
      } catch (err) {
        const msg = ActivepiecesClient.formatError(err);
        const actions = parseJson(conn.actions_config);
        for (const actionName of Object.keys(actions)) {
          totalTests++;
          errors++;
          createTestResult({ run_id: runId, piece_name: conn.piece_name, action_name: actionName, status: 'error', duration_ms: 0, error_message: `Failed to resolve imported connection: ${msg}` });
        }
        continue;
      }
    } else if (conn.connection_type === 'NO_AUTH') {
      // No auth needed, use empty external ID
      connectionExternalId = '';
    } else {
      // Manual connection -- upsert in AP
      try {
        const extId = makeExternalId(conn.piece_name);
        const connValue = buildConnectionValue(conn.connection_type as ConnectionType, connValueParsed);
        await client.upsertConnection({ externalId: extId, displayName: `Test - ${conn.display_name}`, pieceName: conn.piece_name, type: conn.connection_type, value: connValue });
        connectionExternalId = extId;
      } catch (err) {
        const msg = ActivepiecesClient.formatError(err);
        const actions = parseJson(conn.actions_config);
        for (const actionName of Object.keys(actions)) {
          totalTests++;
          errors++;
          createTestResult({ run_id: runId, piece_name: conn.piece_name, action_name: actionName, status: 'error', duration_ms: 0, error_message: `Connection upsert failed: ${msg}` });
        }
        continue;
      }
    }

    // Test each action
    const actions: Record<string, Record<string, unknown>> = parseJson(conn.actions_config);
    for (const [actionName, actionInput] of Object.entries(actions)) {
      totalTests++;

      if (!pieceMeta.actions[actionName]) {
        errors++;
        createTestResult({ run_id: runId, piece_name: conn.piece_name, action_name: actionName, status: 'error', duration_ms: 0, error_message: `Action "${actionName}" not found. Available: ${Object.keys(pieceMeta.actions).join(', ')}` });
        continue;
      }

      const result = await testSingleAction(client, pieceMeta, actionName, actionInput, connectionExternalId, settings.test_timeout_ms);
      createTestResult({ run_id: runId, piece_name: conn.piece_name, action_name: actionName, ...result });

      if (result.status === 'passed') passed++;
      else if (result.status === 'failed') failed++;
      else errors++;

      // Update running counts
      updateTestRun(runId, { total_tests: totalTests, passed, failed, errors });
    }
  }

  updateTestRun(runId, { status: 'completed', finished_at: new Date().toISOString(), total_tests: totalTests, passed, failed, errors });
}

async function testSingleAction(
  client: ActivepiecesClient,
  pieceMeta: PieceMetadataFull,
  actionName: string,
  actionInput: Record<string, unknown>,
  connectionExternalId: string,
  testTimeoutMs: number,
): Promise<{ status: LiveTestStatus; duration_ms: number; flow_run_id?: string; error_message?: string }> {
  // Route to the appropriate strategy
  if (client.hasJwtToken()) {
    return testSingleActionViaTestStep(client, pieceMeta, actionName, actionInput, connectionExternalId, testTimeoutMs);
  }
  return testSingleActionViaWebhook(client, pieceMeta, actionName, actionInput, connectionExternalId);
}

/**
 * PRIMARY STRATEGY: Use POST /v1/sample-data/test-step (requires JWT token).
 *
 * This is what the AP dashboard uses when you click "Test" on a step.
 * It creates a TESTING flow run, executes up to the given step, and returns
 * the flow run object with results.
 *
 * Flow: create flow → add trigger → add action → test-step → poll run → cleanup
 */
async function testSingleActionViaTestStep(
  client: ActivepiecesClient,
  pieceMeta: PieceMetadataFull,
  actionName: string,
  actionInput: Record<string, unknown>,
  connectionExternalId: string,
  testTimeoutMs: number,
): Promise<{ status: LiveTestStatus; duration_ms: number; flow_run_id?: string; error_message?: string }> {
  const start = Date.now();
  let flowId: string | null = null;

  try {
    // 1. Create flow
    console.log(`[test] Creating flow for ${pieceMeta.displayName} / ${actionName}...`);
    const flow = await client.createFlow(`[Test] ${pieceMeta.displayName} - ${actionName}`);
    flowId = flow.id;
    const flowVersionId = flow.version.id;

    // 2. Keep the default EMPTY trigger (no webhook needed for test-step)
    //    test-step uses existing trigger sample data as input, which can be empty.

    // 3. Add the piece action
    const needsAuth = pieceMeta.actions[actionName]?.requireAuth !== false;
    const authInput: Record<string, unknown> = {};
    if (needsAuth && connectionExternalId) {
      authInput['auth'] = `{{connections.${connectionExternalId}}}`;
    }

    const updatedFlow = await client.applyFlowOperation(flowId, {
      type: 'ADD_ACTION',
      request: {
        parentStep: 'trigger',
        stepLocationRelativeToParent: 'AFTER',
        action: {
          type: 'PIECE',
          name: ACTION_STEP_NAME,
          displayName: `Test: ${actionName}`,
          valid: true,
          skip: false,
          settings: {
            pieceName: pieceMeta.name,
            pieceVersion: `~${pieceMeta.version}`,
            actionName,
            input: { ...authInput, ...actionInput },
            propertySettings: {},
            errorHandlingOptions: {
              continueOnFailure: { value: false },
              retryOnFailure: { value: false },
            },
          },
        },
      },
    });

    const setupMs = Date.now() - start;
    const currentVersionId = updatedFlow.version.id;
    console.log(`[test] Flow set up in ${setupMs}ms, calling test-step for ${actionName}...`);

    // 4. Call test-step (requires JWT) -- this starts execution and returns the flow run
    const flowRun = await client.testStep(currentVersionId, ACTION_STEP_NAME);
    console.log(`[test] test-step returned run: ${flowRun.id}, status: ${flowRun.status}`);

    // 5. Poll for completion (test-step returns immediately with QUEUED/RUNNING status)
    const timeout = Math.max(testTimeoutMs, DEFAULT_POLL_TIMEOUT_MS);
    const finalRun = await pollFlowRunById(client, flowRun.id, timeout);

    const duration_ms = Date.now() - start;
    const status = mapRunStatus(finalRun.status);
    const error_message = status !== 'passed' ? extractError(finalRun, ACTION_STEP_NAME) : undefined;

    console.log(`[test] ${actionName}: ${status} (run: ${finalRun.id}) in ${duration_ms}ms`);
    return { status, duration_ms, flow_run_id: finalRun.id, error_message };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const msg = ActivepiecesClient.formatError(err);
    console.error(`[test] ${actionName}: error in ${duration_ms}ms -`, msg);
    return { status: 'error', duration_ms, error_message: msg };
  } finally {
    if (flowId) {
      await client.deleteFlowSafely(flowId, 5, `test-step:${actionName}`);
    }
  }
}

/**
 * FALLBACK STRATEGY: Use production webhook (API key only, no JWT).
 * This is unreliable on AP Cloud due to metadata queue delays and TESTING/PRODUCTION
 * environment filtering. Kept as a fallback for self-hosted instances.
 */
async function testSingleActionViaWebhook(
  client: ActivepiecesClient,
  pieceMeta: PieceMetadataFull,
  actionName: string,
  actionInput: Record<string, unknown>,
  connectionExternalId: string,
): Promise<{ status: LiveTestStatus; duration_ms: number; flow_run_id?: string; error_message?: string }> {
  const start = Date.now();
  let flowId: string | null = null;

  try {
    console.log(`[test] (webhook fallback) Creating flow for ${pieceMeta.displayName} / ${actionName}...`);
    const flow = await client.createFlow(`[Test] ${pieceMeta.displayName} - ${actionName}`);
    flowId = flow.id;

    await client.applyFlowOperation(flowId, {
      type: 'UPDATE_TRIGGER',
      request: {
        type: 'PIECE_TRIGGER', name: 'trigger', displayName: 'Webhook Trigger', valid: true,
        settings: { pieceName: '@activepieces/piece-webhook', pieceVersion: '~0.1.0', triggerName: 'catch_webhook', input: {}, propertySettings: {} },
      },
    });

    const needsAuth = pieceMeta.actions[actionName]?.requireAuth !== false;
    const authInput: Record<string, unknown> = {};
    if (needsAuth && connectionExternalId) authInput['auth'] = `{{connections.${connectionExternalId}}}`;

    await client.applyFlowOperation(flowId, {
      type: 'ADD_ACTION',
      request: {
        parentStep: 'trigger', stepLocationRelativeToParent: 'AFTER',
        action: {
          type: 'PIECE', name: ACTION_STEP_NAME, displayName: `Test: ${actionName}`, valid: true, skip: false,
          settings: { pieceName: pieceMeta.name, pieceVersion: `~${pieceMeta.version}`, actionName, input: { ...authInput, ...actionInput }, propertySettings: {}, errorHandlingOptions: { continueOnFailure: { value: false }, retryOnFailure: { value: false } } },
        },
      },
    });

    await client.applyFlowOperation(flowId, { type: 'LOCK_AND_PUBLISH', request: {} });
    await client.applyFlowOperation(flowId, { type: 'CHANGE_STATUS', request: { status: 'ENABLED' } });
    await waitForFlowEnabled(client, flowId, 15_000);

    const webhookResp = await client.triggerWebhookProduction(flowId, { _test: true });
    if (webhookResp.status >= 400) throw new Error(`Webhook HTTP ${webhookResp.status}`);

    console.log(`[test] Webhook triggered, polling (up to ${DEFAULT_POLL_TIMEOUT_MS / 1000}s)...`);
    const finalRun = await pollFlowRunByFlowId(client, flowId, DEFAULT_POLL_TIMEOUT_MS);
    const duration_ms = Date.now() - start;
    return { status: mapRunStatus(finalRun.status), duration_ms, flow_run_id: finalRun.id, error_message: finalRun.status !== 'SUCCEEDED' ? extractError(finalRun, ACTION_STEP_NAME) : undefined };
  } catch (err) {
    return { status: 'error', duration_ms: Date.now() - start, error_message: ActivepiecesClient.formatError(err) };
  } finally {
    if (flowId) {
      try {
        await client.applyFlowOperation(flowId, { type: 'CHANGE_STATUS', request: { status: 'DISABLED' } });
      } catch {
        // Flow may already be disabled or in a bad state -- proceed to delete
      }
      await client.deleteFlowSafely(flowId, 5, `webhook:${actionName}`);
    }
  }
}

/**
 * Poll a flow run by its ID until it reaches a terminal status.
 * Works for TESTING runs too (GET /v1/flow-runs/:id doesn't filter by environment).
 */
async function pollFlowRunById(client: ActivepiecesClient, runId: string, timeoutMs: number) {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  let pollCount = 0;

  while (Date.now() < deadline) {
    pollCount++;
    try {
      const run = await client.getFlowRun(runId);
      if (TERMINAL_STATUSES.includes(run.status)) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[test] Run completed: ${run.status} (${elapsed}s, ${pollCount} polls)`);
        return run;
      }
      if (pollCount <= 2) {
        console.log(`[test] Run in progress: ${run.status} (poll #${pollCount})`);
      }
    } catch (err) {
      // The run might not be queryable immediately
      if (pollCount <= 3) {
        console.log(`[test] Waiting for run to be accessible (poll #${pollCount})...`);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.warn(`[test] Run ${runId} polling timed out after ${Math.round(timeoutMs / 1000)}s`);
  return { id: runId, status: 'TIMEOUT' as FlowRunStatus, steps: null, failedStep: undefined };
}

/**
 * Poll the flow until its status becomes ENABLED.
 * AP's CHANGE_STATUS operation is asynchronous -- it queues a background job that
 * actually flips the status. We must wait for that before triggering the production webhook.
 */
async function waitForFlowEnabled(client: ActivepiecesClient, flowId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    try {
      const flow = await client.getFlow(flowId);
      if (flow.status === 'ENABLED') {
        console.log(`[test] Flow confirmed ENABLED after ${attempts} checks`);
        return;
      }
      if (attempts <= 3) {
        console.log(`[test] Flow status: ${flow.status} (attempt ${attempts}), waiting...`);
      }
    } catch (err) {
      console.warn(`[test] Error checking flow status (attempt ${attempts}):`, ActivepiecesClient.formatError(err));
    }
    await sleep(1_000);
  }

  throw new Error(`Flow did not become ENABLED within ${timeoutMs}ms -- it may be stuck in ENABLING state`);
}

/**
 * Poll for a flow run by listing PRODUCTION runs for the given flowId.
 *
 * On AP Cloud, the pipeline from webhook trigger to visible flow run is:
 *   1. Webhook job queued in BullMQ
 *   2. Worker picks up job (seconds to minutes depending on load)
 *   3. Engine cold-starts + evaluates trigger (~10-30s)
 *   4. startRuns() called → run goes to runsMetadataQueue (Redis)
 *   5. runsMetadataQueue worker flushes to Postgres
 *   6. Run visible via GET /v1/flow-runs
 *
 * Total latency can be 30-120s. We poll patiently.
 * IMPORTANT: The flow must NOT be deleted during polling (step 5 checks flow existence).
 */
async function pollFlowRunByFlowId(client: ActivepiecesClient, flowId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  let foundRunning = false;

  while (Date.now() < deadline) {
    pollCount++;
    const elapsedSec = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);

    try {
      const runs = await client.listFlowRuns(flowId, 5);

      if (runs.length > 0) {
        if (!foundRunning) {
          foundRunning = true;
          console.log(`[test] Run appeared after ${elapsedSec}s (poll #${pollCount}): status=${runs[0].status}`);
        }

        const run = runs[0];
        if (TERMINAL_STATUSES.includes(run.status)) {
          console.log(`[test] Run completed: ${run.status} (${elapsedSec}s total)`);
          return run;
        }
      } else {
        // Log progress periodically (every ~15s)
        if (pollCount % 5 === 0) {
          console.log(`[test] Waiting for run... ${elapsedSec}s elapsed (poll #${pollCount})`);
        }
      }
    } catch (err) {
      console.warn(`[test] Poll error (#${pollCount}):`, ActivepiecesClient.formatError(err));
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const totalSec = Math.round(timeoutMs / 1000);
  console.warn(`[test] Polling timed out after ${totalSec}s (${pollCount} polls)`);
  return { id: `timeout-${flowId}`, status: 'TIMEOUT' as FlowRunStatus, steps: null, failedStep: undefined };
}

function mapRunStatus(status: FlowRunStatus): LiveTestStatus {
  if (status === 'SUCCEEDED') return 'passed';
  if (status === 'FAILED') return 'failed';
  if (status === 'TIMEOUT') return 'timeout';
  return 'error';
}

function extractError(run: { steps: Record<string, unknown> | null; failedStep?: { name: string; displayName: string }; status: string }, stepName: string): string {
  if (run.failedStep) {
    const sd = run.steps?.[run.failedStep.name] as { errorMessage?: string; output?: { message?: string } } | undefined;
    if (sd?.errorMessage) return sd.errorMessage;
    if (sd?.output?.message) return sd.output.message;
    return `Step "${run.failedStep.displayName}" failed`;
  }
  const sd = run.steps?.[stepName] as { errorMessage?: string; status?: string } | undefined;
  if (sd?.errorMessage) return sd.errorMessage;
  return `Run ended with status: ${run.status}`;
}

function parseJson(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}

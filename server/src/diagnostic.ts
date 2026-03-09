/**
 * Diagnostic script: step-by-step API chain to test webhook flow execution.
 * Run with: npx tsx server/src/diagnostic.ts
 *
 * This creates a flow, adds a webhook trigger + a simple action,
 * publishes, enables, triggers the webhook, and polls for results.
 * Every step prints the full API response so we can see exactly where it breaks.
 */

import axios from 'axios';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/piece-tester.db');

// ── Load settings from the same SQLite DB ──
function loadSettings() {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  db.close();
  if (!row?.api_key || !row?.project_id) {
    throw new Error('Settings not configured. Open the web app and configure Settings first.');
  }
  return { baseUrl: row.base_url as string, apiKey: row.api_key as string, projectId: row.project_id as string };
}

const settings = loadSettings();
const http = axios.create({
  baseURL: settings.baseUrl.replace(/\/+$/, ''),
  headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
  timeout: 30_000,
  validateStatus: () => true, // never throw - we want to inspect every response
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function printStep(step: number, title: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  STEP ${step}: ${title}`);
  console.log('='.repeat(70));
}

function printResponse(label: string, status: number, data: unknown) {
  console.log(`  ${label}: HTTP ${status}`);
  const json = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  // Truncate long responses
  if (json.length > 2000) {
    console.log(`  Body (truncated): ${json.substring(0, 2000)}...`);
  } else {
    console.log(`  Body: ${json}`);
  }
}

async function main() {
  let flowId: string | null = null;

  try {
    console.log('\n🔍 ACTIVEPIECES WEBHOOK FLOW DIAGNOSTIC');
    console.log(`  Base URL:   ${settings.baseUrl}`);
    console.log(`  Project ID: ${settings.projectId}`);
    console.log(`  Timestamp:  ${new Date().toISOString()}`);

    // ── STEP 1: Create flow ──
    printStep(1, 'CREATE FLOW');
    const createResp = await http.post('/v1/flows', {
      displayName: `[Diagnostic] Test ${new Date().toISOString()}`,
      projectId: settings.projectId,
    });
    printResponse('Create flow', createResp.status, {
      id: createResp.data?.id,
      status: createResp.data?.status,
      versionId: createResp.data?.version?.id,
      triggerType: createResp.data?.version?.trigger?.type,
    });
    if (createResp.status >= 300) throw new Error(`Failed to create flow (HTTP ${createResp.status})`);
    flowId = createResp.data.id;
    console.log(`  ✅ Flow created: ${flowId}`);

    // ── STEP 2: Set webhook trigger ──
    printStep(2, 'SET WEBHOOK TRIGGER');
    const triggerResp = await http.post(`/v1/flows/${flowId}`, {
      type: 'UPDATE_TRIGGER',
      request: {
        type: 'PIECE_TRIGGER',
        name: 'trigger',
        displayName: 'Webhook Trigger',
        valid: true,
        settings: {
          pieceName: '@activepieces/piece-webhook',
          pieceVersion: '~0.1.0',
          triggerName: 'catch_webhook',
          input: {},
          propertySettings: {},
        },
      },
    });
    printResponse('Update trigger', triggerResp.status, {
      triggerId: triggerResp.data?.version?.trigger?.name,
      triggerType: triggerResp.data?.version?.trigger?.type,
      triggerSettings: triggerResp.data?.version?.trigger?.settings,
    });
    if (triggerResp.status >= 300) throw new Error(`Failed to set trigger (HTTP ${triggerResp.status})`);
    console.log('  ✅ Webhook trigger set');

    // ── STEP 3: Add a simple code action (to avoid piece dependency issues) ──
    printStep(3, 'ADD CODE ACTION');
    const actionResp = await http.post(`/v1/flows/${flowId}`, {
      type: 'ADD_ACTION',
      request: {
        parentStep: 'trigger',
        stepLocationRelativeToParent: 'AFTER',
        action: {
          type: 'CODE',
          name: 'step_1',
          displayName: 'Test Code Step',
          valid: true,
          skip: false,
          settings: {
            sourceCode: {
              code: `export const code = async (inputs) => { return { success: true, timestamp: new Date().toISOString(), message: "Diagnostic test passed!" }; }`,
              packageJson: '{}',
            },
            input: {},
            errorHandlingOptions: {
              continueOnFailure: { value: false },
              retryOnFailure: { value: false },
            },
          },
        },
      },
    });
    printResponse('Add action', actionResp.status, {
      versionValid: actionResp.data?.version?.valid,
      steps: Object.keys(actionResp.data?.version?.trigger?.nextAction ? { trigger: 1, step_1: 1 } : {}),
      actionType: actionResp.data?.version?.trigger?.nextAction?.type,
      actionName: actionResp.data?.version?.trigger?.nextAction?.name,
    });
    if (actionResp.status >= 300) throw new Error(`Failed to add action (HTTP ${actionResp.status})`);
    console.log('  ✅ Code action added');

    // ── STEP 4: Publish (LOCK_AND_PUBLISH) ──
    printStep(4, 'PUBLISH FLOW (LOCK_AND_PUBLISH)');
    const publishResp = await http.post(`/v1/flows/${flowId}`, {
      type: 'LOCK_AND_PUBLISH',
      request: {},
    });
    printResponse('Publish', publishResp.status, {
      status: publishResp.data?.status,
      publishedVersionId: publishResp.data?.publishedVersionId,
    });
    if (publishResp.status >= 300) throw new Error(`Failed to publish (HTTP ${publishResp.status})`);
    console.log('  ✅ Flow published');

    // ── STEP 5: Enable flow ──
    printStep(5, 'ENABLE FLOW (CHANGE_STATUS)');
    const enableResp = await http.post(`/v1/flows/${flowId}`, {
      type: 'CHANGE_STATUS',
      request: { status: 'ENABLED' },
    });
    printResponse('Enable', enableResp.status, {
      status: enableResp.data?.status,
      operationStatus: enableResp.data?.operationStatus,
    });
    if (enableResp.status >= 300) throw new Error(`Failed to enable (HTTP ${enableResp.status})`);
    console.log('  ✅ Enable requested (async operation)');

    // ── STEP 6: Poll until ENABLED ──
    printStep(6, 'WAIT FOR FLOW TO BE ENABLED');
    for (let i = 1; i <= 15; i++) {
      await sleep(1_000);
      const checkResp = await http.get(`/v1/flows/${flowId}`);
      const st = checkResp.data?.status;
      const opSt = checkResp.data?.operationStatus;
      console.log(`  Poll #${i}: status=${st}, operationStatus=${opSt}`);
      if (st === 'ENABLED') {
        console.log('  ✅ Flow is ENABLED');
        break;
      }
      if (i === 15) throw new Error('Flow did not become ENABLED in 15s');
    }

    // ── STEP 7: Try SYNC draft webhook first (returns result directly, no polling needed) ──
    printStep(7, 'TRIGGER SYNC DRAFT WEBHOOK (POST /v1/webhooks/:flowId/draft/sync)');
    console.log('  This should return the flow result directly (up to 30s before Cloudflare timeout)...');
    const syncStart = Date.now();
    const syncResp = await http.post(`/v1/webhooks/${flowId}/draft/sync`, {
      _diagnostic: true,
      timestamp: new Date().toISOString(),
    }, { timeout: 35_000 });
    const syncMs = Date.now() - syncStart;
    console.log(`  Duration: ${syncMs}ms`);
    printResponse('Sync draft webhook', syncResp.status, syncResp.data);
    console.log(`  Response headers (x-webhook-id): ${syncResp.headers['x-webhook-id'] ?? 'N/A'}`);

    if (syncResp.status === 200 || syncResp.status === 204) {
      console.log('  ✅ Sync webhook succeeded! The flow executed.');
    } else if (syncResp.status === 504) {
      console.log('  ⚠️ Cloudflare timeout (504) - flow is running but took too long');
    }

    // ── STEP 8: Trigger PRODUCTION webhook (async) ──
    printStep(8, 'TRIGGER PRODUCTION WEBHOOK (POST /v1/webhooks/:flowId)');
    const prodWebhookResp = await http.post(`/v1/webhooks/${flowId}`, {
      _diagnostic: true,
      timestamp: new Date().toISOString(),
    });
    printResponse('Production webhook', prodWebhookResp.status, prodWebhookResp.data);
    console.log(`  Response headers (x-webhook-id): ${prodWebhookResp.headers['x-webhook-id'] ?? 'N/A'}`);

    // ── STEP 9: Trigger ASYNC draft webhook ──
    printStep(9, 'TRIGGER DRAFT WEBHOOK (POST /v1/webhooks/:flowId/draft)');
    const draftWebhookResp = await http.post(`/v1/webhooks/${flowId}/draft`, {
      _diagnostic: true,
      timestamp: new Date().toISOString(),
    });
    printResponse('Draft webhook', draftWebhookResp.status, draftWebhookResp.data);
    console.log(`  Response headers (x-webhook-id): ${draftWebhookResp.headers['x-webhook-id'] ?? 'N/A'}`);

    // ── STEP 10: Poll for flow runs (3 minutes -- AP cloud is slow!) ──
    printStep(10, 'POLL FOR FLOW RUNS (up to 3 minutes - DO NOT delete flow during this!)');
    console.log('  AP Cloud pipeline: webhook→worker→engine→trigger→startRuns→metadataQueue→DB');
    console.log('  This can take 30-120s. Polling every 5s...\n');
    const pollStart = Date.now();
    const POLL_TIMEOUT = 180_000; // 3 minutes
    let found = false;
    let pollNum = 0;

    while (Date.now() - pollStart < POLL_TIMEOUT) {
      pollNum++;
      await sleep(5_000);
      const elapsed = Math.round((Date.now() - pollStart) / 1000);

      const filteredResp = await http.get('/v1/flow-runs', {
        params: { projectId: settings.projectId, flowId: [flowId], limit: 5 },
      });
      const filteredRuns = filteredResp.data?.data ?? [];

      if (filteredRuns.length > 0) {
        const latest = filteredRuns[0];
        console.log(`  [${elapsed}s] ✅ RUN FOUND! id=${latest.id}, status=${latest.status}, env=${latest.environment}`);

        if (['SUCCEEDED', 'FAILED', 'INTERNAL_ERROR', 'TIMEOUT'].includes(latest.status)) {
          console.log(`\n  ✅ Flow run completed: ${latest.status} (appeared after ${elapsed}s)`);

          // Fetch full run details
          const runDetailResp = await http.get(`/v1/flow-runs/${latest.id}`);
          const steps = runDetailResp.data?.steps;
          if (steps) {
            console.log('\n  Step results:');
            for (const [name, detail] of Object.entries(steps as Record<string, any>)) {
              console.log(`    ${name}: status=${detail?.status}, output=${JSON.stringify(detail?.output)?.substring(0, 200)}`);
            }
          }
          found = true;
          break;
        } else {
          console.log(`    Run in progress (${latest.status}), waiting for completion...`);
        }
      } else {
        if (pollNum % 6 === 0) { // Every ~30s
          console.log(`  [${elapsed}s] Still waiting... (0 runs found, flow alive)`);
        }
      }
    }

    if (!found) {
      const totalSec = Math.round((Date.now() - pollStart) / 1000);
      console.log(`\n  ❌ No flow runs found after ${totalSec}s of polling`);
      console.log('  The AP Cloud worker may not have processed the webhook job.');
    }

  } catch (err: any) {
    console.error(`\n❌ ERROR: ${err.message}`);
  } finally {
    // Cleanup
    if (flowId) {
      console.log(`\n${'─'.repeat(70)}`);
      console.log('  CLEANUP: Disabling and deleting flow...');
      await http.post(`/v1/flows/${flowId}`, { type: 'CHANGE_STATUS', request: { status: 'DISABLED' } }).catch(() => {});
      await sleep(2_000);
      const delResp = await http.delete(`/v1/flows/${flowId}`);
      console.log(`  Delete response: HTTP ${delResp.status}`);
    }
    console.log('\nDone.');
  }
}

main();

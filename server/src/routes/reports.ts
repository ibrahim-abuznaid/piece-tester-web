import { Router } from 'express';
import {
  getReportOverviewStats,
  getPieceBreakdown,
  getPieceHealth,
  getAttentionItems,
  getScheduledWaves,
  getWaveDetail,
  listQuarantine,
  addQuarantine,
  removeQuarantine,
  getRunTrends,
  getRecentFailures,
  listReportAnalyses,
  getLatestCompletedAnalysis,
  getRunningAnalysis,
  getReportAnalysis,
  resolveIssue,
  unresolveIssue,
  getResolvedIssues,
  updateResolvedIssueNote,
  getPlanRun,
  getTestPlan,
  getSettings,
  getOpenReportForPiece,
  listOpenReports,
  upsertPieceReport,
} from '../db/queries.js';
import { startAnalysis } from '../services/report-analyzer.js';
import { getPieceRegressions, getPerformanceSummary, getFailureBreakdown } from '../services/regression-service.js';
import { buildReportDraft, type ReportFinding } from '../services/report-draft.js';
import { sendReport, ReportTransportError } from '../services/report-transport.js';

const router = Router();

router.get('/regressions', (req, res) => {
  try {
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    res.json(getPieceRegressions(dateFrom, dateTo));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Failure breakdown by category (auth / timeout / …) for the "why tests fail" chart.
router.get('/failure-breakdown', (req, res) => {
  try {
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    res.json(getFailureBreakdown(dateFrom, dateTo));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/summary', (req, res) => {
  try {
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    res.json(getPerformanceSummary(dateFrom, dateTo));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', (req, res) => {
  try {
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    const stats = getReportOverviewStats(dateFrom, dateTo);
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/piece-breakdown', (req, res) => {
  try {
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    const breakdown = getPieceBreakdown(dateFrom, dateTo);
    res.json(breakdown);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Current-state health board: latest scheduled outcome per piece, failing first.
router.get('/piece-health', (_req, res) => {
  try {
    res.json(getPieceHealth());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Needs-Attention inbox: failing (piece, action)s collapsed + classified into lanes.
router.get('/attention', (_req, res) => {
  try {
    res.json(getAttentionItems());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Scheduled Runs feed — wave summaries + per-wave failures-first rollup (no step_results).
router.get('/waves', (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 30;
    res.json(getScheduledWaves(Number.isFinite(limit) ? limit : 30));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/waves/:waveId', (req, res) => {
  try {
    const detail = getWaveDetail(req.params.waveId);
    if (!detail) return res.status(404).json({ error: 'Wave not found' });
    res.json(detail);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Quarantine management.
router.get('/quarantine', (_req, res) => {
  try {
    res.json(listQuarantine());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/quarantine', (req, res) => {
  try {
    const { piece_name, action_name, reason, expires_at } = req.body;
    if (!piece_name) { res.status(400).json({ error: 'piece_name is required' }); return; }
    res.json(addQuarantine({ piece_name, action_name, reason, expires_at }));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/quarantine/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
    res.json({ success: removeQuarantine(id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/trends', (req, res) => {
  try {
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    const trends = getRunTrends(dateFrom, dateTo);
    res.json(trends);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/failures', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    const failures = getRecentFailures(limit, dateFrom, dateTo);

    const parsed = failures.map(f => {
      let stepResults = [];
      try { stepResults = JSON.parse(f.step_results); } catch { /* ignore */ }
      return { ...f, step_results: stepResults };
    });

    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function parseAnalysisRow(a: any) {
  return {
    ...a,
    categories: JSON.parse(a.categories || '{}'),
    recommendations: JSON.parse(a.recommendations || '[]'),
    logs: JSON.parse(a.logs || '[]'),
  };
}

router.get('/analyses', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const analyses = listReportAnalyses(limit);
    res.json(analyses.map(parseAnalysisRow));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/latest-analysis', (_req, res) => {
  try {
    const analysis = getLatestCompletedAnalysis();
    if (!analysis) {
      res.json(null);
      return;
    }
    res.json(parseAnalysisRow(analysis));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analysis/running', (_req, res) => {
  try {
    const running = getRunningAnalysis();
    if (!running) {
      res.json(null);
      return;
    }
    res.json(parseAnalysisRow(running));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analysis/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
    const analysis = getReportAnalysis(id);
    if (!analysis) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(parseAnalysisRow(analysis));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/analyze', (req, res) => {
  try {
    const timeRange = req.body.time_range || 'all';
    const dateFrom = req.body.date_from;
    const dateTo = req.body.date_to;

    const { id } = startAnalysis({ time_range: timeRange, date_from: dateFrom, date_to: dateTo });
    res.json({ id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Run info (lookup plan from run) ──

router.get('/run-info/:runId', (req, res) => {
  try {
    const runId = parseInt(req.params.runId);
    if (isNaN(runId)) { res.status(400).json({ error: 'Invalid run ID' }); return; }
    const run = getPlanRun(runId);
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    const plan = getTestPlan(run.plan_id);
    res.json({
      run_id: run.id,
      plan_id: run.plan_id,
      piece_name: plan?.piece_name || '',
      target_action: plan?.target_action || '',
      status: run.status,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Resolved Issues ──

router.get('/analysis/:id/resolved', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
    const resolved = getResolvedIssues(id);
    res.json(resolved);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/analysis/:id/resolve', (req, res) => {
  try {
    const analysisId = parseInt(req.params.id);
    if (isNaN(analysisId)) { res.status(400).json({ error: 'Invalid ID' }); return; }
    const { category, item_index, run_id, piece_name, action_name, note } = req.body;
    if (!category || item_index === undefined) {
      res.status(400).json({ error: 'category and item_index are required' });
      return;
    }
    const resolved = resolveIssue({ analysis_id: analysisId, category, item_index, run_id, piece_name, action_name, note });
    res.json(resolved);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/analysis/:id/unresolve', (req, res) => {
  try {
    const analysisId = parseInt(req.params.id);
    if (isNaN(analysisId)) { res.status(400).json({ error: 'Invalid ID' }); return; }
    const { category, item_index } = req.body;
    if (!category || item_index === undefined) {
      res.status(400).json({ error: 'category and item_index are required' });
      return;
    }
    unresolveIssue(analysisId, category, item_index);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/resolved-issues/:id/note', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
    const { note } = req.body;
    updateResolvedIssueNote(id, note || '');
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Report to Pieces team (Linear via the AP flow) ──

/** Assemble a ReportFinding for a piece from its current health + test-plan steps. */
function gatherFinding(pieceName: string): ReportFinding | null {
  const piece = getPieceHealth().find(p => p.piece_name === pieceName);
  if (!piece || piece.failing_actions.length === 0) return null;
  const failing_targets = piece.failing_actions.map(fa => {
    let reproduction: string[] = [];
    try {
      const steps = JSON.parse(getTestPlan(fa.plan_id)?.steps || '[]');
      if (Array.isArray(steps)) reproduction = steps.map((s: any) => String(s.label || s.actionName || s.id || 'step'));
    } catch { /* ignore malformed steps */ }
    return { action: fa.action, category: fa.category, error: fa.error, run_id: fa.run_id, reproduction };
  });
  return { piece_name: pieceName, failing_targets };
}

// Build a draft (no network) so the modal can render + let the user edit before filing.
router.post('/report/preview', (req, res) => {
  try {
    const { piece_name } = req.body;
    if (!piece_name) { res.status(400).json({ error: 'piece_name is required' }); return; }
    const finding = gatherFinding(piece_name);
    if (!finding) { res.status(404).json({ error: 'No failing actions for this piece' }); return; }
    const existing = getOpenReportForPiece(piece_name);
    res.json({
      draft: buildReportDraft(finding),
      mode: existing ? 'comment' : 'create',
      existing: existing ? { linear_url: existing.linear_url, linear_issue_id: existing.linear_issue_id } : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// File the user-approved report through the AP webhook, then mirror it into piece_reports.
router.post('/report', async (req, res) => {
  try {
    const { piece_name, title, description, label, priority } = req.body;
    if (!piece_name || !title) { res.status(400).json({ error: 'piece_name and title are required' }); return; }

    const webhookUrl = getSettings().linear_report_webhook_url;
    if (!webhookUrl) { res.status(400).json({ error: 'No Linear reporting webhook configured in Settings' }); return; }

    const existing = getOpenReportForPiece(piece_name);
    // Prefer the live category; if the piece has since healed, keep what was recorded.
    const category = gatherFinding(piece_name)?.failing_targets[0]?.category || existing?.error_category || 'piece_error';

    const result = await sendReport(webhookUrl, {
      mode: existing ? 'comment' : 'create',
      piece_name, title, description,
      label: label || `piece:${piece_name.replace('@activepieces/piece-', '')}`,
      priority: typeof priority === 'number' ? priority : 2,
      linear_issue_id: existing?.linear_issue_id,
    });

    // On comment mode we keep the existing issue's id/url; on create we take the flow's.
    const row = upsertPieceReport({
      piece_name,
      linear_issue_id: existing ? existing.linear_issue_id : result.linear_issue_id,
      linear_url: existing ? existing.linear_url : result.linear_url,
      error_category: category,
      lane: 'likely_broken',
    });
    res.json(row);
  } catch (err: any) {
    if (err instanceof ReportTransportError) { res.status(502).json({ error: err.message }); return; }
    res.status(500).json({ error: err.message });
  }
});

router.get('/reported', (_req, res) => {
  try {
    res.json(listOpenReports());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

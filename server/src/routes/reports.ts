import { Router } from 'express';
import {
  getReportOverviewStats,
  getPieceBreakdown,
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
} from '../db/queries.js';
import { startAnalysis } from '../services/report-analyzer.js';

const router = Router();

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

export default router;

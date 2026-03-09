/**
 * Report Analyzer — uses Claude to analyze test failures and categorize them
 * as piece issues, test configuration issues, transient errors, etc.
 *
 * Runs in the background: the analysis is started, a DB record is created with
 * status='running', and progress/results are written back to the DB. Clients
 * poll the DB record to see status/logs/results — survives page refresh.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  getSettings,
  getRecentFailures,
  getPieceBreakdown,
  getReportOverviewStats,
  createRunningAnalysis,
  updateReportAnalysis,
  appendAnalysisLog,
  getRunningAnalysis,
  type FailureDetail,
  type PieceBreakdownRow,
} from '../db/queries.js';

export interface FailureClassification {
  run_id: number;
  piece_name: string;
  action: string;
  category: 'piece_issue' | 'test_issue' | 'transient' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  failed_step?: string;
  error_snippet?: string;
}

export interface AnalysisResult {
  summary: string;
  health_score: number;
  classifications: FailureClassification[];
  piece_issues: FailureClassification[];
  test_issues: FailureClassification[];
  transient_issues: FailureClassification[];
  unknown_issues: FailureClassification[];
  recommendations: string[];
  most_problematic_pieces: { piece_name: string; issue_count: number; primary_category: string }[];
}

export interface TimeRangeParams {
  time_range: 'day' | 'week' | 'month' | 'year' | 'custom' | 'all';
  date_from?: string;
  date_to?: string;
}

function computeDateRange(params: TimeRangeParams): { dateFrom?: string; dateTo?: string } {
  const now = new Date();
  const dateTo = now.toISOString();

  switch (params.time_range) {
    case 'day': {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { dateFrom: d.toISOString(), dateTo };
    }
    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return { dateFrom: d.toISOString(), dateTo };
    }
    case 'month': {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      return { dateFrom: d.toISOString(), dateTo };
    }
    case 'year': {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - 1);
      return { dateFrom: d.toISOString(), dateTo };
    }
    case 'custom':
      return { dateFrom: params.date_from, dateTo: params.date_to };
    case 'all':
    default:
      return {};
  }
}

const ANALYSIS_SYSTEM_PROMPT = `You are an expert QA analyst for Activepieces integration testing. Your job is to analyze test failures from a Piece Tester tool and determine the ROOT CAUSE of each failure.

## Your goal
The Piece Tester tests Activepieces "pieces" (integrations like Slack, Google Sheets, Trello, etc.) by running automated test plans against real APIs. When tests fail, you must determine WHY — specifically whether the failure is:

1. **piece_issue** — The piece (integration) itself is broken. The code has a bug, an API contract changed, the piece doesn't handle edge cases, etc. This is the MOST IMPORTANT category — it means the piece needs fixing.
2. **test_issue** — The test configuration or plan was set up incorrectly by the AI test planner. Wrong field values, incorrect inputMapping paths, missing required fields, wrong action names, etc. The piece works fine, the test is just wrong.
3. **transient** — A temporary/environmental issue: rate limiting, API outage, network timeout, auth token expired, service unavailable. The piece and test are both fine.
4. **unknown** — Can't determine the cause with available information.

## How to distinguish piece_issue from test_issue

Key signals for **piece_issue**:
- TypeError, null reference, undefined property in the piece code
- HTTP 500 from the external API suggesting the piece sends wrong data
- "Cannot read property" errors from the piece runtime
- The piece doesn't handle a valid input correctly
- A formerly working action now fails (API changed)

Key signals for **test_issue**:
- "not found" / 404 errors (test references a resource that doesn't exist)
- Wrong field format (e.g., sending a string where a number is needed)
- inputMapping path resolves to undefined (wrong output path reference)
- Missing required fields in the test configuration
- Using wrong action name or wrong piece

Key signals for **transient**:
- Rate limit / 429 errors
- Timeout / ETIMEDOUT
- "Service unavailable" / 503
- "Internal server error" from the EXTERNAL api (not the piece)
- Auth token expired

## Output format
Respond with a JSON object (no markdown wrapping) with these fields:
{
  "summary": "2-3 sentence executive summary of the test health",
  "health_score": <0-100 integer>,
  "classifications": [
    {
      "run_id": <number>,
      "piece_name": "<string>",
      "action": "<string>",
      "category": "piece_issue" | "test_issue" | "transient" | "unknown",
      "confidence": "high" | "medium" | "low",
      "explanation": "1-2 sentence explanation of why this failed and why you classified it this way",
      "failed_step": "<step ID that failed, if available>",
      "error_snippet": "<key part of the error message>"
    }
  ],
  "recommendations": [
    "Specific actionable recommendation 1",
    "Specific actionable recommendation 2"
  ],
  "most_problematic_pieces": [
    { "piece_name": "<string>", "issue_count": <number>, "primary_category": "piece_issue" | "test_issue" | "transient" }
  ]
}

## Rules
- Analyze EVERY failure in the input
- Be specific in explanations — reference actual error messages and step IDs
- health_score: 90-100 = excellent, 70-89 = good, 50-69 = needs attention, 0-49 = critical
- Recommendations should be actionable: "Fix piece X's handling of Y" or "Update test plan for Z to use correct field mapping"
- Most problematic pieces: list pieces with 2+ failures, sorted by count`;

/**
 * Start an analysis in the background. Returns the DB record ID immediately.
 * The analysis runs asynchronously — poll getReportAnalysis(id) for status.
 */
export function startAnalysis(timeRange: TimeRangeParams): { id: number } {
  const existing = getRunningAnalysis();
  if (existing) {
    return { id: existing.id };
  }

  const settings = getSettings();
  if (!settings.anthropic_api_key) {
    throw new Error('Anthropic API key not configured. Go to Settings to add it.');
  }

  const { dateFrom, dateTo } = computeDateRange(timeRange);

  const record = createRunningAnalysis({
    scope: 'full',
    time_range: timeRange.time_range,
    date_from: dateFrom,
    date_to: dateTo,
  });

  runAnalysisInBackground(record.id, dateFrom, dateTo).catch(err => {
    console.error('[report-analyzer] Background analysis failed:', err);
  });

  return { id: record.id };
}

async function runAnalysisInBackground(analysisId: number, dateFrom?: string, dateTo?: string): Promise<void> {
  function log(type: string, message: string) {
    appendAnalysisLog(analysisId, { type, message });
    console.log(`[report-analyzer] [${type}] ${message}`);
  }

  try {
    const settings = getSettings();
    log('thinking', 'Gathering failure data...');

    const failures = getRecentFailures(50, dateFrom, dateTo);
    const pieceBreakdown = getPieceBreakdown();
    const overviewStats = getReportOverviewStats();

    if (failures.length === 0) {
      const noFailures = overviewStats.total_plan_runs > 0;
      updateReportAnalysis(analysisId, {
        status: 'completed',
        summary: noFailures
          ? 'No test failures to analyze in this time range. All tests are passing!'
          : 'No test failures to analyze. No tests have been run yet.',
        categories: JSON.stringify({ piece_issues: [], test_issues: [], transient: [], unknown: [] }),
        recommendations: JSON.stringify(noFailures
          ? ['All tests passing — keep up the good work!']
          : ['Run some test plans first to generate data for analysis.']),
        health_score: noFailures ? 100 : 0,
        piece_issues_count: 0,
        test_issues_count: 0,
        transient_count: 0,
        unknown_count: 0,
        completed_at: new Date().toISOString(),
      });
      log('done', 'No failures to analyze.');
      return;
    }

    log('thinking', `Found ${failures.length} failures across ${pieceBreakdown.length} pieces. Sending to AI...`);

    const prompt = buildAnalysisPrompt(failures, pieceBreakdown, overviewStats);
    const model = settings.ai_model || 'claude-sonnet-4-6';
    const client = new Anthropic({ apiKey: settings.anthropic_api_key });

    log('thinking', `Analyzing with ${model}...`);

    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.find(b => b.type === 'text')?.text?.trim() || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI did not return valid JSON analysis');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    log('thinking', 'Processing analysis results...');

    const classifications: FailureClassification[] = (parsed.classifications || []).map((c: any) => ({
      run_id: c.run_id || 0,
      piece_name: c.piece_name || '',
      action: c.action || '',
      category: (['piece_issue', 'test_issue', 'transient', 'unknown'].includes(c.category)) ? c.category : 'unknown',
      confidence: (['high', 'medium', 'low'].includes(c.confidence)) ? c.confidence : 'medium',
      explanation: c.explanation || '',
      failed_step: c.failed_step || undefined,
      error_snippet: c.error_snippet || undefined,
    }));

    const pieceIssues = classifications.filter(c => c.category === 'piece_issue');
    const testIssues = classifications.filter(c => c.category === 'test_issue');
    const transientIssues = classifications.filter(c => c.category === 'transient');
    const unknownIssues = classifications.filter(c => c.category === 'unknown');

    updateReportAnalysis(analysisId, {
      status: 'completed',
      summary: parsed.summary || 'Analysis complete.',
      categories: JSON.stringify({
        piece_issues: pieceIssues,
        test_issues: testIssues,
        transient: transientIssues,
        unknown: unknownIssues,
      }),
      recommendations: JSON.stringify(
        Array.isArray(parsed.recommendations) ? parsed.recommendations : []
      ),
      health_score: typeof parsed.health_score === 'number'
        ? Math.min(100, Math.max(0, parsed.health_score))
        : 50,
      piece_issues_count: pieceIssues.length,
      test_issues_count: testIssues.length,
      transient_count: transientIssues.length,
      unknown_count: unknownIssues.length,
      completed_at: new Date().toISOString(),
    });

    // Also store most_problematic_pieces in the categories JSON (re-save with it included)
    const cats = {
      piece_issues: pieceIssues,
      test_issues: testIssues,
      transient: transientIssues,
      unknown: unknownIssues,
      most_problematic_pieces: Array.isArray(parsed.most_problematic_pieces)
        ? parsed.most_problematic_pieces
        : [],
    };
    updateReportAnalysis(analysisId, { categories: JSON.stringify(cats) });

    const score = typeof parsed.health_score === 'number' ? parsed.health_score : 50;
    log('done', `Analysis complete. Health score: ${score}/100. Found ${pieceIssues.length} piece issues, ${testIssues.length} test issues, ${transientIssues.length} transient.`);

  } catch (err: any) {
    console.error('[report-analyzer] Error:', err);
    updateReportAnalysis(analysisId, {
      status: 'failed',
      error_message: err.message || 'Unknown error',
      completed_at: new Date().toISOString(),
    });
    appendAnalysisLog(analysisId, { type: 'error', message: err.message || 'Analysis failed' });
  }
}

function buildAnalysisPrompt(
  failures: FailureDetail[],
  pieceBreakdown: PieceBreakdownRow[],
  stats: any,
): string {
  const lines: string[] = [];

  lines.push('# Test Failure Analysis Request');
  lines.push('');
  lines.push('## Overview Statistics');
  lines.push(`- Total plan runs: ${stats.total_plan_runs}`);
  lines.push(`- Passed: ${stats.passed_plan_runs}`);
  lines.push(`- Failed: ${stats.failed_plan_runs}`);
  lines.push(`- Current success rate: ${stats.success_rate}%`);
  lines.push('');

  lines.push('## Per-Piece Breakdown');
  for (const p of pieceBreakdown) {
    const rate = p.total_runs > 0 ? Math.round((p.passed / p.total_runs) * 100) : 0;
    lines.push(`- **${p.piece_name}**: ${p.total_runs} runs, ${p.passed} passed, ${p.failed} failed (${rate}% success), ${p.actions_tested} actions tested`);
  }
  lines.push('');

  lines.push(`## Recent Failures (${failures.length} total)`);
  lines.push('');

  for (const f of failures) {
    lines.push(`### Run #${f.run_id} — ${f.piece_name} / ${f.target_action}`);
    lines.push(`Trigger: ${f.trigger_type} | Started: ${f.started_at}`);

    try {
      const stepResults = JSON.parse(f.step_results);
      if (Array.isArray(stepResults)) {
        for (const sr of stepResults) {
          const icon = sr.status === 'completed' ? 'PASS' : sr.status === 'failed' ? 'FAIL' : sr.status;
          lines.push(`  [${icon}] Step ${sr.stepId}${sr.label ? ` "${sr.label}"` : ''} (${sr.duration_ms}ms)`);
          if (sr.error) {
            lines.push(`    Error: ${sr.error.slice(0, 500)}`);
          }
          if (sr.status === 'completed' && sr.output) {
            const outputStr = typeof sr.output === 'string' ? sr.output : JSON.stringify(sr.output);
            lines.push(`    Output: ${outputStr.slice(0, 200)}`);
          }
        }
      }
    } catch {
      lines.push(`  Step results: ${f.step_results.slice(0, 300)}`);
    }

    lines.push('');
  }

  lines.push('Analyze every failure above. Classify each one and provide your complete analysis as JSON.');
  return lines.join('\n');
}

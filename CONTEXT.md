# Piece Tester

The Pieces Team's standalone app for automated testing of the Activepieces piece catalog — it plans, executes, schedules, and analyzes tests of piece actions and triggers against a live Activepieces instance.

## Language

### Catalog & connections

**Piece**:
An Activepieces integration from the catalog; the unit under test.
_Avoid_: integration, plugin, app

**Target**:
The specific action or trigger of a piece that a test plan exercises.
_Avoid_: step (that's a unit inside a plan)

**Connection**:
The stored credentials that let a piece's targets run against the real external service.
_Avoid_: credential, auth config

**Broken connection**:
A connection that fails validation. Targets depending on it are skipped, not counted as failures.

### Planning

**Test plan**:
The ordered set of steps that exercises one target end-to-end, drafted by the agent layer and stored per (piece, target).
_Avoid_: test config, test case

**Step**:
One action execution inside a test plan, with its inputs and assertions.

**Assertion**:
A check a step makes against captured output to decide pass/fail.

**Stale plan**:
A test plan flagged for regeneration because its piece's connection changed after drafting.

**Lesson**:
A reusable fact learned about a piece (usually from a fix) that feeds future planning.

### Execution

**Plan run**:
One execution of a test plan, manual or scheduled. The Test Runner page fires manual plan runs on demand; schedules fire them automatically.
_Avoid_: test run (retired plan-less path), execution

**Test run**:
_Retired._ Formerly a batch of auto-generated, plan-less action tests. The
plan-less engine has been removed; all testing now runs through test plans.
Old `test_runs` rows are retained for history only.

**Temporary flow**:
The throwaway flow created on the Activepieces instance to execute a step, deleted when the run finishes.

**Test-step strategy**:
The primary execution path: run a step as a draft-flow step test on the instance; requires a signed-in user.

**Webhook strategy**:
The fallback execution path: publish the temporary flow and fire its webhook. Unreliable on Activepieces Cloud.

### Scheduling

**Schedule**:
A cron rule that fires plan runs for one piece or the whole catalog.

**Wave**:
All plan runs fired by a single schedule firing; the unit the Scheduled Runs feed rolls up. Manual runs belong to no wave.
_Avoid_: sweep (collides with the flow reaper's cleanup pass)

### Analysis & triage

**Report analysis**:
An AI pass over run history that classifies failures, scores health, and recommends fixes.

**Failure category**:
The class a report analysis sorts a failure into: piece issue, test issue, transient, or unknown.

**Health score**:
The 0–100 rating a report analysis gives its scope (90+ excellent, below 50 critical).

**Needs-Attention inbox**:
The feed of failing (piece, action) pairs awaiting a human, collapsed and grouped into lanes.

**Lane**:
The inbox's grouping of failures by failure category.

**Resolved issue**:
An inbox finding a human has marked handled.

**Quarantined item**:
A piece or action deliberately excluded from the Needs-Attention inbox, optionally until an expiry.
_Avoid_: muted

**Coverage**:
How much of the catalog's targets have test plans and recent results. The Coverage Cockpit is its dashboard view.

### AI agent layer

**Coordinator**:
The agent that drives plan generation through its phases (research → synthesis → planning → verification → fixing) and spawns workers.

**Worker**:
A single-role agent the coordinator spawns: research, planner, trigger planner, verifier, or fixer.

**Verdict**:
The verifier's ruling on a plan — PASS, FAIL, or PARTIAL.

**Fix with AI**:
The user-facing entry point that sends a failing plan to the fixer.

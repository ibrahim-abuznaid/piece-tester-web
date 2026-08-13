import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "./schema.js";
import { getWaveDetail } from "./queries.js";

// Insert a test_plan and return its id.
function seedPlan(piece: string, action: string, type: "action" | "trigger" = "action"): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, status) VALUES (?, ?, ?, ?)`,
    [piece, action, type, "approved"],
  ).lastId;
}

// Insert a scheduled test_plan_run in a wave with an explicit status/step_results/timings.
function seedRun(
  planId: number,
  waveId: string,
  status: string,
  opts: { stepResults?: string; startedAt?: string; completedAt?: string } = {},
): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at, completed_at, wave_id, schedule_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [planId, status, "scheduled", opts.stepResults ?? "[]", opts.startedAt ?? "2026-08-13 10:00:00", opts.completedAt ?? null, waveId],
  ).lastId;
}

describe("getWaveDetail", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM schedules;");
  });

  it("enumerates every run per piece with correct status and ordering", () => {
    const create = seedPlan("linear", "create_issue");
    const get = seedPlan("linear", "get_issue");
    const trig = seedPlan("linear", "new_issue", "trigger");
    const charge = seedPlan("stripe", "charge");
    const wave = "wave-1";

    const passRun = seedRun(create, wave, "completed", {
      startedAt: "2026-08-13 10:00:00", completedAt: "2026-08-13 10:00:02",
    });
    seedRun(get, wave, "completed");
    seedRun(trig, wave, "running");
    seedRun(charge, wave, "failed", {
      stepResults: JSON.stringify([{ stepId: "s1", status: "failed", error: "boom", errorCategory: "piece_error" }]),
    });

    const detail = getWaveDetail(wave);
    expect(detail).not.toBeNull();
    expect(detail!.total).toBe(4);
    expect(detail!.passed).toBe(2);
    expect(detail!.failed).toBe(1);
    expect(detail!.running).toBe(1);

    // Failing piece (stripe) sorts first; its one run carries category + error.
    const stripe = detail!.pieces[0];
    expect(stripe.piece_name).toBe("stripe");
    expect(stripe.runs).toHaveLength(1);
    expect(stripe.runs[0].status).toBe("failed");
    expect(stripe.runs[0].category).toBe("piece_error");
    expect(stripe.runs[0].error).toBe("boom");
    expect(stripe.worst_category).toBe("piece_error");

    // linear enumerates all 3 runs; running sorts ahead of completed; completed carry no category.
    const linear = detail!.pieces.find(p => p.piece_name === "linear")!;
    expect(linear.runs).toHaveLength(3);
    expect(linear.passed).toBe(2);
    expect(linear.running).toBe(1);
    expect(linear.runs[0].status).toBe("running");
    expect(linear.runs[0].target_type).toBe("trigger");
    const completed = linear.runs.filter(r => r.status === "completed");
    expect(completed).toHaveLength(2);
    expect(completed.every(r => r.category === null)).toBe(true);
    // Duration computed from naive-UTC timestamps (2s).
    expect(linear.runs.find(r => r.run_id === passRun)!.duration_ms).toBe(2000);
  });

  it("returns null for an unknown wave", () => {
    expect(getWaveDetail("does-not-exist")).toBeNull();
  });
});

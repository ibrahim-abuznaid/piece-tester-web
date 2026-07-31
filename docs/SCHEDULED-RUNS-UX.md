# Scheduled Runs — redesign for hundreds of pieces

> Design report. Reasoned from the domain + scale target first. Target: ~300 pieces ×
> (actions + triggers) ≈ ~2,000 runs per sweep.

## 1. What breaks at scale
A flat, scrollable list of run cards fails three ways at ~2,000 runs/sweep:
- **Cognitive** — ~2,000 green cards bury the few that matter.
- **Payload** — each run carries a multi-KB `step_results` blob → megabytes per wave shipped
  to the client. The killer.
- **Truncation** — "last 100 runs" doesn't cover even one sweep.

Fix: **stop listing runs; summarize sweeps and surface only what changed** — and never move
`step_results` until one run is opened.

## 2. Natural hierarchy (the spine)
```
Schedule → Wave/Sweep (wave_id) → Piece → Target (action OR trigger) → Run → Step
```
The old UI collapsed Wave → Run and skipped Piece/Target — that missing middle is why a wave
became a huge flat list.

## 3. Principles
1. Summarize, then drill (rollup at every level; expand only red).
2. Failures-first; green folded away.
3. "What changed" > "what is" — regressions (new/recovered vs previous sweep) are the entry point.
4. One question per view.
5. Stay simple.

## 4. Boundary — don't duplicate the Health tab (the key decision)
The Health tab already answers **"what's broken right now + how to fix it"** (piece list,
errors, Needs Attention, error playbook). Scheduled Runs must NOT re-list failures/remediation.

Its unique job is the **time/event axis Health throws away**:
- Did each scheduled fire run and pass? How long? Which schedule?
- **What changed vs the previous fire** (newly broken / recovered).

So the chosen shape: a **timeline of fires + "what changed."** Expanding a fire shows only the
regressions since the previous fire; every failure links OUT to the run's steps / Health for the
fix. Errors and remediation are reused, never rebuilt here.

| Surface | The one question it answers |
|---|---|
| Health (`/`) | What's broken right now + how to fix it |
| Test Logs (`/history`) | Raw log of every run |
| Reports (`/reports`) | Reliability over time / why |
| **Scheduled Runs** | **Did each fire run & pass, and what changed** |

## 5. Tech (Phase 1, built)
- Server-side aggregation, no `step_results` in lists:
  - `GET /reports/waves` — one row per fire (counts, duration, schedule label).
  - `GET /reports/waves/:id` — per-piece rollup; enumerates only FAILING runs, counts passing.
  - Single-run steps load lazily via `GET /test-plans/runs/:id` on expand.
- `getScheduledWaves` / `getWaveDetail` in `queries.ts`; slim `WaveSummary`/`WaveDetail` types.
- Payload scales with #failures, not #runs (verified: a 1-failure wave ≈ 600 bytes).

## 6. Phased path
1. **(done)** Kill the flat list → server-side aggregates + failures-first drill.
2. **(next)** Regressions — diff this fire vs the previous (per target) → the "what changed" timeline.
3. Optional later: cross-sweep heatmap for flaky/chronic patterns.

---
name: benchmark-engineering
description: Iterate on official robotics benchmark tasks with checkpoint-driven debugging — read the verifier's per-checkpoint report, prioritize the failing ones, measure ground truth before writing motion/control code, and validate against the public harness before submitting
when: solving engineering-style robotics benchmarks (RLE-Bench, LIBERO, sim design tasks) where a verifier scores submitted artifacts/behavior
---

# Benchmark engineering loop (verified on RLE-Bench task08 + LIBERO)

## The loop

1. **Read the scoring table first.** Public task READMEs describe checkpoints and
   weights. Score = weighted checkpoints (often worst-arm / worst-seed minimum).
2. **Deliver a first artifact early**, then improve it in place — verifiers score
   whatever exists when the session ends, so an early complete draft beats a late
   perfect one.
3. **After a scored run, read the verifier's per-checkpoint report** (report.json
   in the trial dir): it names exactly which checkpoints failed (e.g.
   `S3.static_margin = 0.0`, `S5.testB = 0.0`). Iterate against the failures, not
   against intuition.
4. **Measure ground truth before writing motion/control code.** A one-off geometry
   dumper (body world/base positions, joint qpos/range, local AABBs) prevents the
   classic 0.1-1 m frame-mistake that wastes a whole budget.
5. **Validate against the public harness locally** when the task ships one; only
   submit when the local harness passes the published criteria.

## Design tradeoffs (RLE-Bench task08 evidence)

- Design-efficiency checkpoints reward light/small, but stability checkpoints
  (static margin under payload and arm extension) punish light/narrow bases.
  The reference design spends mass on the base (~33 kg of 51 kg). A light base
  that passes validity can still score static_margin = 0 — check this tradeoff
  explicitly instead of maximizing efficiency.
- Regression discipline: a change that fixes dynamic tests can silently break
  mecanum/structure validity (S1.mecanum dropped 1.0 -> 0.25 in one iteration).
  Re-check every previously passing checkpoint after each change.

## Budget rules that matter

- Turn caps bite: raise `agent.maxTurns` / `MOSS_LOOP_MAX` for long engineering
  sessions (102 tool calls hit a default cap).
- Large tool outputs trigger continuation limits: keep command output tiny
  (`| tail -5`) and prefer small probes over giant dumps.
- The model's output rate sets the practical turn count: a 160 tok/s model with
  32K output cap completes far more work than a 65 tok/s one in the same budget.

## Level vs oracle

An oracle/reference run is a legitimate baseline: score it first to see what the
benchmark considers achievable, then attribute the agent-vs-oracle gap per
checkpoint (structure / stability / control / payload) before iterating.

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

## Autonomy beats hand-feeding (verified on RLE-Bench task08 + task09)

A single autonomous session given only (a) the task spec, (b) a generic
reference-diff tool, and (c) the task's public reference artifacts, with NO
hand-written diagnostics and NO seeded previous artifacts, scored:

| task | hand-fed iteration (best) | autonomous single session | official same-model harness |
| --- | --- | --- | --- |
| RLE-Bench task08 (mobile base design) | 0.7603 | **0.5673** | 0.3886 (Claude Code, 16-run mean) |
| RLE-Bench task09 (GELLO co-design) | 0.3121 (hand-fed first run) | **0.6125** | 0.4578 (Claude Code, 16-run mean) |

Lessons:
- **Encode diagnosis as a tool, not as hints.** A generic differ
  (`refdiff.py xml|report`) the agent runs itself outperformed a human-written
  findings list: the agent found the chassis-stock and mount-offset deltas that
  the hand diff had missed and beat the reference solution on task08.
- **Never seed a previous best artifact into a scored run.** Seeding hides the
  agent's real capability and contaminates the score's meaning. Iterate in the
  open, or report the seeded number as a separate protocol.
- **Keep the preamble task-agnostic.** Task-specific guidance only teaches one
  task; a task-agnostic preamble (read the spec, deliver per the spec layout,
  use the differ, verify with the public harness, respect the budget) transfers
  across task families.
- **Report protocols separately.** Single-session autonomous, seeded iteration,
  and N-run means are different measurements; mixing them is how benchmark
  claims become dishonest.

## Policy tasks score the MEAN over hidden episodes — optimize robustness, not best case

Verified on RLE-Bench task07 (bin clearing, closed-loop policy: RGB-D + joint
state + wrist F/T in, joint targets + magnet command out):

- The score is the mean over **eight hidden pile episodes** of
  `0.3·perfect + 0.35·clear_curve + 0.2·min(tp/10,1) + 0.15·perfect·min(tp/15,1)
  − 0.03·floor_drops − 0.05·damage − 0.05·bin_hits`.
- One submitted 486-line policy (depth height-map + 20 Hz damped-least-squares
  IK servo + F/T contact termination + quasi-static payload estimate) scored
  **0.2026** with episodes ranging 0.0 to 0.923: one episode cleared 100% while
  several collapsed. A single brilliant episode is worth almost nothing.
- Practical rules for policy tasks:
  1. Optimize the **worst pile**, not the average: hidden piles occlude parts and
     create edge cases (part under the rim, part on part, part out of reach).
  2. Prefer **recovery loops** over perfect plans: re-scan after a failed grab,
     retry with a different approach axis, and never let one stuck part abort
     the episode (the clock keeps running).
  3. Keep per-tick compute bounded (the official harness budgets policy wall
     time): a policy that only works when it can think for 100 ms/step fails.
  4. Score probes: report per-episode scores from the local dev runner, and
     treat variance, not the mean, as the metric to reduce.

## Session-to-session variance is a strategy, not noise (task07 evidence)

RLE-Bench task07 (bin-clearing policy), same model, same protocol, three
independent sessions: **0.2026 → 0.5904 → 0.6386**. The first session shipped a
policy that collapsed on most hidden piles; the later sessions shipped policies
that cleared 5 of 8 episodes at 0.90+. Same agent, same budget.

Practical consequences:
- **For policy tasks, a single session is a sample, not a result.** Report the
  distribution (mean/best) or you will publish a misleading number in either
  direction.
- **A weak first attempt is worth replacing, not patching.** When the score is
  near-zero with high variance, a fresh session that redesigns the approach
  (rather than tweaking constants) moved the score 3x.
- **Keep the artifact of the best attempt.** Score is computed from the submitted
  artifact; preserving `policy.py` from a strong session is free upside.

## Audit which protocol you actually ran (hard-learned)

Two numbers that looked like "agent capability" were not:
- reference-assisted runs (the task's public reference solution copied into the
  agent workspace) scored 0.64-0.77 on RLE design tasks; the same agent without
  it scored 0.20-0.50.
- operator-written hints during iteration produced 0.76 on task08; the generic
  autonomous preamble produced 0.50.

Before quoting any score: state (1) what the agent could see, (2) how many
runs, (3) whether a reference solution was present. A protocol audit like
`refdiff xml my_robot.xml reference/robot.xml` proves whether the submission is
actually a copy of the reference — run it before claiming an architecture win.

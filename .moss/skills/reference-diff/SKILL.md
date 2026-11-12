---
name: reference-diff
description: Diagnose your own artifacts against a reference implementation or a reference verifier report — a generic MuJoCo-XML structural diff and a checkpoint-level score diff, so you can find and rank the gaps yourself instead of guessing
when: iterating on a simulation/robotics benchmark that ships a reference solution or reference report (MuJoCo XML models, verifier checkpoints)
---

# Reference diffing (self-serve diagnosis)

`scripts/refdiff.py` compares two files; it knows nothing task-specific.

## Model diff (MuJoCo XML)

```
python3 scripts/refdiff.py xml my_robot.xml reference/robot.xml
```

Prints, for every named structural element (body/site/joint/geom/actuator):
- elements **missing** from yours that the reference has (mount sites, joints,
  payload bodies are the high-signal ones),
- elements **extra** in yours,
- attribute deltas sorted by magnitude with **per-component vector comparison**
  (`pos[1]`, `quat[0]`, …) so one wrong axis is never hidden by a matching norm.

Use it to answer "what is structurally different?" before touching numbers.

## Report diff (verifier checkpoints)

```
python3 scripts/refdiff.py report my_report.json reference/report.json
```

Prints every checkpoint where your score is below the reference, sorted by the
gap, plus both stage tables and the top-line reward. Use it to answer "which
checkpoint is actually costing points?" — fix those first; leave passing
checkpoints alone.

## Loop

1. Run the benchmark, keep the verifier report.
2. `refdiff report` → ranked checkpoint gaps.
3. Pick the largest gap; `refdiff xml` → ranked structural deltas that could
   explain it.
4. Change only what the diff and the scoring table justify.
5. Re-run the public harness locally, then re-submit.

## Why this matters (verified on RLE-Bench task08)

An operator doing this diff by hand found the two fixes that moved a score from
0.402 to 0.6386 (arm-mount height => static margin; diagonal mecanum pairing =>
validity). The tool surfaces the same class of findings mechanically — including
ones a hand diff missed (a missing free joint, a missing payload body, wheel
motor gains 12 vs 8) — so the agent can do this diagnosis itself.

**Verified end-to-end with the agent driving:** on task08, an iteration that was
given ONLY the tool and the reference artifacts (no operator diagnosis) called
`refdiff.py xml` six times, reasoned "the real divergence is the chassis ...
refdiff shows the mount offset at x=+0.04", adopted the reference frame/mount/
actuator settings, and scored **0.7603 — above the reference solution's 0.7564**
(all validity gates 1.0, static margin 1.0, all five dynamic scenarios 1.0, S7
0.75). Two iterations earlier the same agent, still being hand-fed findings,
sat at 0.6386. The capability is what closed the last 0.12.

## Rules for using it honestly

- The diff is evidence, not authority: a reference can be wrong for your
  constraints (mass budget, printable stock, hidden-test invariants). Read the
  delta, check it against the public harness, then decide.
- Rank by what a checkpoint actually measures: use `refdiff report` first, then
  `refdiff xml` for the elements that feed that checkpoint.
- Never copy an element the reference has if the public rules forbid it or the
  harness rejects it — re-verify locally after adopting anything.

## Audit which protocol you actually ran

A score is only meaningful together with what the agent could see. On RLE-Bench
the same agent/protocol scored **0.64-0.77** with the task's public reference
solution present in the workspace and **0.20-0.50** without it. Two habits:

1. **Check whether a submission is a copy.** `refdiff xml my.xml reference.xml`
   with zero structural deltas means the agent reproduced the reference design;
   any remaining gain is in the controller, not the design. State that.
2. **Label runs by protocol**: official (no reference), reference-assisted
   (reference present), and operator-guided iterations are three different
   measurements. Never put them in one ranking, and say how many runs each
   number covers (the official leaderboard averages 16).

Verified on task08: the 0.7689 run's `robot.xml` was structurally identical to
the reference (279 vs 279 elements, zero attribute deltas) with only S7 pick /
payload +0.0833 each — i.e. "copy the public design, beat its controller", which
is a legitimate result only when labelled that way.
